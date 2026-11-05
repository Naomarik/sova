// The modes recorder (al_1 a2/a6): what a chat's or a worker's model sees of its modes, recorded from
// real chats in this process (the chat manager, the real pi runtime, a scripted model), and compared byte
// for byte with server/modes/golden/cases/<case>.json (store.fixture.ts; big values in golden/store/). The recordings were taken at master
// 659c8dcd6, with the pi-config mode extension running every mode (today's behaviour); the same cases
// run again with the switch off (the extension) and on (Sova's engine) and must give the same bytes.
//
// What one recording holds, per step of a case: every model call the step made, as the messages pi sent
// (system messages with their sections and tool lists in order, hidden notes, tool results), stored as a
// diff against the call before (`keep` messages of it, then `add`); the chat's active tools after the
// step, in order; the mode entries the step wrote to the session file (custom `mode`, `mode-head`,
// `mode-project-snapshot`, custom messages `mode-note`, `align-state`, `align-nudge`, …); at a chat's
// open, the extensions it loaded, in order, with the mode slot named `<mode-slot:…>` whichever owner
// fills it. Machine paths and session ids are placeholders (<repo>, <agent>, <ws:…>, <sid:N>);
// timestamps, entry ids and durations are dropped.
//
// Two checks on every request and every chat, whatever the recording says:
// - each mode block's heading (`# Mode: …`, `# Minor mode: …`, `# Project minor mode: …`) appears at most
//   once in the system prompt in effect (assertOnce);
// - the mode slot holds exactly one owner, the one the switch selected (assertOwner): the extension's
//   file with the switch off, Sova's entry module with it on, never both and never the other.
//
// Importing this module sets PI_CODING_AGENT_DIR to a throwaway agent dir first: import it before
// anything that computes its paths (the test files import it dynamically, first).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piSession } from "../../harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson, type ScriptedStep } from "../../harness/pi/testing/scripted-model";
import type { Owner } from "./store.fixture";
export type { Owner };

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// The parent session's own spec variables must not reach a recording (a worker's env names them).
for (const k of Object.keys(process.env)) if (/^(SPEC_AGREE_|SOVA_SPEC_|PI_SPEC_)/.test(k) || /_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

export const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-mg-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsRoot = join(agentDir, "sessions");
mkdirSync(join(sessionsRoot, "live"), { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
// The spec tools, where spec-mode.md's shell line and the census look for them.
mkdirSync(join(agentDir, "extensions"), { recursive: true });
symlinkSync(join(REPO, "pi-config/extensions/spec"), join(agentDir, "extensions/spec"));

/** The extensions every recorded chat loads, as a user's settings list them (the mode extension, then subagents). */
export const CHAT_EXTENSIONS = [join(REPO, "pi-config/extensions/mode"), join(REPO, "pi-config/extensions/subagents")];
/** The settings list for chats started now (the same for either owner: the switch swaps the slot), then `more`. */
export const chatExtensions = (more: string[] = []): string[] => [...CHAT_EXTENSIONS, ...more];
const writeSettings = (more: string[] = [], extra: Record<string, unknown> = {}) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: chatExtensions(more), ...extra }));
let owner: Owner = "extension";
writeSettings();

await import("../../testing/in-process-chats"); // chats open in this process
export const cm = await import("../../chat-manager");
const { markOwned } = await import("../../write-guard");

export type Chat = Awaited<ReturnType<typeof cm.acquireChat>>;

// ── The switch, and who fills the mode slot ───────────────────────────────────────────────────────

/** The Experimental key of "Sova runs chat modes" (cutover's reader: on unless stored `false`). */
export const MODES_FLAG_KEY = "sovaModes";
/** Sova's settings file in this agent dir (server/web-settings.ts reads it). */
const WEB_SETTINGS = join(agentDir, "sova", "settings.json");
/** Select the owner for chats and workers started from now on: the switch written as the user's page would store it. */
export function setOwner(next: Owner): void {
  const was = existsSync(WEB_SETTINGS) ? (JSON.parse(readFileSync(WEB_SETTINGS, "utf8")) as Record<string, unknown>) : { version: 1 };
  const experimental = { ...((was.experimental as Record<string, unknown>) ?? {}), [MODES_FLAG_KEY]: next === "sova" };
  mkdirSync(dirname(WEB_SETTINGS), { recursive: true });
  writeFileSync(WEB_SETTINGS, JSON.stringify({ ...was, experimental }));
  owner = next;
  writeSettings();
}
export const ownerNow = (): Owner => owner;
/** Run `fn` with chats started inside it also loading `more` (after the usual list), and pi settings `extra`. */
export async function withExtensions<T>(more: string[], fn: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
  writeSettings(more, extra);
  try {
    return await fn();
  } finally {
    writeSettings();
  }
}

/** The files that fill a mode slot, by owner: the extension's own, and Sova's entry modules in their place. */
const SLOT_FILES: Record<Owner, RegExp> = {
  extension: /\/pi-config\/extensions\/mode(?:\/(index|spec-worker|project-tools-worker)\.ts)?$/,
  sova: /\/server\/harness\/pi\/modes-(entry|spec-worker|project-tools-worker)\.ts$/,
};
const slotName = (path: string): string | null => {
  for (const re of Object.values(SLOT_FILES)) {
    const m = re.exec(path);
    if (m) return `<mode-slot:${m[1] === "entry" || m[1] === undefined ? "index" : m[1]}>`;
  }
  return null;
};
const MODES_BRIDGE = "<inline:sova-modes-bridge>";
/** The extensions a chat's runtime loaded, in load order (pi's resource loader; inline factories have no path). */
function loadedExtensions(chat: Chat): string[] {
  return piSession(chat)
    .resourceLoader.getExtensions()
    .extensions.map((e) => (e as { resolvedPath?: string }).resolvedPath ?? e.path ?? "<inline>");
}
/**
 * The one-owner rule, per chat and worker: every mode slot it loaded is the selected owner's file, and
 * none is the other owner's. Returns the load order with each slot named, for the recording.
 */
export function assertOwner(chat: Chat, where: string, expectSlot: boolean): string[] {
  const paths = loadedExtensions(chat);
  const other: Owner = owner === "sova" ? "extension" : "sova";
  const mine = paths.filter((p) => SLOT_FILES[owner].test(p));
  const theirs = paths.filter((p) => SLOT_FILES[other].test(p));
  assert.deepEqual(theirs, [], `${where}: with the switch ${owner === "sova" ? "on" : "off"}, ${other === "sova" ? "Sova's engine" : "the mode extension"} must not load (${theirs.join(", ")})`);
  // Each slot once: the mode itself (a chat's, or a worktree-config worker's), the worker census, the worker project tools.
  const kinds = mine.map((p) => slotName(p)!);
  for (const k of new Set(kinds)) assert.equal(kinds.filter((x) => x === k).length, 1, `${where}: ${k} loads twice (${mine.join(", ")})`);
  if (expectSlot) assert.ok(kinds.includes("<mode-slot:index>"), `${where}: the mode slot is ${owner === "sova" ? "Sova's engine" : "the mode extension"} (${paths.join(", ")})`);
  // Never the whole mode beside a worker's census: the worker census is the mode's own hook, not a second owner.
  if (kinds.includes("<mode-slot:index>")) assert.ok(!kinds.includes("<mode-slot:spec-worker>"), `${where}: the mode and the worker census both load (${mine.join(", ")})`);
  // The bridge that hands ChatSession the engine's handle (cutover's, the switch on only) listens on the bus and
  // registers nothing a model sees (the tool and section comparison would show it if it did): not in the load order.
  return paths.filter((p) => p !== MODES_BRIDGE).map((p) => slotName(p) ?? (normalize(p) as string));
}

// ── Runs: each owner's chats in folders and sessions of their own, recorded alike ──────────────────

let run = "extension";
let caseSeq = 0;
/** Start a case in `tag`'s run: fresh numbering, so the same case gives the same names in either run. */
export function beginCase(tag: string): void {
  run = tag;
  caseSeq = 0;
  SHAS.clear();
}

// ── Normalising ───────────────────────────────────────────────────────────────────────────────────

const PLACES: [string, string][] = [];
/** Map a machine path (or id) to a placeholder in every recorded string (longest first). */
export function place(path: string, name: string): void {
  // pi names a session directory after its cwd with every separator a dash (`--tmp-x-y--`).
  const dashed = (p: string) => p.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  for (const p of new Set([path, safeReal(path)])) {
    if (p && !PLACES.some(([q]) => q === p)) PLACES.push([p, name]);
    if (p && p.includes("/") && !PLACES.some(([q]) => q === dashed(p))) PLACES.push([dashed(p), name.replace(/[<>:]/g, "_")]);
  }
  PLACES.sort((a, b) => b[0].length - a[0].length);
}
function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
place(REPO, "<repo>");
// pi's docs section names its package under node_modules, which may be a link into another checkout.
place(join(REPO, "node_modules"), "<repo>/node_modules");
place(agentDir, "<agent>");
place(homedir(), "<home>");

const DROP_KEYS = new Set(["timestamp", "id", "parentId", "durationMs"]);
const MSG_DROP = new Set(["timestamp", "durationMs"]);
/**
 * A sha256 a recording can't hold as is (a project mode snapshot's identity covers its folder's
 * absolute path): `<sha:N>`, numbered by first appearance in the case, so equal ones stay equal.
 * Content hashes over no path (a mode's `toolsHash`) keep their value.
 */
const SHAS = new Map<string, string>();
const SHA_KEEP = new Set(["toolsHash"]);
/** A value as recorded: paths placed, timestamps and ids dropped (message `toolCallId`s are the script's own). */
export function normalize(v: unknown, keyDrop = DROP_KEYS): unknown {
  if (typeof v === "string") {
    let s = v;
    for (const [p, name] of PLACES) s = s.split(p).join(name);
    if (/^[0-9a-f]{64}$/.test(s)) {
      if (!SHAS.has(s)) SHAS.set(s, `<sha:${SHAS.size + 1}>`);
      return SHAS.get(s)!;
    }
    // pi's entry ids are random: a reference to one (`pi-session:<session>#<entry>`) keeps the session only.
    s = s.replace(/(pi-session:[^\s#"]+)#[0-9a-f]{8}\b/g, "$1#<entry>");
    return s.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, "<time>");
  }
  if (Array.isArray(v)) return v.map((x) => normalize(x, keyDrop));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (keyDrop.has(k) || x === undefined) continue;
      out[k] = SHA_KEEP.has(k) ? x : normalize(x, keyDrop);
    }
    return out;
  }
  return v;
}

// ── The mode headers, for the once-only checks ───────────────────────────────────────────────────

/** Every mode block's heading line: `# Mode: delegate|create`, `# Minor mode: <id>`, `# Project minor mode: <id>`. */
export const HEADER = /^# (?:Mode: [a-z]+|Minor mode: [a-z]+|Project minor mode: [a-z0-9-]+)$/gm;
/**
 * The system prompt a request is in effect under: its system messages replayed as pi-ai's
 * getCurrentSystemMessage does (later `content` appended, `sections` patched by name, null deletes),
 * as text. A section patch (a major switch re-sends `mode`) replaces the earlier one, so it never counts twice.
 */
export function systemText(messages: readonly unknown[]): string {
  const content: string[] = [];
  const sections = new Map<string, string>();
  for (const m of messages as { role?: string; content?: unknown; sections?: Record<string, string | null> }[]) {
    if (m.role !== "system") continue;
    if (typeof m.content === "string") {
      if (m.content) content.push(m.content);
    } else if (Array.isArray(m.content)) {
      const text = (m.content as { type?: string; text?: string }[]).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
      if (text) content.push(text);
    }
    for (const [name, value] of Object.entries(m.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [...content, ...sections.values()].join("\n");
}
/** Each mode heading's count in a request's system prompt. */
export function headerCounts(messages: readonly unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of systemText(messages).matchAll(HEADER)) out[m[0]] = (out[m[0]] ?? 0) + 1;
  return out;
}
/** Assert no mode block appears twice in the system prompt a request is under (the one-owner rule). */
export function assertOnce(messages: readonly unknown[], where: string): Record<string, number> {
  const counts = headerCounts(messages);
  for (const [h, n] of Object.entries(counts)) assert.equal(n, 1, `${where}: "${h}" appears ${n} times in the system prompt`);
  return counts;
}
/** The tool names a request declares, in order (pi-ai's getCurrentTools fold). */
export function requestTools(messages: readonly unknown[]): string[] {
  const tools = new Map<string, true>();
  for (const m of messages as { role?: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[]) {
    if (m.role !== "system") continue;
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
    for (const t of m.toolsAdded ?? []) tools.set(t.name, true);
  }
  return [...tools.keys()];
}

// ── Sessions and chats ────────────────────────────────────────────────────────────────────────────

export interface Where {
  cwd: string;
  dir: string;
}
/** This run's folder `name` (plain, or a git checkout, made once per run), and its sessions directory. */
export function workspace(name: string, opts: { git?: boolean; files?: Record<string, string> } = {}): Where {
  const cwd = join(agentDir, "ws", run, name);
  const dir = join(sessionsRoot, `--ws-${run}-${name}--`);
  if (!existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
    for (const [rel, text] of Object.entries(opts.files ?? {})) {
      mkdirSync(dirname(join(cwd, rel)), { recursive: true });
      writeFileSync(join(cwd, rel), text);
    }
    if (opts.git) gitInit(cwd);
    mkdirSync(dir, { recursive: true });
    place(cwd, `<ws:${name}>`);
    place(dir, `<sessions:${name}>`);
  }
  return { cwd, dir };
}
function gitInit(cwd: string): void {
  const git = (...args: string[]) => {
    // Fixed dates: the same files give the same commit in every run (the census names the base commit).
    const when = "2026-10-06T00:00:00Z";
    const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8", env });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "master");
  git("add", "-A");
  git("commit", "-qm", "base", "--allow-empty");
}

const RUN_DIGITS = new Map<string, number>();
/** Session ids never repeat in one process (each case's numbering restarts): a counter in each tells them apart. */
let fileCounter = 0;
/** A session file with its header and the given entries, owned by this process. Its id is `<sid:N>` in records. */
export function sessionFile(w: Where, entries: unknown[] = []): string {
  const n = ++caseSeq;
  if (!RUN_DIGITS.has(run)) RUN_DIGITS.set(run, RUN_DIGITS.size);
  const id = `01234567-89ab-7cde-8f02-${String(RUN_DIGITS.get(run)).padStart(2, "0")}${(++fileCounter).toString(16).padStart(6, "0")}${String(n).padStart(4, "0")}`;
  const path = join(w.dir, `2026-10-06T00-00-00-000Z_${id}.jsonl`);
  place(id, `<sid:${n}>`);
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-10-06T00:00:00.000Z", cwd: w.cwd }, ...entries];
  writeFileSync(path, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
  markOwned(path);
  return path;
}

/** A `mode` entry pinning a mode state, as Sova writes one (pinEntryFor's shape). */
export const modeEntry = (active: { mode: string; strict: boolean; minorModes: string[] }) => ({
  type: "custom",
  id: "m0",
  parentId: null,
  timestamp: "2026-10-06T00:00:00.000Z",
  customType: "mode",
  data: { mode: active.mode, active: { version: 1, ...active } },
});

export async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const CLIENT = {
  send: (m: { type: string; message?: string }) => {
    if (m.type === "error" && (m as { code?: string }).code !== "reloaded") throw new Error(`chat error: ${m.message}`);
  },
};

/** The mode entry types and custom message types a recording keeps from the session file. */
const KEPT_ENTRY = /^(mode|align|spec|vis|create|memory)/;

/** One step's record. */
export interface StepRecord {
  step: string;
  calls: { keep: number; add: unknown[] }[];
  activeTools: string[];
  entries: unknown[];
  /** The mode headings in the last call's system prompt (once each, asserted). */
  headers?: Record<string, number>;
  /** At a chat's open and reopen: its extensions in load order, the mode slot named. */
  extensions?: string[];
}

/** One recorded chat: drive it with steps; `steps` is its record. */
export class Recorded {
  readonly model = new ScriptedModel();
  readonly steps: StepRecord[] = [];
  private lastMessages: unknown[] = [];
  private seenCalls = 0;
  private seenLines = 0;
  private extensions: string[] | undefined;
  private constructor(
    readonly path: string,
    public chat: Chat,
    private readonly worker: boolean,
  ) {
    this.model.attach(piSession(chat));
    this.seenLines = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    this.extensions = assertOwner(chat, `${worker ? "worker" : "chat"} ${path}`, !worker);
  }

  static async open(path: string, opts: { worker?: boolean } = {}): Promise<Recorded> {
    const chat = await cm.acquireChat(path, opts.worker === true);
    return new Recorded(path, chat, opts.worker === true);
  }

  /** Close the chat and open it again from its file (a reopen), keeping the record going. */
  async reopen(): Promise<void> {
    await this.settle();
    await cm.disposeHeldChat(this.path, "test reopen");
    this.chat = await cm.acquireChat(this.path);
    this.model.attach(piSession(this.chat));
    this.extensions = assertOwner(this.chat, `reopened ${this.path}`, !this.worker);
  }

  async settle(): Promise<void> {
    await until(() => !this.chat.harness.isRunning(), "the run to end");
    await piSession(this.chat).waitForIdle();
  }

  /** Run one step and record what it changed. */
  async step(label: string, fn: (r: this) => Promise<unknown> | unknown): Promise<StepRecord> {
    await fn(this);
    await this.settle();
    const calls: StepRecord["calls"] = [];
    let headers: Record<string, number> | undefined;
    for (const call of this.model.calls.slice(this.seenCalls)) {
      const messages = (call.context as { messages: unknown[] }).messages.map((m) => normalize(m, MSG_DROP));
      try {
        headers = assertOnce(messages, `${label}, call ${call.n}`);
        const specTools = requestTools(messages).filter((t) => t === SPEC_TOOL).length;
        assert.ok(specTools <= 1, `${label}, call ${call.n}: the spec tool is declared ${specTools} times`);
      } catch (err) {
        // SOVA_MODES_DUMP=<dir>: the request that failed, whole, for a look.
        if (process.env.SOVA_MODES_DUMP) writeFileSync(join(process.env.SOVA_MODES_DUMP, `once-${call.n}.json`), JSON.stringify(messages, null, 1));
        throw err;
      }
      let keep = 0;
      while (keep < this.lastMessages.length && keep < messages.length && JSON.stringify(this.lastMessages[keep]) === JSON.stringify(messages[keep])) keep++;
      calls.push({ keep, add: messages.slice(keep) });
      this.lastMessages = messages;
    }
    this.seenCalls = this.model.calls.length;
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    const entries = lines
      .slice(this.seenLines)
      .map((l) => JSON.parse(l) as { type?: string; customType?: string; message?: { role?: string } })
      .filter((e) => ((e.type === "custom" || e.type === "custom_message") && KEPT_ENTRY.test(e.customType ?? "")) || (e.type === "message" && e.message?.role === "system"))
      .map((e) => normalize(e));
    this.seenLines = lines.length;
    const rec: StepRecord = {
      step: label,
      calls,
      activeTools: [...this.chat.harness.activeTools()],
      entries,
      ...(headers ? { headers } : {}),
      ...(this.extensions ? { extensions: this.extensions } : {}),
    };
    this.extensions = undefined;
    this.steps.push(rec);
    return rec;
  }

  /** A prompt from the composer, to its turn's end (a typed `/mode …` included). */
  prompt(text: string, ...replies: ScriptedStep[]): Promise<StepRecord> {
    return this.step(`prompt ${JSON.stringify(text)}`, async () => {
      this.model.reply(...replies);
      if (/^\/mode (normal|delegate|create)$/.test(text)) {
        this.chat.handle(CLIENT, { type: "prompt", text } as never);
        await until(() => this.chat.modeState.mode === text.slice(6), "the typed major switch");
      } else await this.chat.prompt(text);
    });
  }

  /** Sova's `/compact` from the composer, to its end (the scripted model writes the summary). */
  compact(summary: string): Promise<StepRecord> {
    return this.step("compact", async () => {
      this.model.reply({ text: summary });
      let done: string | null = null;
      const client = {
        send: (m: { type: string; message?: string }) => {
          if (m.type === "compacted" || m.type === "compact_refused") done = m.type === "compacted" ? "ok" : `refused: ${m.message}`;
        },
      };
      this.chat.handle(client as never, { type: "prompt", text: "/compact" } as never);
      await until(() => done !== null, "the compaction");
      assert.equal(done, "ok", "the compaction ran");
    });
  }

  /** The mode menu's switch (the web's route), between runs. */
  switch(patch: Record<string, unknown>): Promise<StepRecord> {
    return this.step(`switch ${JSON.stringify(patch)}`, () => this.chat.switchMode(patch as never));
  }

  async dispose(): Promise<void> {
    await this.settle().catch(() => {});
    await cm.disposeHeldChat(this.path, "test done");
  }
}

// ── The intended changes since the recordings (al_1 a1) ───────────────────────────────────────────

/** The coding spec tool (server/spec-coding-tool.ts): new in every chat and worker, not behind the switch. */
export const SPEC_TOOL = "spec";
/** The inline extension that serves it, as a chat's load order names it. */
export const SPEC_TOOL_EXTENSION = "<inline:sova-spec>";
/**
 * The sentences a1 added to what the model reads (spec-mode.md, the worker spec brief), each exact, with
 * the text it follows. The comparison with the recordings drops them; nothing else.
 */
export const A1_SENTENCES = [
  " A `spec` tool, if offered, runs these same reads without a shell.",
  "\nA `spec` tool, if offered, runs the read-only commands (where, map, toc, read, impact) without a shell; its root defaults to your working directory.",
];
/**
 * A record as master would have recorded it, a1's additions taken out: the `spec` tool from every tool
 * list (declared, removed, active), its line in the tools section and its inline extension in the load
 * order; a1's sentences from every string.
 * Applied to both sides of the comparison with the recordings, never to the off/on comparison.
 */
export function withoutA1(v: unknown, key = ""): unknown {
  if (typeof v === "string") {
    let s = v;
    for (const a of A1_SENTENCES) s = s.split(a).join("");
    return key === "tools" ? s.replace(/^- spec: .*\n/m, "") : s;
  }
  if (Array.isArray(v)) {
    const kept =
      key === "activeTools" ? v.filter((x) => x !== SPEC_TOOL)
      : key === "extensions" ? v.filter((x) => x !== SPEC_TOOL_EXTENSION)
      : key === "toolsAdded" || key === "toolsRemoved" ? v.filter((x) => (x as { name?: unknown } | null)?.name !== SPEC_TOOL)
      : v;
    return kept.map((x) => withoutA1(x));
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutA1(x, k)]));
  return v;
}

export { matchRecording } from "./store.fixture";
