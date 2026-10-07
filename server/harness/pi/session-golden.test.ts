// Run: pnpm test -- server/harness/pi/session-golden.test.ts
//
// The session behaviour goldens S1-S15 (§app/harness, milestone 5): what a live chat does, driven
// through today's real code paths (acquireChat, the chat socket's `handle`, the queue, the routes'
// ChatSession methods) on the real pi with a ScriptedModel. Each scenario leaves two fixtures in
// golden/session/:
// - `<name>.jsonl`: the session file(s) it wrote, canonical (canonical-jsonl.ts, as the state goldens);
// - `<name>.trace`: one line per thing that happened, in the order it happened:
//   - `A <msg>` / `B <msg>`: what each of two attached clients was sent, A on wire 1 and B on wire 2
//     (the existing mappers, as server/ws.ts delivers), every event frame whole, a hello cut to its
//     state and rows, and a frame type no scenario exercises left out (`projected` below);
//   - `sdk <call> <args>`: each call into pi's AgentSession (prompt, steer, abort, compact, …, and an
//     extension command's handler), recorded by wrapping the raw session from the test side, so the
//     recording does not care where the calling code lives;
//   - `write <entry>`: each entry pi appended, as it appended it;
//   - `step …` / `got …`: the test's own actions and what they returned.
// Both are canonical together (one id space), and compared byte for byte: they characterize the live
// chat. Record missing fixtures with SOVA_GOLDEN_RECORD=1 (same command); after an intended change,
// SOVA_GOLDEN_RECORD=overwrite rewrites them all, and the diff is reviewed with the change.
//
// Ordering comes from the code under test only: a held reply (ScriptedModel.hold) or a held compaction
// (compact-fixture-ext.ts) parks the run at a known point, the test acts there, and waits for the
// outcome it expects; no step depends on how long anything took.
//
// One process, one throwaway PI_CODING_AGENT_DIR (models.json registers the scripted models), the
// server's app built in-process (server/app.ts, no listener) with the Overseer's dispatch wired as
// server/index.ts wires it, so the Overseer and the baton are wired. ~/.pi is never read or written.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { ChatClientMessage } from "../../../shared/protocol";
import { Canonicalizer, firstDifference } from "./testing/canonical-jsonl";
import { compactFixture } from "./testing/compact-fixture-ext";
import { SCRIPTED_MODEL, ScriptedModel, scriptedModelsJson } from "./testing/scripted-model";
import { piSession } from "./testing/handle";
import { assertPinnedPi } from "./testing/load-pi";

// Before PI_PACKAGE_DIR is set below: the link it names must be the pinned pi.
assertPinnedPi();
for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const REPO = resolve(import.meta.dirname, "../../..");
const GOLDEN = join(import.meta.dirname, "golden/session");
const RECORD = process.env.SOVA_GOLDEN_RECORD;

// A fixed base, not tmpdir(): the goldens' token estimate counts this path's length, so it must not move with TMPDIR.
const root = realpathSync(mkdtempSync("/tmp/sova-session-golden-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--golden--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });
// pi's system prompt names its README, docs and examples by the package's path, and the compaction's
// `estimatedTokensAfter` counts the system prompt's characters: from node_modules, that path's length
// is the checkout's. PI_PACKAGE_DIR (pi's own override) points pi at a link under the root instead.
const piPackage = realpathSync(join(REPO, "node_modules/@earendil-works/pi-coding-agent"));
symlinkSync(piPackage, join(root, "pi"));
process.env.PI_PACKAGE_DIR = join(root, "pi");
// The scripted model, and a second one with a thinking ladder for the model/thinking switch (S14).
const models = scriptedModelsJson();
models.providers.scripted.models.push({ id: "scripted-think", reasoning: true, contextWindow: SCRIPTED_MODEL.contextWindow, maxTokens: SCRIPTED_MODEL.maxTokens } as never);
writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
// A fixture extension whose tool opens a select dialog (S13), the repo's mode extension by its real
// path (S15), and the compaction fixture (S7, S8). keepRecentTokens 1: a two-turn session has
// something to summarize.
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
  JSON.stringify({
    defaultProvider: "scripted",
    defaultModel: "scripted",
    retry: { baseDelayMs: 1 },
    compaction: { keepRecentTokens: 1 },
    extensions: [join(REPO, "pi-config/extensions/mode"), join(import.meta.dirname, "testing/compact-fixture-ext.ts")],
  }),
);

const { buildApp } = await import("../../app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
// The Overseer's tools call the routes in-process, wired as server/index.ts wires them.
(await import("../../overseer")).setOverseerDispatch((path, init) => app.request(path, init));
const { acquireChat, disposeAllChats, disposeHeldChat, setLinksSource } = await import("../../chat-manager");
type ChatClient = import("../../chat-manager").ChatClient;
const { canonicalPath } = await import("../../paths");
const { markOwned } = await import("../../write-guard");
const { addWebSession } = await import("../../web-sessions");
const { OVERSEER_BRIEF_PREFIX } = await import("../../../shared/protocol");
const { loadDefaults } = await import("../../web-defaults");
const { stateRoot } = await import("../../state-root");
const overseer = await import("../../overseer");
const orgs = await import("../../orgs");
const baton = await import("../../baton");

// The server's links source reads the mesh's stores, so its frame would land wherever that read
// finishes: one that answers in a microtask keeps each `links` frame at its call site (after a hello).
setLinksSource(async () => []);

after(async () => {
  await disposeAllChats();
});

type Chat = Awaited<ReturnType<typeof acquireChat>>;

async function until(cond: () => boolean, what = "condition", ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
/** Let the timers a step leaves behind run (the settle sweeps' setTimeout 0, setImmediate refreshes). */
async function ticks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1));
}
/** Wait until the chat is idle with nothing queued anywhere, then let the deferred work run. */
async function idle(chat: Chat): Promise<void> {
  const quiet = () => !chat.turnStarting && !piSession(chat).isStreaming && !chat.isCompacting() && chat.queue.size === 0 && !piSession(chat).agent.hasQueuedMessages();
  await until(quiet, "idle");
  await piSession(chat).waitForIdle();
  await ticks();
  await until(quiet, "idle");
}

const entriesOf = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

let n = 0;
/** A web session file as Sova's own creator writes it, plus any entries after the header. */
function sessionFile(lines: Record<string, unknown>[] = []): string {
  const id = `0199eeee-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-10-01T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  const header = { type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd };
  writeFileSync(path, [header, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  markOwned(path);
  addWebSession(id);
  return path;
}

// ---- the trace ----------------------------------------------------------------------------------------

/** The frame types the scenarios exercise. Any other (the command list, the profile, the Claude login
    note, and whatever a later feature adds to a hello) is left out of the trace, so adding one
    re-records nothing; its own tests pin it. */
const PINNED = new Set([
  "hello", "history", "event", "append", "queue", "queue_item_gone", "queue_removed", "queue_cleared", "send_ack", "mode", "model",
  "thinking", "links", "ui_request", "ui_resolved", "rewound", "regenerated", "compacted", "error",
]);
/** The hello fields the scenarios exercise: the run state and the model, and the rows as ids and kinds. */
const HELLO_KEYS = ["type", "isStreaming", "isCompacting", "model", "thinking", "items"];

/** A wire message cut to what the golden pins (null: left out): event frames, rows, queue and the small
    control messages whole; a hello to HELLO_KEYS, and a hello or history's rows to their ids and kinds
    (the rows themselves are the reader goldens'). */
function projected(json: string): string | null {
  const m = JSON.parse(json) as Record<string, unknown> & { type: string };
  if (!PINNED.has(m.type)) return null;
  const rows = (items: unknown) => (Array.isArray(items) ? items.map((r: { id?: string; kind?: string }) => `${r.id} ${r.kind}`) : items);
  if (m.type === "hello") return JSON.stringify(Object.fromEntries(HELLO_KEYS.filter((k) => k in m).map((k) => [k, k === "items" ? rows(m.items) : m[k]])));
  if (m.type === "history") return JSON.stringify({ ...m, items: rows(m.items) });
  // pi 0.87's system-prompt message (its tool texts, the repo's paths) and a hook's custom message
  // (the Overseer's run note carries the wall clock) ride in message events and agent_end on wire 1:
  // elided as in the file (canonical-jsonl.ts "system", "notes"), their place and envelope kept.
  if (!json.includes('"role":"system"') && !json.includes('"role":"custom"')) return json;
  return JSON.stringify(m, (_k, v) => {
    const role = v && typeof v === "object" ? (v as { role?: unknown }).role : undefined;
    if (role === "system") return { role: "system", elided: true };
    if (role === "custom" && "content" in v) return { ...v, content: "<elided>" };
    return v;
  });
}

/** A call's arguments: a function as "<fn>", a pi Model (setModel's) as its `provider/id`. */
const ARGS = (args: unknown[]) =>
  JSON.stringify(args, (_k, v) => (typeof v === "function" ? "<fn>" : v && typeof v === "object" && "provider" in v && "contextWindow" in v ? `${v.provider}/${v.id}` : v));

type Sdk = Record<string, (...a: unknown[]) => unknown> & {
  agent: Record<string, (...a: unknown[]) => unknown>;
  sessionManager: Record<string, (...a: unknown[]) => unknown>;
  extensionRunner: { getCommand(name: string): { handler(args: string, ctx: unknown): Promise<unknown> } | undefined };
  _isEmittingAgentSettled?: boolean;
};

class Trace {
  readonly lines: string[] = [];
  private readonly watched = new WeakSet<object>();

  step(what: string): void {
    this.lines.push(`step ${what}`);
  }
  got(what: string, value: unknown): void {
    this.lines.push(`got ${what} ${JSON.stringify(value)}`);
  }

  /** A client as server/ws.ts makes one, its messages in the trace under `name`. */
  client(name: string, wire: 1 | 2): ChatClient {
    const push = (json: string) => {
      const line = projected(json);
      if (line !== null) this.lines.push(`${name} ${line}`);
    };
    return { send: (m) => push(JSON.stringify(m)), sendRaw: push, ...(wire === 2 ? { wire: 2 as const } : {}) };
  }

  /** Record every call into this pi session and every entry it appends, from now on (late-bound,
      the way the chat's own code reaches it: by property, at call time). Idempotent per session. */
  watch(chat: Chat): void {
    const s = piSession(chat) as unknown as Sdk;
    if (this.watched.has(s)) return;
    this.watched.add(s);
    const wrap = (obj: Record<string, (...a: unknown[]) => unknown>, name: string, label = name) => {
      const orig = obj[name]!;
      obj[name] = (...args: unknown[]) => {
        // pi's settle window (P5): a prompt made inside agent_settled's emit is deferred.
        this.lines.push(`sdk ${label} ${ARGS(args)}${s._isEmittingAgentSettled ? " (settling)" : ""}`);
        return orig.apply(obj, args);
      };
    };
    for (const m of ["prompt", "steer", "followUp", "abort", "clearQueue", "compact", "navigateTree", "setModel", "setThinkingLevel", "sendCustomMessage"]) wrap(s, m);
    wrap(s.agent, "continue", "agent.continue");
    const runner = s.extensionRunner;
    const getCommand = runner.getCommand.bind(runner);
    runner.getCommand = (name: string) => {
      const cmd = getCommand(name);
      if (!cmd) return cmd;
      return { ...cmd, handler: (args: string, ctx: unknown) => (this.lines.push(`sdk command /${name} ${JSON.stringify(args)}`), cmd.handler(args, ctx)) };
    };
    const sm = s.sessionManager;
    const append = sm._appendEntry!;
    sm._appendEntry = (entry: unknown) => {
      const e = entry as { id: string; type: string; customType?: string; message?: { role?: string } };
      this.lines.push(`write ${JSON.stringify({ id: e.id, type: e.type, ...(e.customType ? { customType: e.customType } : {}), ...(e.message?.role ? { role: e.message.role } : {}) })}`);
      return append.call(sm, entry);
    };
  }

  /** Lines containing `text`, for the test's waits. */
  has(text: string): boolean {
    return this.lines.some((l) => l.includes(text));
  }
  count(text: string): number {
    return this.lines.filter((l) => l.includes(text)).length;
  }
}

/** The thinking row setThinking synthesizes is keyed on the wall clock; a dialog's id is random (a uuid,
    which the canonicalizer numbers). */
const TRACE_LITERALS: [RegExp, string][] = [[/"thinking-\d+"/g, '"thinking-<ms>"']];

/** Compare a scenario's files and trace with golden/session/<name>.{jsonl,trace} (or record them). */
function golden(name: string, paths: string[], trace: Trace, literals: Record<string, string> = {}): void {
  const c = new Canonicalizer({ paths: { [root]: "<DIR>", [REPO]: "<REPO>" }, literals, elide: ["system", "notes", "tool-results"], idsAnywhere: true });
  const files = paths.map((p) => c.jsonl(readFileSync(p, "utf8"))).join("\n");
  let text = trace.lines.join("\n") + "\n";
  for (const [re, to] of TRACE_LITERALS) text = text.replace(re, to);
  const got = { jsonl: files, trace: c.jsonl(text) };
  for (const ext of ["jsonl", "trace"] as const) {
    const file = join(GOLDEN, `${name}.${ext}`);
    if (RECORD && (RECORD === "overwrite" || !existsSync(file))) {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(file, got[ext]);
      continue;
    }
    assert.ok(existsSync(file), `${name}.${ext}: no golden (record with SOVA_GOLDEN_RECORD=1)`);
    const d = firstDifference(readFileSync(file, "utf8"), got[ext]);
    assert.ok(!d, d ? `${name}.${ext}: line ${d.line} differs from golden/session/${name}.${ext}\n want ${d.want}\n  got ${d.got}` : "");
  }
}

/** Open (or reuse) the held runtime on `path`, on `model`, watched by `trace`. */
async function open(path: string, model: ScriptedModel, trace: Trace): Promise<Chat> {
  const chat = await acquireChat(path);
  model.attach(piSession(chat));
  trace.watch(chat);
  return chat;
}
/** Two clients, A on wire 1 and B on wire 2, attached in that order. */
function attachBoth(chat: Chat, trace: Trace): { a: ChatClient; b: ChatClient } {
  const a = trace.client("A", 1);
  const b = trace.client("B", 2);
  trace.step("attach A, B");
  chat.attach(a);
  chat.attach(b);
  return { a, b };
}
function send(chat: Chat, trace: Trace, who: ChatClient, name: string, msg: ChatClientMessage): void {
  trace.step(`${name} sends ${JSON.stringify(msg)}`);
  chat.handle(who, msg);
}
/** A two-turn session through client A: u1 a1 u2 a2. */
async function twoTurns(chat: Chat, trace: Trace, a: ChatClient): Promise<void> {
  send(chat, trace, a, "A", { type: "prompt", text: "one", clientId: "c-one" });
  await idle(chat);
  send(chat, trace, a, "A", { type: "prompt", text: "two", clientId: "c-two" });
  await idle(chat);
}
const userIds = (path: string) => entriesOf(path).filter((e) => e.type === "message" && e.message.role === "user").map((e) => e.id as string);
const assistantIds = (path: string) => entriesOf(path).filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.id as string);
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The compaction fixture for one scenario: its handler's calls go into the trace where pi makes them,
    and it writes a fixed tokensBefore. `reset` puts it back for the next scenario. */
function compaction(trace: Trace, summary: string): { fixture: ReturnType<typeof compactFixture>; reset(): void } {
  const fixture = compactFixture();
  fixture.summary = summary;
  fixture.tokensBefore = 1234;
  fixture.onCall = ({ tokensBefore: _t, ...seen }) => trace.got("compaction handler", seen);
  return {
    fixture,
    reset: () => {
      fixture.hold = undefined;
      fixture.onCall = undefined;
      fixture.tokensBefore = undefined;
    },
  };
}

// ---- S1-S9, S12-S15: a plain web session --------------------------------------------------------------

test("S1: a message-less session with a recorded model: open/attach/dispose writes nothing; the first prompt flushes the open appends", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const at = "2026-10-01T00:00:01.000Z";
  const path = sessionFile([{ type: "model_change", id: "a1000001", parentId: null, timestamp: at, provider: "scripted", modelId: "scripted" }]);
  const before = readFileSync(path);
  let chat = await open(path, model, trace);
  const first = attachBoth(chat, trace);
  trace.step("detach A, B; dispose");
  chat.detach(first.a);
  chat.detach(first.b);
  await disposeHeldChat(path, "golden");
  assert.ok(readFileSync(path).equals(before), "open, attach and dispose leave the file byte-identical");
  trace.step("reopen");
  chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  send(chat, trace, a, "A", { type: "prompt", text: "hello", clientId: "c1" });
  await idle(chat);
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S1-open-first-prompt", [path], trace);
});

test("S2: two steers mid-turn (one image-only): Sova's queue, one item in the SDK at a time, nothing stranded", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  const release = model.hold();
  send(chat, trace, a, "A", { type: "prompt", text: "work", clientId: "c1" });
  await until(() => model.calls.length === 1, "the first model call");
  send(chat, trace, a, "A", { type: "steer", text: "steer one", clientId: "c2" });
  send(chat, trace, b, "B", { type: "steer", text: "", images: [{ data: PNG, mimeType: "image/png" }], clientId: "c3" });
  await until(() => trace.has('sdk steer ["steer one"'), "the first steer's hand-off");
  trace.step("release the reply");
  release();
  await idle(chat);
  trace.got("model calls", model.calls.length);
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S2-steer-mid-turn", [path], trace);
});

test("S3: three follow-ups mid-turn, the middle one removed while queued", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  const release = model.hold();
  send(chat, trace, a, "A", { type: "prompt", text: "work", clientId: "c1" });
  await until(() => model.calls.length === 1, "the first model call");
  send(chat, trace, a, "A", { type: "prompt", text: "follow one", clientId: "f1" });
  send(chat, trace, a, "A", { type: "prompt", text: "follow two", clientId: "f2" });
  send(chat, trace, b, "B", { type: "prompt", text: "follow three", clientId: "f3" });
  await until(() => trace.has('sdk prompt ["follow one"'), "the first follow-up's hand-off");
  send(chat, trace, b, "B", { type: "queue_remove", id: "rm1", itemId: "f2" });
  await until(() => trace.has('"queue_removed"') || trace.has('"queue_remove_refused"'), "the removal's answer");
  trace.step("release the reply");
  release();
  await idle(chat);
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S3-follow-up-queue", [path], trace);
});

test("S4: Stop with a steer and a follow-up queued: queue_cleared, clearQueue then abort", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  const release = model.hold();
  send(chat, trace, a, "A", { type: "prompt", text: "work", clientId: "c1" });
  await until(() => model.calls.length === 1, "the first model call");
  send(chat, trace, a, "A", { type: "steer", text: "steer one", clientId: "s1" });
  send(chat, trace, b, "B", { type: "prompt", text: "follow one", clientId: "f1" });
  await until(() => trace.has('sdk steer ["steer one"'), "the steer's hand-off");
  send(chat, trace, b, "B", { type: "abort" });
  await until(() => !piSession(chat).isStreaming, "the run to stop");
  release();
  await idle(chat);
  trace.got("model calls", model.calls.map((c) => ({ n: c.n, aborted: c.aborted })));
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S4-abort", [path], trace);
});

test("S5: rewind to the second input, then reopen: navigate, flush, marker; the leaf held on reopen", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  let chat = await open(path, model, trace);
  let { a, b } = attachBoth(chat, trace);
  await twoTurns(chat, trace, a);
  const u2 = userIds(path)[1]!;
  send(chat, trace, a, "A", { type: "rewind", id: "r1", entryId: u2 });
  await until(() => trace.has('"rewound"') || trace.has('"rewind_refused"'), "the rewind's answer");
  await ticks();
  chat.detach(a);
  chat.detach(b);
  trace.step("dispose; reopen");
  await disposeHeldChat(path, "golden");
  chat = await open(path, model, trace);
  ({ a, b } = attachBoth(chat, trace));
  trace.got("leaf", piSession(chat).sessionManager.getLeafId());
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S5-rewind", [path], trace);
});

test("S6: regenerate from the second reply's block id: resolve, rewind with its marker, then the replay", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  await twoTurns(chat, trace, a);
  model.reply({ text: "again" });
  send(chat, trace, b, "B", { type: "regenerate", id: "g1", entryId: `${assistantIds(path)[1]}:0` });
  await until(() => trace.has('"regenerated"') || trace.has('"regenerate_refused"'), "the regenerate's answer");
  await until(() => model.calls.length === 3, "the replayed turn");
  await idle(chat);
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S6-regenerate", [path], trace);
});

test("S7: /compact with instructions while a send arrives during the summary: held, then its turn after the hello", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  await twoTurns(chat, trace, a);
  const { fixture, reset } = compaction(trace, "Two greetings.");
  let release!: () => void;
  fixture.hold = new Promise<void>((r) => (release = r));
  const seen = fixture.seen.length;
  send(chat, trace, a, "A", { type: "prompt", text: "/compact keep x", clientId: "k1" });
  await until(() => fixture.seen.length === seen + 1, "the compaction handler");
  send(chat, trace, b, "B", { type: "prompt", text: "during", clientId: "c3" });
  trace.step("release the summary");
  fixture.hold = undefined;
  release();
  await until(() => trace.has('"compacted"') || trace.has('"compact_refused"'), "the compaction's answer");
  await until(() => model.calls.length === 3, "the held turn");
  await idle(chat);
  reset();
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S7-compact-manual", [path], trace);
});

test("S8: pi's threshold compaction after a reply near the window, with a follow-up held meanwhile", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  send(chat, trace, a, "A", { type: "prompt", text: "one", clientId: "c1" });
  await idle(chat);
  const { fixture, reset } = compaction(trace, "One turn, then a big one.");
  const seen = fixture.seen.length;
  const release = model.hold();
  model.reply({ text: "big", usage: { input: 90_000, totalTokens: 90_000 } });
  send(chat, trace, a, "A", { type: "prompt", text: "two", clientId: "c2" });
  await until(() => model.calls.length === 2, "the second model call");
  send(chat, trace, b, "B", { type: "prompt", text: "after", clientId: "c3" });
  await until(() => trace.has('sdk prompt ["after"'), "the follow-up's hand-off");
  trace.step("release the reply");
  release();
  await until(() => fixture.seen.length === seen + 1, "the automatic compaction");
  await idle(chat);
  reset();
  trace.got("model calls", model.calls.length);
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S8-compact-auto", [path], trace);
});

test("S9: a prompt made inside agent_settled is deferred into the previous run; its error surfaces there; a topic batch then is busy", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  let fired = false;
  // After Sova's own listeners (subscribed at bind), as a later subscriber is.
  const off = piSession(chat).subscribe((event) => {
    if (event.type !== "agent_settled" || fired) return;
    fired = true;
    send(chat, trace, b, "B", { type: "prompt", text: "in the settle", clientId: "c2" });
    trace.got(
      "deliverTopicBatch",
      chat.deliverTopicBatch({ text: "[topic golden] a note", topic: "golden", batch: "b1", items: [], entered: () => trace.step("topic entered"), gone: () => trace.step("topic gone") }),
    );
  });
  model.reply({ text: "first" }, { error: "scripted failure" });
  send(chat, trace, a, "A", { type: "prompt", text: "one", clientId: "c1" });
  await until(() => fired, "agent_settled");
  await until(() => model.calls.length >= 2, "the deferred turn");
  await idle(chat);
  off();
  trace.got("model calls", model.calls.length);
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S9-deferred-in-settle", [path], trace);
});

test("S12: link delivery: idle it starts a turn; mid-turn it steers in", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  const release = model.hold();
  trace.got("deliverToAgent idle", chat.deliverToAgent("link one"));
  await until(() => model.calls.length === 1, "the link's turn");
  trace.got("deliverToAgent mid-turn", chat.deliverToAgent("link two"));
  await until(() => trace.has('sdk steer ["link two"'), "the steer");
  trace.step("release the reply");
  release();
  await idle(chat);
  trace.got("model calls", model.calls.length);
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S12-link-delivery", [path], trace);
});

test("S13: extension dialogs: answered from the second tab, by the Overseer, and the fallback when every tab leaves", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  const ask = { toolCall: { name: "golden_ask", arguments: {} } };
  model.reply(ask, ask, ask, { text: "done" });
  send(chat, trace, a, "A", { type: "prompt", text: "ask me", clientId: "c1" });
  await until(() => chat.pendingDialogs().length === 1, "the first dialog");
  send(chat, trace, b, "B", { type: "ui_response", id: chat.pendingDialogs()[0]!.id, value: "Red" });
  await until(() => model.calls.length === 2 && chat.pendingDialogs().length === 1, "the second dialog");
  trace.step("the Overseer answers");
  chat.answerDialog(chat.pendingDialogs()[0]!.id, "Blue", "Blue", "ov-golden");
  await until(() => model.calls.length === 3 && chat.pendingDialogs().length === 1, "the third dialog");
  trace.step("detach A, B");
  chat.detach(a);
  chat.detach(b);
  await idle(chat);
  trace.got("pending dialogs", chat.pendingDialogs().length);
  await disposeHeldChat(path, "golden");
  golden("S13-dialog-bridge", [path], trace);
});

test("S14: set_model and set_thinking idle (flush first, the synthesized thinking row), then refused mid-run", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  send(chat, trace, a, "A", { type: "set_model", ref: "scripted/scripted-think" });
  await until(() => trace.has('"type":"model"') || trace.has('"type":"error"'), "the model switch");
  send(chat, trace, b, "B", { type: "set_thinking", level: "high" });
  send(chat, trace, b, "B", { type: "set_thinking", level: "high" });
  const release = model.hold();
  send(chat, trace, a, "A", { type: "prompt", text: "work", clientId: "c1" });
  await until(() => model.calls.length === 1, "the model call");
  send(chat, trace, a, "A", { type: "set_model", ref: "scripted/scripted" });
  send(chat, trace, b, "B", { type: "set_thinking", level: "low" });
  await until(() => trace.count('"type":"error"') >= 2, "both refusals");
  trace.step("release the reply");
  release();
  await idle(chat);
  // The pristine session's picks became the new-session defaults; later scenarios open on the default.
  trace.got("new-session defaults", loadDefaults());
  rmSync(join(stateRoot(), "defaults.json"), { force: true });
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S14-model-thinking", [path], trace);
});

test("S15: the mode command: a pristine switch and its pin, then a switch mid-turn that applies after it", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const path = sessionFile();
  const chat = await open(path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  trace.step("applyMode normal + align");
  trace.got("applyMode", await chat.applyMode({ ...chat.modeState, mode: "normal", minorModes: ["align"] }));
  await until(() => entriesOf(path).some((e) => e.type === "custom" && e.customType === "mode"), "the extension's mode entry");
  trace.step("pinMode");
  trace.got("pinMode", chat.pinMode());
  await ticks();
  const release = model.hold();
  send(chat, trace, a, "A", { type: "prompt", text: "work", clientId: "c1" });
  await until(() => model.calls.length === 1, "the model call");
  trace.step("switchMode minorModes [] mid-turn");
  const { mode, minorModes, strict, applies } = await chat.switchMode({ minorModes: [] } as never);
  trace.got("switchMode", { mode, minorModes, strict, applies });
  trace.step("release the reply");
  release();
  await idle(chat);
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(path, "golden");
  golden("S15-mode-command", [path], trace);
});

// ---- S10, S11: the special loadouts -------------------------------------------------------------------

const org = await orgs.createOrg({ name: "Golden", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });

test("S10: a baton session: two participant messages queued behind a held reply, then the operator's Stop", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const bob = await orgs.addPerson(org.id, { name: "Bob Golden", role: "Staff" });
  const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: bob.id, publicTitle: "Golden baton", goal: "g" });
  const chat = await open(c.path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  const says = (text: string) => {
    trace.step(`Bob says ${JSON.stringify(text)}`);
    baton.noteMessage(c.sessionId, bob.id);
    void chat.acceptPrompt(text, undefined, "server", undefined, { sentByBaton: { by: bob.id } }).turn.catch(() => {});
  };
  const release = model.hold();
  says("first");
  await until(() => model.calls.length === 1, "the first model call");
  says("second");
  says("third");
  await until(() => trace.has('sdk prompt ["second"'), "the first queued message's hand-off");
  send(chat, trace, a, "A", { type: "abort" });
  await until(() => entriesOf(c.path).filter((e) => e.type === "message" && e.message.role === "user").length >= 3, "the queued messages entered");
  release();
  await idle(chat);
  model.reply({ text: "seen" });
  says("fourth");
  await until(() => model.calls.length === 2, "the next request");
  await idle(chat);
  const ctx = model.calls[1]!.context as { messages: { role: string; content: unknown }[] };
  trace.got(
    "next request's messages",
    ctx.messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map((p) => p.text ?? `<${p.type}>`).join(" ")}`),
  );
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(c.path, "golden");
  golden("S10-baton-stop", [c.path], trace, { [bob.id]: "<BOB>", [org.id]: "<ORG>", [project.id]: "<PROJECT>" });
});

test("S11: the Overseer: the user's message is attended, a server brief is not", async () => {
  const model = new ScriptedModel();
  const trace = new Trace();
  const ov = await overseer.ensureOverseer();
  const chat = await open(ov.path, model, trace);
  const { a, b } = attachBoth(chat, trace);
  const attended = () => {
    trace.got("attended at the model call", overseer.attendedForTest());
  };
  model.reply(attended, attended);
  send(chat, trace, a, "A", { type: "prompt", text: "how are the sessions?", clientId: "c1" });
  await idle(chat);
  trace.step("a server brief");
  await chat.acceptPrompt(`${OVERSEER_BRIEF_PREFIX} a session is waiting`, undefined, "server").turn;
  await idle(chat);
  chat.detach(a);
  chat.detach(b);
  await disposeHeldChat(ov.path, "golden");
  golden("S11-overseer", [ov.path], trace);
});
