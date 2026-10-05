#!/usr/bin/env node
// harness-wire-e2e: the harness wire end to end against a RUNNING Sova (§app.harness/wire). It starts
// nothing itself; point it at a server you started (normally `pnpm run dev:hermetic`, port 4810).
//
//   pnpm exec tsx scripts/harness-wire-e2e.mjs --base http://localhost:4810 --agent-dir .agent [options]
//
//   --base <url>        the server (default http://localhost:4810)
//   --token <t>         its access token; or --agent-dir <dir> to read <dir>/sova/auth-token; or
//                       SOVA_E2E_TOKEN in the environment. Sent as the x-sova-token header only.
//   --path <file>       an existing session to use (read-only unless a turn is driven)
//   --cwd <dir>         create a new session in <dir> instead (default: this checkout)
//   --model <ref>       set this model (e.g. zai/glm-5.3) before the turn
//   --prompt <text>     the turn's prompt (default: one that makes a read tool call)
//   --no-turn           only the read checks (hello, watch, REST); drive no turn
//   --timeout <s>       how long the turn may take (default 180)
//   --force             open the chat even when another process wrote the file lately (`force=1`, as
//                       the page's "open anyway"): a session copied into another server's agent dir
//   --old-server        the server predates wire 2 (it ignores the parameter): the wire-2 client
//                       must then get the very wire-1 frames and rows, and read them through the shim
//
// What it does, as two raw clients on one session at once, one that doesn't ask for wire 2 (an older
// bundle, a script, an older peer's page) and one that does (today's browser):
//   1. /ws/chat hello, /ws/watch?tail=1 snapshot and GET /api/transcript (whole, tail=1, view=light):
//      the same rows on both, `meta` on wire 1 and `facts` = factsFromMeta(meta) on wire 2, the same cuts.
//   2. One turn, sent by the wire-1 client: every wire-1 event frame has no `v`, every wire-2 one has
//      v:2; fromV1 of the wire-1 frames, in order, is exactly the wire-2 events; every other message is
//      the same on both (rows mapped); the browser's reducer (src/lib/live.ts) on each stream reaches
//      the same live state; the watch sockets' appends match too.
//   3. After it settles, the transcript again: same rows on both wires, and the reply's text is in them.
// Exit 0 when every check passed, 1 when one failed, 2 on a usage or connection problem. It never
// prints the token. Only the session you name or create is touched (one turn, when not --no-turn).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { WebSocket } from "ws";
import { createStore } from "solid-js/store";
import { factsFromMeta, fromV1 } from "../shared/wire-v1.ts";
import { applyEvent, emptyLive, liveEventsOf } from "../src/lib/live.ts";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");

function args(argv) {
  const out = { base: "http://localhost:4810", turn: true, timeout: 180, prompt: "Read package.json and tell me the package name, in one short sentence." };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === "--base") out.base = val().replace(/\/$/, "");
    else if (a === "--token") out.token = val();
    else if (a === "--agent-dir") out.agentDir = val();
    else if (a === "--path") out.path = val();
    else if (a === "--cwd") out.cwd = val();
    else if (a === "--model") out.model = val();
    else if (a === "--prompt") out.prompt = val();
    else if (a === "--no-turn") out.turn = false;
    else if (a === "--old-server") out.oldServer = true;
    else if (a === "--force") out.force = true;
    else if (a === "--timeout") out.timeout = Number(val());
    else if (a === "-h" || a === "--help") usage();
    else usage(`unknown argument ${a}`);
  }
  out.token ??= process.env.SOVA_E2E_TOKEN || (out.agentDir ? readFileSync(join(out.agentDir, "sova", "auth-token"), "utf8").trim() : undefined);
  if (!out.token) usage("no token: --token, --agent-dir or SOVA_E2E_TOKEN");
  return out;
}

function usage(problem) {
  const head = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
  if (problem) console.error(`harness-wire-e2e: ${problem}\n`);
  console.error(head);
  process.exit(2);
}

const opt = args(process.argv.slice(2));
const headers = { "x-sova-token": opt.token };
const wsBase = opt.base.replace(/^http/, "ws");

let failed = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${!ok && detail ? `\n     ${detail}` : ""}`);
  if (!ok) failed++;
  return ok;
}
const json = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Wire-1 rows and wire-2 rows of one answer: the same rows, meta on one and its facts on the other. */
function rowsMapped(v1, v2, where) {
  if (!check(Array.isArray(v1) && Array.isArray(v2) && v1.length === v2.length, `${where}: the same number of rows (${v1?.length} / ${v2?.length})`)) return;
  if (opt.oldServer) return void check(isDeepStrictEqual(v1, v2), `${where}: an older server answers wire=2 with the wire-1 rows`);
  const bad = [];
  v1.forEach((r1, i) => {
    const r2 = v2[i];
    const { meta, ...rest1 } = r1;
    const { facts, ...rest2 } = r2;
    if ("facts" in r1) bad.push(`row ${i} (${r1.id}): wire 1 carries facts`);
    if ("meta" in r2) bad.push(`row ${i} (${r2.id}): wire 2 carries meta`);
    if (!isDeepStrictEqual(json(facts), json(factsFromMeta(meta)))) bad.push(`row ${i} (${r1.id}): facts ${JSON.stringify(facts)} are not its meta's ${JSON.stringify(json(factsFromMeta(meta)))}`);
    if (!isDeepStrictEqual(rest1, rest2)) bad.push(`row ${i} (${r1.id}): differs beyond meta/facts`);
  });
  check(bad.length === 0, `${where}: every row is its wire-1 row with facts for meta`, bad.slice(0, 5).join("\n     "));
}

async function api(path, init = {}) {
  const res = await fetch(`${opt.base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** A socket that records every message (raw text) and resolves waits on them. */
function socket(path) {
  const ws = new WebSocket(`${wsBase}${path}`, { headers });
  const got = [];
  const waiters = [];
  ws.on("message", (d) => {
    got.push(String(d));
    for (const w of [...waiters]) if (w.test()) (waiters.splice(waiters.indexOf(w), 1), w.done());
  });
  const opened = new Promise((ok, fail) => {
    ws.once("open", ok);
    ws.once("error", fail);
    ws.once("unexpected-response", (_q, res) => fail(new Error(`${path}: HTTP ${res.statusCode}`)));
  });
  const until = (pred, ms, what) =>
    new Promise((ok, fail) => {
      const test = () => pred(got);
      if (test()) return ok();
      const timer = setTimeout(() => fail(new Error(`timed out after ${ms} ms: ${what}`)), ms);
      waiters.push({ test, done: () => (clearTimeout(timer), ok()) });
    });
  return { ws, got, opened, until, parsed: () => got.map((s) => JSON.parse(s)) };
}

async function main() {
  const health = await api("/api/health");
  console.log(`server ${opt.base}: ${health.head ? `head ${String(health.head).slice(0, 12)}` : "no head reported"}`);

  let path = opt.path;
  if (!path) {
    const made = await api("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: opt.cwd ?? REPO }) });
    path = made.path;
    console.log(`created a session in ${opt.cwd ?? REPO}`);
  }
  const q = `path=${encodeURIComponent(path)}`;
  const qChat = `${q}${opt.force ? "&force=1" : ""}`;

  // ---- 1. reads ----------------------------------------------------------------------------------
  const chat1 = socket(`/ws/chat?${qChat}`);
  const chat2 = socket(`/ws/chat?${qChat}&wire=2`);
  const watch1 = socket(`/ws/watch?${q}&tail=1`);
  const watch2 = socket(`/ws/watch?${q}&tail=1&wire=2`);
  await Promise.all([chat1, chat2, watch1, watch2].map((s) => s.opened));
  const msg = (s, type) => s.parsed().find((m) => m.type === type);
  // A refusal (another process holds the file: `--force`; a bad path) comes as an error frame first.
  const first = async (s, type, where) => {
    await s.until((g) => g.some((m) => [type, "error"].includes(JSON.parse(m).type)), 15_000, `${where}: a ${type}`);
    if (!msg(s, type)) throw new Error(`${where}: ${JSON.stringify(msg(s, "error"))}`);
  };
  await Promise.all([first(chat1, "hello", "/ws/chat"), first(chat2, "hello", "/ws/chat wire 2"), first(watch1, "snapshot", "/ws/watch"), first(watch2, "snapshot", "/ws/watch wire 2")]);
  const hello1 = msg(chat1, "hello");
  const hello2 = msg(chat2, "hello");
  rowsMapped(hello1.items, hello2.items, "/ws/chat hello");
  const { items: _a, ...h1 } = hello1;
  const { items: _b, ...h2 } = hello2;
  check(isDeepStrictEqual(h1, h2), "/ws/chat hello: everything beside the rows is the same");
  const snap1 = msg(watch1, "snapshot");
  const snap2 = msg(watch2, "snapshot");
  rowsMapped(snap1.items, snap2.items, "/ws/watch snapshot");
  check(snap1.older === snap2.older, `/ws/watch snapshot: the same older cut (${snap1.older})`);

  async function restChecks(when) {
    for (const extra of ["", "&tail=1", "&view=light"]) {
      const r1 = await api(`/api/transcript?${q}${extra}`);
      const r2 = await api(`/api/transcript?${q}${extra}&wire=2`);
      const items1 = Array.isArray(r1) ? r1 : r1.items;
      const items2 = Array.isArray(r2) ? r2 : r2.items;
      rowsMapped(items1, items2, `${when} GET /api/transcript${extra || " (whole)"}`);
      if (!Array.isArray(r1)) {
        const { items: _x, ...o1 } = r1;
        const { items: _y, ...o2 } = r2;
        check(isDeepStrictEqual(o1, o2), `${when} GET /api/transcript${extra}: the same cut (older, olderSummary, …)`);
      }
    }
    const whole = await api(`/api/transcript?${q}`);
    return Array.isArray(whole) ? whole : whole.items;
  }
  await restChecks("before");

  // ---- 2. one turn ----------------------------------------------------------------------------------
  if (opt.turn) {
    if (opt.model) {
      chat1.ws.send(JSON.stringify({ type: "set_model", ref: opt.model }));
      await chat1.until((g) => g.some((m) => /^\{"type":"(model|error)"/.test(m)), 15_000, "the model answer");
      const answer = chat1.parsed().find((m) => m.type === "model" || m.type === "error");
      if (!check(answer.type === "model", `set_model ${opt.model}`, JSON.stringify(answer).slice(0, 200))) return;
      await new Promise((r) => setTimeout(r, 1000)); // the switch's other messages (thinking, …) reach both first
    }
    const marks = [chat1, chat2, watch1, watch2].map((s) => s.got.length);
    chat1.ws.send(JSON.stringify({ type: "prompt", text: opt.prompt, clientId: `e2e-${Date.now()}` }));
    const settled = (wire) => (g) => g.some((m, i) => i >= marks[wire === 1 ? 0 : 1] && (wire === 1 || opt.oldServer ? m.includes('"type":"agent_settled"') : m.includes('"type":"run.settled"')));
    await Promise.all([chat1.until(settled(1), opt.timeout * 1000, "wire 1 settles"), chat2.until(settled(2), opt.timeout * 1000, "wire 2 settles")]);
    await new Promise((r) => setTimeout(r, 1500)); // the settle's appends and the watch tail
    const since = (s, k) => s.got.slice(marks[k]).map((t) => ({ text: t, m: JSON.parse(t) }));
    const turn1 = since(chat1, 0);
    const turn2 = since(chat2, 1);
    const events1 = turn1.filter((x) => x.m.type === "event");
    const events2 = turn2.filter((x) => x.m.type === "event");
    check(events1.length > 0 && events1.every((x) => !("v" in x.m)), `wire 1: ${events1.length} event frames, none with v`);
    const mapped = events1.flatMap((x) => fromV1(x.m)).map(json);
    // An older server: the wire-2 client gets wire 1 and maps it itself (the browser's shim).
    const got2 = opt.oldServer ? events2.flatMap((x) => liveEventsOf(x.m)).map(json) : events2.map((x) => x.m.event);
    if (opt.oldServer) check(events2.length === events1.length && events2.every((x, i) => x.text === events1[i].text), `an older server: the wire-2 client got the wire-1 frames, byte for byte (${events2.length})`);
    else check(events2.length > 0 && events2.every((x) => x.m.v === 2), `wire 2: ${events2.length} event frames, all v:2`);
    const at = mapped.findIndex((e, i) => !isDeepStrictEqual(e, got2[i]));
    check(at === -1 && mapped.length === got2.length, `fromV1 of the wire-1 frames is exactly the ${opt.oldServer ? "shim's" : "wire-2"} events (${got2.length})`, at >= 0 ? `event ${at}: ${JSON.stringify(mapped[at]).slice(0, 160)} vs ${JSON.stringify(got2[at]).slice(0, 160)}` : `${mapped.length} vs ${got2.length}`);
    // send_ack answers the sender alone (the wire-1 client sent the prompt).
    const rest1 = turn1.filter((x) => x.m.type !== "event" && x.m.type !== "send_ack");
    const rest2 = turn2.filter((x) => x.m.type !== "event" && x.m.type !== "send_ack");
    if (check(rest1.map((x) => x.m.type).join() === rest2.map((x) => x.m.type).join(), `the other messages come alike (${rest1.map((x) => x.m.type).join(", ") || "none"})`))
      rest1.forEach((x, i) => {
        if (Array.isArray(x.m.items)) rowsMapped(x.m.items, rest2[i].m.items, `turn ${x.m.type} ${i}`);
        else check(x.text === rest2[i].text, `turn ${x.m.type} ${i}: byte for byte`);
      });
    const reduce = (frames) => {
      const [state, set] = createStore(emptyLive());
      for (const f of frames) for (const ev of liveEventsOf(f)) applyEvent(set, ev);
      return json(state);
    };
    const live1 = reduce(events1.map((x) => x.m));
    const live2 = reduce(events2.map((x) => x.m));
    check(isDeepStrictEqual(live1, live2), "the browser's reducer reaches the same live state on both wires");
    const reply = [...live2.entries].reverse().find((e) => e.kind === "assistant");
    const replyText = (reply?.blocks ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    check(replyText.length > 0, `the reply streamed and settled: "${replyText.slice(0, 80)}"`);
    const tools = got2.filter((e) => e.type === "tool.start").map((e) => e.name);
    console.log(`     tools run: ${tools.join(", ") || "none"}`);
    const fill = [...got2].reverse().find((e) => e.type === "message.end" && e.role === "assistant");
    console.log(`     the reply's context fill (the context chip): ${fill?.contextTokens ?? "none reported"}`);
    const w1 = since(watch1, 2).filter((x) => x.m.type === "append");
    const w2 = since(watch2, 3).filter((x) => x.m.type === "append");
    if (check(w1.length === w2.length && w1.length > 0, `/ws/watch: the same appends on both wires (${w1.length})`)) w1.forEach((x, i) => rowsMapped(x.m.items, w2[i].m.items, `/ws/watch append ${i}`));

    // ---- 3. a reload --------------------------------------------------------------------------------
    const rows = await restChecks("after");
    const texts = rows.filter((r) => r.kind === "assistant-text").map((r) => r.text ?? "");
    check(texts.some((t) => t.trim() === replyText || t.includes(replyText.slice(0, 40))), "a reload shows the reply's row");
  }
  for (const s of [chat1, chat2, watch1, watch2]) s.ws.close();
}

try {
  await main();
} catch (err) {
  console.error(`harness-wire-e2e: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
console.log(failed ? `\n${failed} check(s) failed` : "\nevery check passed");
process.exit(failed ? 1 : 0);
