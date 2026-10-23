#!/usr/bin/env node
// The director: an OpenAI-compatible chat endpoint on 127.0.0.1 that plays the story's live
// scripts. Each request is matched to its scene by its first user message (a session's first
// `user` step, a worker's `task`, the Overseer's first message), and answered with that scene's
// next reply: streamed text and real tool calls, which Sova's real tools then execute. It never
// calls a model and never touches the network.
//
//   node director.mjs --port <n> --root <capture root> [--chunk <ms>] [--no-gates] [--story <file>]
//
// Control, for capture.mjs and record.mjs:
//   GET  /state                  scenes served, holds waiting/reached, tool errors, unmatched requests
//   GET  /wait/<hold>?timeout=ms {reached}: long-polls until every scene with that hold is there
//   GET  /idle/<scene>?timeout=  {done}: until the scene (and every worker it spawned) has no reply left
//   POST /release/<hold>         lets every reply gated on <hold> stream on
//   POST /bind {id, uuid}        a live session's real id, for "$session:<id>" in tool args
//   POST /pace {chunk}           ms between streamed chunks

import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { loadStory, STORY, storyUuid, whereIn } from "./load-story.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PORT = Number(opt("--port", "0"));
const ROOT = opt("--root");
let CHUNK_MS = Number(opt("--chunk", "6"));
const GATES = !argv.includes("--no-gates");
if (!ROOT) {
  console.error("usage: director.mjs --port <n> --root <capture root> [--chunk <ms>] [--no-gates]");
  process.exit(2);
}

const { plan } = await loadStory(opt("--story", STORY));
const projectDir = join(ROOT, "home", plan.project.path.slice(2));
const worktreePath = (name) => join(dirname(projectDir), ".worktrees", `${basename(projectDir)}-${name}`);

const norm = (s) => s.replace(/\s+/g, " ").trim();
const scenes = plan.scenes.map((s) => ({ ...s, normKey: norm(s.key), served: 0 }));
const sessionIds = new Map(plan.sessions.filter((s) => !s.live).map((s) => [s.id, s.uuid]));
const gates = new Map(); // hold -> { released, waiters: Set<scene id>, resolvers: [] }
const reachedIdle = new Map(); // hold -> Set<scene id>
const errors = [];
const unmatched = [];
const side = [];
const summaries = []; // { at, scene, n }: the summarizer requests answered with a story summary

/**
 * The summarizer's prompt (topic-outline's buildPrompt) names the session by its earliest request
 * ("SESSION ANCHOR") and lists the new messages as [m1]…[mN]. The answer is the scene's next
 * summary step as the summarizer's JSON: each topic gets a consecutive share of m1…mN as its range.
 */
function summaryAnswer(prompt) {
  if (!prompt.startsWith("You maintain a live outline")) return null;
  const anchor = norm(prompt.split("SESSION ANCHOR")[1]?.split("EXISTING OUTLINE")[0] ?? "");
  const scene = scenes.find((s) => s.kind === "session" && s.summaries?.length && anchor.includes(s.normKey));
  if (!scene) return null;
  const k = Math.min(scene.summariesServed ?? 0, scene.summaries.length - 1);
  scene.summariesServed = k + 1;
  const sum = scene.summaries[k];
  const refs = [...new Set([...(prompt.split("NEW MESSAGES:").at(-1) ?? "").matchAll(/^\[(m\d+)\]/gm)].map((m) => m[1]))];
  if (!refs.length) return null;
  const n = sum.topics.length;
  const topicUpdates = sum.topics.map((t, i) => {
    const lo = Math.floor((i * refs.length) / n);
    const hi = Math.max(lo, Math.floor(((i + 1) * refs.length) / n) - 1);
    return { kind: t.update ? "update" : "new", ...(t.update ? { topicId: t.update } : {}), heading: t.heading, from: refs[lo], to: refs[Math.min(hi, refs.length - 1)], summary: t.summary };
  });
  return { scene: scene.id, n: k + 1, json: JSON.stringify({ now: sum.now, overall: sum.overall, topicUpdates }) };
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const listeners = new Set();
const changed = () => {
  for (const f of [...listeners]) f();
};

const gate = (hold) => {
  if (!gates.has(hold)) gates.set(hold, { released: false, waiters: new Set(), passed: new Set(), resolvers: [] });
  return gates.get(hold);
};

/** Every scene that holds at `hold` is there (gated and waiting, or past it; idle holds served). */
function reached(hold) {
  const need = plan.holds[hold];
  if (!need) return false;
  return need.every(({ scene, kind }) => (kind === "idle" ? reachedIdle.get(hold)?.has(scene) : gate(hold).waiters.has(scene) || gate(hold).passed.has(scene)));
}

/** The scene and every worker it spawned have served all their replies. */
function sceneDone(id) {
  const ids = [id, ...scenes.filter((s) => s.owner === id).map((s) => s.id)];
  return ids.every((x) => {
    const s = scenes.find((y) => y.id === x);
    return s && s.served >= s.replies.length;
  });
}

const contentText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "");

/** The scene of the first user message that names one. Usually that is the very first message;
    the Overseer's chat opens with a memory index the app writes, so its key is in a later one. */
function matchScene(messages) {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const t = norm(contentText(m.content));
    let best = null;
    for (const s of scenes) if (t.includes(s.normKey) && (!best || s.normKey.length > best.normKey.length)) best = s;
    if (best) return best;
  }
  return null;
}

/** Worker ids as agent_spawn reported them ("ag_01  <name>  running  backend=pi ..."), by name. */
function workerIds(messages) {
  const ids = new Map();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const line of contentText(m.content).split("\n")) {
      const hit = /^(ag_\d+)\s{2}(.+?)\s{2}\S+\s{2}backend=/.exec(line);
      if (hit) ids.set(hit[2], hit[1]);
    }
  }
  return ids;
}

/** Replace the story's placeholders with what only the run knows. */
function resolveArgs(args, messages) {
  const ids = workerIds(messages);
  const walk = (v) => {
    if (typeof v === "string") {
      let m;
      if ((m = /^\$worker:(.+)$/.exec(v))) {
        const name = plan.workers[m[1]]?.name ?? m[1];
        return ids.get(name) ?? name;
      }
      if ((m = /^\$worktree:(.+)$/.exec(v))) return worktreePath(m[1]);
      if ((m = /^\$session:(.+)$/.exec(v))) return sessionIds.get(m[1]) ?? storyUuid("session", m[1]);
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(args);
}

/** A tool result that says it failed, in the words Sova's tools use, on its first line (a
    successful result may go on to explain what a later refusal would do). */
const looksFailed = (t) => /^(Error|Validation failed)|Nothing was (changed|shown|archived)|refused|not found|No such file|Unknown action|Could not find/i.test(t.split("\n")[0]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Text in word-sized pieces, about as a model streams it. */
function pieces(text) {
  return text.match(/\S+\s*|\s+/g)?.reduce((out, w) => {
    if (out.length && out.at(-1).length + w.length <= 6) out[out.length - 1] += w;
    else out.push(w);
    return out;
  }, []) ?? [];
}

async function answer(req, res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  const model = String(body.model ?? "model");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let closed = false;
  res.on("close", () => (closed = true));
  const send = (obj) => !closed && res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, ...obj })}\n\n`);
  const delta = (d, finish = null) => send({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
  const finish = (reason, completion) => {
    delta({}, reason);
    const prompt = Math.round(JSON.stringify(messages).length / 3.6 + JSON.stringify(body.tools ?? []).length / 6);
    send({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });
    if (!closed) res.end("data: [DONE]\n\n");
  };
  const stream = async (text) => {
    for (const p of pieces(text)) {
      if (closed) return;
      delta({ content: p });
      if (CHUNK_MS > 0) await sleep(CHUNK_MS);
    }
  };

  // A request without tools is a side call (a title, a summary): never part of a scene. Sova's
  // summarizer is answered with the story's next `summary` step for the session it summarizes.
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    const prompt = contentText(messages.find((m) => m.role === "user")?.content);
    side.push({ at: Date.now(), first: prompt.slice(0, 80) });
    const outline = summaryAnswer(prompt);
    delta({ role: "assistant", content: "" });
    if (outline) {
      log(`${outline.scene}: summary ${outline.n}`);
      delta({ content: outline.json });
      summaries.push({ at: Date.now(), scene: outline.scene, n: outline.n });
      changed();
      return finish("stop", Math.round(outline.json.length / 4));
    }
    delta({ content: "Okay." });
    return finish("stop", 2);
  }

  const scene = matchScene(messages);
  if (!scene) {
    const first = contentText(messages.find((m) => m.role === "user")?.content).slice(0, 120);
    unmatched.push({ at: Date.now(), first });
    log("unmatched request:", JSON.stringify(first));
    delta({ role: "assistant", content: "" });
    delta({ content: "Nothing is scripted for this request." });
    return finish("stop", 8);
  }

  const n = messages.filter((m) => m.role === "assistant").length;
  // The result of this scene's previous call, checked for a refusal.
  const last = [...messages].reverse().find((m) => m.role === "tool");
  const prevCall = scene.replies[n - 1]?.calls?.[0];
  if (last && prevCall && looksFailed(contentText(last.content))) {
    const e = { scene: scene.id, tool: prevCall.name, where: `${whereIn(plan, prevCall.pointer)} ${prevCall.pointer}`, message: contentText(last.content).slice(0, 600) };
    if (!errors.some((x) => x.where === e.where)) {
      errors.push(e);
      log("tool refused:", JSON.stringify(e));
    }
  }

  const reply = scene.replies[n];
  if (!reply) {
    log(`${scene.id}: request ${n} is past the script's ${scene.replies.length} replies`);
    delta({ role: "assistant", content: "" });
    delta({ content: "Done." });
    return finish("stop", 2);
  }
  log(`${scene.id}: reply ${n + 1}/${scene.replies.length}${reply.calls[0] ? ` (${reply.calls[0].name})` : ""}${reply.hold ? ` gated on ${reply.hold}` : ""}`);
  delta({ role: "assistant", content: "" });

  // "$session:<id>" inside a reply's text (an Overseer's sova://s/ link) becomes the session's id.
  const replyText = reply.text.replace(/\$session:([a-z][a-z0-9-]*)/g, (_, sid) => sessionIds.get(sid) ?? storyUuid("session", sid));
  const words = pieces(replyText);
  if (reply.hold && GATES) {
    // Stream the first words, then wait mid-reply until the capture releases this hold.
    const head = words.slice(0, Math.min(3, words.length));
    for (const p of head) delta({ content: p });
    const g = gate(reply.hold);
    if (!g.released) {
      g.waiters.add(scene.id);
      changed();
      await new Promise((resolve) => g.resolvers.push(resolve));
      g.waiters.delete(scene.id);
    }
    g.passed.add(scene.id);
    changed();
    await stream(words.slice(head.length).join(""));
  } else {
    if (reply.hold) gate(reply.hold).passed.add(scene.id);
    await stream(replyText);
  }
  if (reply.textHold && GATES) {
    // The text is out whole; the tool call waits for the capture to release this hold.
    const g = gate(reply.textHold);
    if (!g.released) {
      g.waiters.add(scene.id);
      changed();
      await new Promise((resolve) => g.resolvers.push(resolve));
      g.waiters.delete(scene.id);
    }
    g.passed.add(scene.id);
    changed();
  } else if (reply.textHold) gate(reply.textHold).passed.add(scene.id);

  reply.calls.forEach((call, i) => {
    const args = JSON.stringify(resolveArgs(call.args, messages));
    const cid = `call_${scene.id.replace(/-/g, "_")}_${n}_${i}`;
    delta({ tool_calls: [{ index: i, id: cid, type: "function", function: { name: call.name, arguments: "" } }] });
    const mid = Math.ceil(args.length / 2);
    delta({ tool_calls: [{ index: i, function: { arguments: args.slice(0, mid) } }] });
    delta({ tool_calls: [{ index: i, function: { arguments: args.slice(mid) } }] });
  });
  scene.served = Math.max(scene.served, n + 1);
  for (const h of reply.idleHolds ?? []) {
    if (!reachedIdle.has(h)) reachedIdle.set(h, new Set());
    reachedIdle.get(h).add(scene.id);
  }
  finish(reply.calls.length ? "tool_calls" : "stop", Math.max(1, Math.round(replyText.length / 4)));
  changed();
}

function state() {
  return {
    scenes: Object.fromEntries(scenes.map((s) => [s.id, { served: s.served, of: s.replies.length }])),
    holds: Object.fromEntries(Object.keys(plan.holds).map((h) => [h, { reached: reached(h), waiting: [...gate(h).waiters], released: gate(h).released }])),
    waiting: Object.keys(plan.holds).filter((h) => gate(h).waiters.size > 0),
    errors,
    unmatched,
    side: side.length,
    summaries,
  };
}

/** Resolve when `test()` holds, or after `timeout` ms with false. */
function until(test, timeout) {
  return new Promise((resolve) => {
    if (test()) return resolve(true);
    const done = (v) => {
      listeners.delete(check);
      clearTimeout(timer);
      resolve(v);
    };
    const check = () => test() && done(true);
    const timer = setTimeout(() => done(false), timeout);
    listeners.add(check);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let raw = "";
  for await (const c of req) raw += c;
  const json = (v, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method === "POST" && /\/chat\/completions$/.test(url.pathname)) return await answer(req, res, raw ? JSON.parse(raw) : {});
    if (req.method === "GET" && url.pathname === "/v1/models") return json({ object: "list", data: [...new Set(Object.values(plan.models).map((m) => m.id))].map((id) => ({ id, object: "model" })) });
    if (req.method === "GET" && url.pathname === "/state") return json(state());
    const timeout = Number(url.searchParams.get("timeout") ?? 60_000);
    let m;
    if (req.method === "GET" && (m = /^\/wait\/([a-z][a-z0-9-]*)$/.exec(url.pathname))) {
      if (!plan.holds[m[1]]) return json({ error: `no hold ${m[1]}` }, 404);
      return json({ reached: await until(() => reached(m[1]), timeout) });
    }
    if (req.method === "GET" && (m = /^\/idle\/([a-z][a-z0-9-]*)$/.exec(url.pathname))) return json({ done: await until(() => sceneDone(m[1]), timeout) });
    if (req.method === "POST" && (m = /^\/release\/([a-z][a-z0-9-]*)$/.exec(url.pathname))) {
      const g = gate(m[1]);
      g.released = true;
      for (const r of g.resolvers.splice(0)) r();
      log(`released ${m[1]}`);
      return json({ released: m[1] });
    }
    if (req.method === "POST" && url.pathname === "/bind") {
      const { id, uuid } = JSON.parse(raw);
      sessionIds.set(id, uuid);
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/pace") {
      CHUNK_MS = Number(JSON.parse(raw).chunk ?? CHUNK_MS);
      return json({ chunk: CHUNK_MS });
    }
    json({ error: "not found" }, 404);
  } catch (e) {
    log("error:", e.stack ?? e);
    if (!res.headersSent) json({ error: String(e.message ?? e) }, 500);
    else res.end();
  }
});
server.listen(PORT, "127.0.0.1", () => log(`director on http://127.0.0.1:${server.address().port}/v1 (${scenes.length} scenes, chunk ${CHUNK_MS} ms${GATES ? "" : ", no gates"})`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
