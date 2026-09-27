// M6, the Overseer's side of linked sessions (§app.overseer/links-tools, /caps, /sent-marker): the
// Overseer on host a, driven through its own /ws/chat as the page drives it (so its turns are the
// user's), creates a session on peer b with sova_create_session {host: "b", model, thinking, mode}
// and a first prompt. On b's disk that session carries the model, thinking level and mode, and its
// first prompt carries no Overseer sent-marker. Then, with concurrentSessions 1, a session the
// Overseer started on b that is still running (past its 15 s starting grace) holds the one slot:
// a second create with a prompt is refused, and nothing is created on b.
//   LAB_STATE=… scripts/mesh-lab/lab e2e m6-links-overseer   (spends a few short glm-5.3 turns)
// Takes the lab LOCK; restores a's Overseer settings afterwards. Leaves a,b,c paired.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { hostUrl, lab, readAgentFile, requireLab, sh, waitFor } from "./lib.mjs";
import { api, byId, MODEL, releaseLock, takeLock, waitIdle } from "./links-lib.mjs";

const A = "a";
const B = "b";
const ACTIONS = "sova/overseer-actions.jsonl";
let saved = null;
let locked = false;

/** The Overseer's action log on a, as records. */
const actions = () =>
  (readAgentFile(A, ACTIONS) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** A session file on `node` as entries. */
function entries(node, path) {
  const r = sh(node, `cat '${path.replace(/'/g, "'\\''")}'`);
  assert.equal(r.code, 0, `${node}: ${path} not readable: ${r.err}`);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const onDisk = (node, id) => sh(node, `find "$PI_CODING_AGENT_DIR/sessions" -name "*${id}.jsonl" | grep -q .`).code === 0;
const userTexts = (es) =>
  es
    .filter((e) => e.type === "message" && e.message?.role === "user")
    .map((e) => (typeof e.message.content === "string" ? e.message.content : e.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")));

/**
 * One user message to the Overseer through a's /ws/chat, as the page sends it. Resolves when the
 * run settles, with every tool call it made: [{ name, args, isError, text, details }].
 */
function overseerTurn(path, text, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${hostUrl(A).replace(/^http/, "ws")}/ws/chat?path=${encodeURIComponent(path)}`);
    const calls = new Map();
    let reply = "";
    let sent = false;
    const timer = setTimeout(() => finish(new Error(`Overseer turn timed out; tools so far: ${JSON.stringify([...calls.values()])}`)), timeoutMs);
    function finish(err) {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (err) reject(err);
      else resolve({ tools: [...calls.values()], reply });
    }
    ws.onerror = () => {};
    ws.onclose = (e) => sent || finish(new Error(`Overseer chat closed before the prompt: ${e.code} ${e.reason}`));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "hello" && !sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "prompt", text, clientId: `m6o-${Date.now()}` }));
      } else if (m.type === "error") finish(new Error(`Overseer chat error: ${m.message ?? JSON.stringify(m)}`));
      else if (m.type === "event") {
        const ev = m.event ?? {};
        if (ev.type === "tool_execution_start") calls.set(ev.toolCallId, { name: ev.toolName, args: ev.args });
        else if (ev.type === "tool_execution_end") {
          const c = calls.get(ev.toolCallId) ?? { name: ev.toolName };
          const content = ev.result?.content ?? [];
          calls.set(ev.toolCallId, { ...c, isError: !!ev.isError, text: content.map((x) => x.text ?? "").join("\n"), details: ev.result?.details });
        } else if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") reply += ev.assistantMessageEvent.delta ?? "";
        else if (ev.type === "agent_settled") setTimeout(() => finish(), 300);
      }
    };
  });
}

/** The create calls a turn made, each with its action-log outcome (the log is the source of truth). */
function creates(turn, since) {
  const logged = actions().slice(since).filter((x) => x.tool === "sova_create_session");
  return { calls: turn.tools.filter((t) => t.name === "sova_create_session"), logged };
}

let overseerPath;

before(async () => {
  requireLab();
  await takeLock("overseer");
  locked = true;
  const peerUp = async () => (await api(A, "/api/mesh")).json?.peers?.find((p) => p.id === B)?.state === "up";
  if (!(await peerUp())) lab("pair", "a,b,c");
  await waitFor(peerUp, { timeoutMs: 60000, what: `${A} sees ${B} up` });
  const info = await api(A, "/api/settings/overseer");
  assert.equal(info.status, 200, info.text);
  saved = info.json.settings;
  const put = await api(A, "/api/settings/overseer", {
    method: "PUT",
    body: { ...saved, model: MODEL, thinking: "low", proactivity: "off", caps: { ...saved.caps, concurrentSessions: 1, createPerTurn: 5, promptsPerTurn: 10 } },
  });
  assert.equal(put.status, 200, put.text);
  // A fresh conversation: nothing from an earlier run steers this one.
  assert.equal((await api(A, "/api/overseer/clear", { method: "POST" })).status, 200);
  overseerPath = (await api(A, "/api/overseer")).json.path;
  assert.ok(overseerPath, "the Overseer's path");
});

after(async () => {
  try {
    if (saved) {
      const r = await api(A, "/api/settings/overseer", { method: "PUT", body: saved });
      if (r.status !== 200) console.error(`restoring a's Overseer settings failed: ${r.status} ${r.text}`);
    }
  } finally {
    if (locked) releaseLock();
  }
});

describe("the Overseer creates a session on a peer", () => {
  let made;

  test("sova_create_session with host b: the session is on b with the model, thinking and mode, and its first prompt is unmarked", async () => {
    const since = actions().length;
    const firstPrompt = "Reply with exactly the word: m6-ok";
    const turn = await overseerTurn(
      overseerPath,
      "Call sova_create_session exactly once, with exactly these arguments and nothing else: " +
        `host "b", cwd "/root/work", model "${MODEL}", thinking "low", mode "delegate", title "m6 overseer create", prompt "${firstPrompt}". ` +
        "Call no other tool. Then say done in one word.",
    );
    const { calls, logged } = creates(turn, since);
    assert.equal(calls.length, 1, `glm made ${calls.length} create calls: ${JSON.stringify(turn.tools)}`);
    assert.equal(calls[0].args?.host, "b", JSON.stringify(calls[0].args));
    assert.equal(calls[0].isError, false, calls[0].text);
    assert.deepEqual(logged.map((x) => x.outcome), ["ok"], JSON.stringify(logged));
    made = calls[0].details;
    assert.equal(made?.host, "b", JSON.stringify(made));
    assert.match(calls[0].text, /on [^\n]* \(b\), in /, calls[0].text);

    assert.equal(onDisk(B, made.id), true, "the session file is on b");
    assert.equal(onDisk(A, made.id), false, "and not on a");
    await waitIdle(B, made.id);
    const es = entries(B, made.path);
    const models = es.filter((e) => e.type === "model_change");
    assert.equal(`${models.at(-1)?.provider}/${models.at(-1)?.modelId}`, MODEL, JSON.stringify(models));
    assert.equal(es.filter((e) => e.type === "thinking_level_change").at(-1)?.thinkingLevel, "low");
    const mode = es.filter((e) => e.type === "custom" && e.customType === "mode").at(-1);
    assert.equal(mode?.data?.active?.mode, "delegate", JSON.stringify(mode));
    // The mode was set before the first prompt, so the first turn already ran in it.
    const firstUser = es.findIndex((e) => e.type === "message" && e.message?.role === "user");
    assert.ok(es.indexOf(mode) < firstUser, "the mode entry precedes the first prompt");
    assert.deepEqual(userTexts(es), [firstPrompt], "the first prompt, verbatim");
    assert.equal(es.filter((e) => e.type === "custom" && e.customType === "sova-overseer-sent").length, 0, "no Overseer sent-marker across hosts");
    const s = await byId(B, made.id);
    assert.equal(s?.title, "m6 overseer create");
    assert.equal(s?.model, MODEL);
  });
});

describe("the running cap counts a session the Overseer started on a peer", () => {
  test("with concurrentSessions 1, a second create with a prompt is refused while the first runs on b, past its grace", async () => {
    // The previous test's session holds the slot for 15 s after its prompt, even idle (the
    // starting grace, as for a local one): start past it.
    await new Promise((r) => setTimeout(r, 20000));
    const since = actions().length;
    const turn = await overseerTurn(
      overseerPath,
      'Call sova_create_session exactly once: host "b", cwd "/root/work", title "m6 overseer busy", ' +
        'prompt "Use the bash tool to run exactly this command: sleep 75. Then reply done." Call no other tool. Then say done in one word.',
    );
    const { calls } = creates(turn, since);
    assert.equal(calls.length, 1, `glm made ${calls.length} create calls: ${JSON.stringify(turn.tools)}`);
    assert.equal(calls[0].isError, false, calls[0].text);
    const busy = calls[0].details;
    const promptedAt = Date.now();
    await waitFor(async () => (await byId(B, busy.id))?.busy === true, { timeoutMs: 60000, what: "b's session running" });
    // Past the 15 s starting grace, so only b's own report of it running can hold the slot.
    await new Promise((r) => setTimeout(r, Math.max(0, promptedAt + 20000 - Date.now())));
    assert.equal((await byId(B, busy.id))?.busy, true, "still running on b");

    const before2 = actions().length;
    const second = await overseerTurn(
      overseerPath,
      'Call sova_create_session exactly once: host "b", cwd "/root/work", title "m6 overseer second", prompt "Reply ok". ' +
        "If it is refused, do not retry and call no other tool; quote the refusal.",
    );
    const { calls: calls2, logged } = creates(second, before2);
    assert.ok(calls2.length >= 1, `glm made no create call: ${JSON.stringify(second.tools)}`);
    assert.equal(logged[0]?.outcome, "refused", JSON.stringify(logged));
    assert.match(logged[0].error, /Limit reached: 1 session you started is running or starting, and the limit is 1 at once/);
    const listed = (await api(B, "/api/sessions")).json ?? [];
    assert.ok(!listed.some((s) => s.title === "m6 overseer second"), "nothing was created on b");
    assert.equal((await byId(B, busy.id))?.busy, true, "the first was still running when refused");
    await waitIdle(B, busy.id, { timeoutMs: 180000 });
  });
});
