// Run: pnpm test -- server/harness/pi/state-golden.test.ts
//
// The state goldens (§app/harness, milestone 4): every session write Sova makes outside pi-config, driven
// through today's real code paths, and the file each scenario leaves compared byte for byte (after
// canonical-jsonl.ts takes out ids, times and temp paths) with golden/state/<scenario>.jsonl. A diff is a
// change to what lands on disk (durable user data): re-record only an intended one, and review it as a
// format change. Record missing fixtures with SOVA_GOLDEN_RECORD=1 (same command); it never overwrites one
// that exists unless SOVA_GOLDEN_RECORD=overwrite.
//
// One process, one throwaway PI_CODING_AGENT_DIR, the server imported (PORT=0) so routes, the Overseer and
// the baton's statechart are wired as in production. The model is a ScriptedModel; models.json registers it
// as a real authenticated model, so each session opens on it and pi records it (the deferred open-time
// model/thinking entries are part of what the goldens pin). ~/.pi is never read or written.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../../../shared/protocol";
import { Canonicalizer, firstDifference } from "./testing/canonical-jsonl";
import { ScriptedModel, scriptedModelsJson } from "./testing/scripted-model";
import { piSession } from "./testing/handle";
import { assertPinnedPi } from "./testing/load-pi";

assertPinnedPi();

// Only the scripted model may answer: no provider key from the environment makes a real one available.
for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const REPO = resolve(import.meta.dirname, "../../..");
const GOLDEN = join(import.meta.dirname, "golden/state");
const RECORD = process.env.SOVA_GOLDEN_RECORD;

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-state-golden-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
const sessionsDir = join(agentDir, "sessions", "--golden--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
// This repo's mode extension by its real path (the pick and mode writers need its /mode command), and a
// fixture extension whose tool opens a select dialog (G9).
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "golden-dialog.ts"),
  `export default function (pi) {
  pi.registerTool({ name: "golden_ask", label: "golden_ask", description: "Ask the user to pick", parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: async (_id, _params, _signal, _u, ctx) => {
      const v = await ctx.ui.select("Pick a colour", ["Red", "Blue"]);
      return { content: [{ type: "text", text: "picked " + String(v) }], details: {} };
    } });
}
`,
);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { baseDelayMs: 1 }, extensions: [join(REPO, "pi-config/extensions/mode")] }),
);

const { app, server } = await import("../../index");
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("../../chat-manager");
const { canonicalPath } = await import("../../paths");
const { markOwned } = await import("../../write-guard");
const { addWebSession } = await import("../../web-sessions");
const { PROFILE_ENTRY, parseProfile } = await import("../../../shared/profiles");
const { OVERSEER_BRIEF_PREFIX } = await import("../../../shared/protocol");
const { optionClick } = await import("../../../shared/overseer-card");
const { RULE_ENTRY, USE_ENTRY, REVOKE_ENTRY, GRANT_ENTRY } = await import("../../../shared/overseer-grants");
const overseer = await import("../../overseer");
const projectOverseer = await import("../../project-overseer");
const orgs = await import("../../orgs");
const baton = await import("../../baton");

after(async () => {
  await disposeAllChats();
  await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
});

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const sink = () => {
  const got: ChatServerMessage[] = [];
  return { got, client: { send: (m: ChatServerMessage) => void got.push(m) } };
};
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const entriesOf = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const customs = (path: string, type: string) => entriesOf(path).filter((e) => e.type === "custom" && e.customType === type);

let n = 0;
/** A header-only web session, as Sova's own creator writes it (pi's header keys, in pi's order). */
function headerOnly(): string {
  const id = `0199cccc-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-10-01T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd }) + "\n");
  markOwned(path);
  addWebSession(id);
  return path;
}

/** Open (or reuse) the held runtime on `path`, running on `model`. */
async function open(path: string, model: ScriptedModel): Promise<Chat> {
  const chat = await acquireChat(path);
  model.attach(piSession(chat));
  return chat;
}
/** A turn the chat socket starts, run to its end. */
async function turn(chat: Chat, text: string, opts?: Parameters<Chat["acceptPrompt"]>[4]): Promise<void> {
  await chat.acceptPrompt(text, undefined, opts ? "server" : "client", undefined, opts).turn;
  await piSession(chat).waitForIdle();
}

/** A scenario's canonical numbering: its files share one id space. Hook notes and tool results are
    elided with the system prompt: they are prose and the wall clock, not state (canonical-jsonl.ts). */
const canon = (literals: Record<string, string> = {}) =>
  new Canonicalizer({ paths: { [root]: "<DIR>", [REPO]: "<REPO>" }, literals, elide: ["system", "notes", "tool-results"] });

/** Compare the file at `path` with golden/state/<name>.jsonl (or record it). */
function golden(name: string, path: string, c: Canonicalizer = canon()): void {
  const got = c.jsonl(readFileSync(path, "utf8"));
  const file = join(GOLDEN, `${name}.jsonl`);
  if (RECORD && (RECORD === "overwrite" || !existsSync(file))) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, got);
    return;
  }
  assert.ok(existsSync(file), `${name}: no golden (record with SOVA_GOLDEN_RECORD=1)`);
  const want = readFileSync(file, "utf8");
  const d = firstDifference(want, got);
  assert.ok(!d, d ? `${name}: line ${d.line} differs from golden/state/${name}.jsonl\n want ${d.want}\n  got ${d.got}` : "");
}

test("G1: a 2-turn session rewound to its second input, reopened (sova-rewind; the open-time flush after navigating)", async () => {
  const model = new ScriptedModel();
  const path = headerOnly();
  const chat = await open(path, model);
  await turn(chat, "one");
  await turn(chat, "two");
  await disposeHeldChat(path, "golden");
  const again = await open(path, model);
  const u2 = entriesOf(path).filter((e) => e.type === "message" && e.message.role === "user")[1]!;
  const { got, client } = sink();
  again.handle(client, { type: "rewind", id: "r1", entryId: u2.id } as never);
  await until(() => got.some((m) => m.type === "rewound" || m.type === "rewind_refused"));
  assert.ok(got.some((m) => m.type === "rewound"), JSON.stringify(got.find((m) => m.type === "rewind_refused")));
  await disposeHeldChat(path, "golden");
  const reopened = await open(path, model);
  assert.equal(piSession(reopened).sessionManager.getLeafId(), customs(path, "sova-rewind")[0].id, "the marker is the leaf on reopen");
  await disposeHeldChat(path, "golden");
  golden("G1-rewind", path);

  // A 2-turn file with no thinking-level entry (an older writer's): the open defers pi's
  // thinking_level_change, and the rewind writes it AFTER navigating (on the new branch), then the marker.
  const old = headerOnly();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const at = "2026-10-01T00:00:01.000Z";
  const user = (id: string, parentId: string, text: string) => ({ type: "message", id, parentId, timestamp: at, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
  const reply = (id: string, parentId: string) => ({
    type: "message", id, parentId, timestamp: at,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: "scripted", model: "scripted", usage, stopReason: "stop", timestamp: 1 },
  });
  const lines = [
    { type: "model_change", id: "a0000001", parentId: null, timestamp: at, provider: "scripted", modelId: "scripted" },
    user("a0000003", "a0000001", "one"),
    reply("a0000004", "a0000003"),
    user("a0000005", "a0000004", "two"),
    reply("a0000006", "a0000005"),
  ];
  writeFileSync(old, readFileSync(old, "utf8") + lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  markOwned(old);
  const resumed = await open(old, model);
  const { got: got2, client: client2 } = sink();
  resumed.handle(client2, { type: "rewind", id: "r2", entryId: "a0000005" } as never);
  await until(() => got2.some((m) => m.type === "rewound" || m.type === "rewind_refused"));
  assert.ok(got2.some((m) => m.type === "rewound"), JSON.stringify(got2.find((m) => m.type === "rewind_refused")));
  await disposeHeldChat(old, "golden");
  golden("G1-rewind-no-thinking", old);
});

test("G2: a prompt from the Overseer, a baton participant and another session (the three sender markers)", async () => {
  const model = new ScriptedModel();
  const path = headerOnly();
  const chat = await open(path, model);
  await turn(chat, "from the overseer", { sentByOverseer: { overseerId: "ov-golden" } });
  await turn(chat, "from a participant", { sentByBaton: { by: "person-golden" } });
  await turn(chat, "from a session", { sentBySession: { sessionId: "0199dddd-0000-7000-8000-000000000001", title: "Sender", hop: 1 } });
  await disposeHeldChat(path, "golden");
  golden("G2-sender-markers", path);
});

test("G3: a topic batch delivered with one turn (sova-topic-delivered)", async () => {
  const model = new ScriptedModel();
  const path = headerOnly();
  const chat = await open(path, model);
  let entered = false;
  const started = chat.deliverTopicBatch({
    text: "[topic golden] two notes",
    topic: "golden",
    batch: "b1",
    items: [{ id: "n1", from: { sessionId: "0199dddd-0000-7000-8000-000000000002", title: "Pusher" }, at: "2026-10-01T00:00:09.000Z" }],
    entered: () => void (entered = true),
    gone: () => {},
  });
  assert.equal(started, "started");
  await until(() => entered);
  await piSession(chat).waitForIdle();
  await disposeHeldChat(path, "golden");
  golden("G3-topic-delivered", path);
});

test("G4: a pristine session's loadout, profile, subagent pick and mode pin (each after the open-time flush)", async () => {
  const model = new ScriptedModel();
  const path = headerOnly();
  let chat = await open(path, model);
  chat.writeLoadout({ v: 1, offContext: [join(cwd, "AGENTS.md")], offSkills: ["golden-skill"] });
  await disposeHeldChat(path, "golden"); // the route disposes after the write, so the next open builds with it
  chat = await open(path, model);
  const profile = { ...(parseProfile({ id: "gp", label: "Golden", icon: "eye", remove: [], grant: ["sessions.read"], singleton: false, overseerMayStart: false }) as object), source: "user" };
  chat.writeProfile({ v: 1, profile } as never);
  await disposeHeldChat(path, "golden");
  chat = await open(path, model);
  await chat.switchSubagentProfile("off");
  // The pin first (the branch has no mode entry, so the chat's default is written as its own), then a
  // switch through the extension's /mode, then a pin that matches it and writes nothing.
  assert.equal(chat.pinMode(), true);
  assert.equal(customs(path, "mode").length, 1);
  assert.equal(await chat.applyMode({ ...chat.modeState, mode: "normal", minorModes: ["align"] }), "command");
  await until(() => customs(path, "mode").length > 1);
  assert.equal(chat.pinMode(), true);
  await disposeHeldChat(path, "golden");
  assert.ok(customs(path, PROFILE_ENTRY).length === 1);
  golden("G4-pristine-setup", path);
});

test("G9: the Overseer answers an extension's select dialog (sova-overseer-dialog-answer)", async () => {
  const model = new ScriptedModel();
  const path = headerOnly();
  const chat = await open(path, model);
  const { client } = sink();
  chat.attach(client);
  model.reply({ toolCall: { name: "golden_ask", arguments: {} } });
  const done = chat.acceptPrompt("ask me", undefined, "client").turn;
  await until(() => chat.pendingDialogs().length === 1);
  const [dialog] = chat.pendingDialogs();
  chat.answerDialog(dialog!.id, "Blue", "Blue", "ov-golden");
  await done;
  await piSession(chat).waitForIdle();
  chat.detach(client);
  await disposeHeldChat(path, "golden");
  golden("G9-dialog-answer", path);
});

test("G10: open, attach and dispose with no prompt leaves the file byte-identical", async () => {
  const model = new ScriptedModel();
  const path = headerOnly();
  // A real 1-turn file first, so the reopen restores a model and thinking level from it.
  await turn(await open(path, model), "seed");
  await disposeHeldChat(path, "golden");
  const fresh = headerOnly();
  for (const p of [path, fresh]) {
    const before = readFileSync(p);
    const chat = await open(p, model);
    const { client } = sink();
    chat.attach(client);
    chat.detach(client);
    await disposeHeldChat(p, "golden");
    assert.ok(readFileSync(p).equals(before), `${p} changed on open/dispose`);
  }
  golden("G10-open-dispose", path);
  golden("G10-open-dispose-empty", fresh);
});

// ---- creators and the Overseer, the baton, the project overseer (M4-T3's files) ----------------------------

const org = await orgs.createOrg({ name: "Golden", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });

/** A participant's message enters as the share route does it: the lock, then the prompt. */
function says(chat: Chat, sessionId: string, by: string, text: string): void {
  baton.noteMessage(sessionId, by);
  void chat.acceptPrompt(text, undefined, "server", undefined, { sentByBaton: { by } }).turn.catch(() => {});
}

test("G5: a baton session: seed entries, operator moves with no flush, then a stopped reply's queued messages", async () => {
  const model = new ScriptedModel();
  const bob = await orgs.addPerson(org.id, { name: "Bob Golden", role: "Staff" });
  const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: bob.id, publicTitle: "Golden baton", goal: "g" });
  const chat = await open(c.path, model);
  // Opened and never prompted: the operator's moves go in with the open-time entries still deferred.
  await baton.takeBack(c.sessionId);
  await baton.handoffTo(c.sessionId, bob.id, "Back to you", "");
  await until(() => customs(c.path, "sova-baton-handoff").length === 3);
  const release = model.hold();
  says(chat, c.sessionId, bob.id, "first");
  await until(() => piSession(chat).isStreaming);
  says(chat, c.sessionId, bob.id, "second");
  says(chat, c.sessionId, bob.id, "third");
  await until(() => chat.queue.size === 2);
  await baton.takeBack(c.sessionId);
  release();
  await until(() => customs(c.path, "sova-baton-handoff").length === 4);
  await piSession(chat).waitForIdle();
  await disposeHeldChat(c.path, "golden");
  golden("G5-baton", c.path, canon({ [bob.id]: "<BOB>", [org.id]: "<ORG>", [project.id]: "<PROJECT>" }));
});

test("G6: record_decision from a scripted tool call (pi.appendEntry inside the tool)", async () => {
  const model = new ScriptedModel();
  const kim = await orgs.addPerson(org.id, { name: "Kim Golden", role: "Lead" });
  const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Golden decision", goal: "g" });
  const chat = await open(c.path, model);
  const { got, client } = sink();
  chat.attach(client);
  model.reply({ toolCall: { name: "record_decision", arguments: { area: "payroll dates", ownerArea: "none", statement: "Pay on the 1st.", quote: "the 1st" } } });
  says(chat, c.sessionId, kim.id, "we pay on the 1st");
  await until(() => customs(c.path, "sova-baton-decision").length === 1);
  await until(() => !piSession(chat).isStreaming && model.calls.length === 2);
  await piSession(chat).waitForIdle();
  assert.ok(got.some((m) => m.type === "append" && JSON.stringify(m).includes("Pay on the 1st.")), "the entry's row is broadcast (entry_appended)");
  chat.detach(client);
  await disposeHeldChat(c.path, "golden");
  golden("G6-baton-decision", c.path, canon({ [kim.id]: "<KIM>", [org.id]: "<ORG>", [project.id]: "<PROJECT>" }));
});

test("G7: the Overseer: a rule adopted by a click, carried by /clear, used by a tool mid-run, revoked", async () => {
  const model = new ScriptedModel();
  const target = headerOnly();
  const targetModel = new ScriptedModel();
  await open(target, targetModel);
  const first = await overseer.ensureOverseer();
  let chat = await open(first.path, model);
  model.reply({
    toolCall: {
      name: "sova_card",
      arguments: { ops: [{ op: "create", title: "Keep them going?", options: [{ label: "No" }, { label: "Always", reply: "Yes, always", rule: { text: "Send continue to any session", acts: ["sova_send"], any_session: true } }] }] },
    },
  });
  await turn(chat, "ask me about the sessions");
  const card = entriesOf(first.path).find((e) => e.message?.role === "toolResult" && e.message.toolName === "sova_card")?.message.details.card;
  assert.ok(card, "the card was made");
  const { client } = sink();
  chat.handle(client, { type: "prompt", text: optionClick(card, "b")!, confirm: card.id } as never);
  await until(() => customs(first.path, RULE_ENTRY).length === 1);
  await piSession(chat).waitForIdle();
  const ruleId = customs(first.path, RULE_ENTRY)[0].data.id as string;

  const cleared = await overseer.clearOverseer();
  chat = await open(cleared.path, model);
  model.reply({ toolCall: { name: "sova_send", arguments: { session: JSON.parse(readFileSync(target, "utf8").split("\n")[0]!).id, text: "continue" } } });
  await turn(chat, `${OVERSEER_BRIEF_PREFIX} a session is waiting`, {});
  await until(() => customs(cleared.path, USE_ENTRY).length === 1);
  const revoked = await overseer.revokePermit(ruleId);
  assert.deepEqual(revoked, { ok: true });
  await until(() => customs(target, "sova-overseer-sent").length === 1);
  await piSession(await acquireChat(target)).waitForIdle();
  await disposeAllChats();
  assert.equal(customs(first.path, GRANT_ENTRY).length + customs(cleared.path, REVOKE_ENTRY).length, 1);
  const c = canon();
  golden("G7-overseer-first", first.path, c);
  golden("G7-overseer-cleared", cleared.path, c);
  golden("G7-overseer-target", target, c);
});

test("G8: a project overseer's file, and a web session made with a subagent profile (open + append on a header-only file)", async () => {
  const po = await projectOverseer.ensureProjectOverseer(project.id);
  golden("G8-project-overseer", po.path, canon({ [project.id]: "<PROJECT>" }));
  const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, subagent_profile: "off" }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { path } = (await res.json()) as { path: string };
  golden("G8-web-session-profile", path);
});
