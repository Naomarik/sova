// Records fixtures/faux/<scenario>/{session.jsonl,events.json}: genuine pi sessions and event streams, made by
// a real AgentSession on the pinned pi (or PI_PACKAGE_DIR's) driven by pi-ai's faux provider in a temp agent
// dir: no network, no model calls. Run it with `node scripts/harness-golden/faux-record.mjs [--out <dir>]`,
// never from pnpm test. Two runs give byte-identical files: the process runs on a fake clock (each Date.now()
// or new Date() is 1 ms after the last, from the same start for every scenario), the faux provider streams
// fixed-size chunks with scripted response ids and tool-call ids, and what pi still mints at random (entry
// ids, the session id) and the run's paths are renumbered by `normalize` into same-length placeholders,
// consistently across a scenario's session.jsonl and events.json. Not two at once: every run uses RUN_ROOT.
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPi } from "../../testing/load-pi.ts";

/** The fake clock, installed before pi loads: real time would collapse two entries into one ms in one run
    and not the next. */
const CLOCK_START = Date.parse("2026-09-03T08:00:00.000Z");
let fakeNow = CLOCK_START;
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super((fakeNow += 1));
    else super(...(args as [string]));
  }
  static override now(): number {
    return (fakeNow += 1);
  }
}
globalThis.Date = FakeDate as DateConstructor;

const pi = await loadPi();
// pi's prompt names its own package dir (getPackageDir() reads PI_PACKAGE_DIR at each call; package.json was
// read at load), and faux estimates usage from the prompt's length: a fixed path keeps both machine-free.
process.env.PI_PACKAGE_DIR = "/golden-pi";
/** Every scenario runs here (fixed, so the prompt's cwd and the usage it gives are too); emptied before each. */
const RUN_ROOT = "/tmp/sova-faux-golden";
const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = pi.agent;
const { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } = pi.ai;

/** Every scripted time: a fixed clock the responses carry, so the provider's own stamps never vary. */
const CLOCK0 = Date.parse("2026-09-02T12:00:00.000Z");
let clock = CLOCK0;
const at = () => (clock += 1000);
const reply = (content: unknown, opts: Record<string, unknown> = {}) => fauxAssistantMessage(content, { responseId: `faux-resp-${(clock - CLOCK0) / 1000}`, timestamp: at(), ...opts });

/** A solid PNG of w×h (RGB), small once deflated: big enough that pi resizes it and writes its notes. */
function png(w: number, h: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([40, 120, 200], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

interface Run {
  session: any;
  faux: ReturnType<typeof createFauxCore>;
  /** Each event's JSON, taken as it was emitted (eventJson). */
  events: string[];
  cwd: string;
}

/** A file-backed session on the faux provider (builtin tools on), recording every event in order. */
async function open(agentDir: string, name: string): Promise<Run> {
  const faux = createFauxCore({ api: "faux-golden", provider: "faux", models: [{ id: "faux-1", input: ["text", "image"], reasoning: true }], tokenSize: { min: 4, max: 4 } });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("faux", {
    name: "Faux",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "stub",
    api: faux.api,
    streamSimple: faux.streamSimple,
    models: [{ id: "faux-1", name: "Faux 1", input: ["text", "image"], reasoning: true, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 200_000, maxTokens: 4_000 }],
  } as never);
  const cwd = join(agentDir, "cwd", name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "notes.txt"), "line one\nline two\n");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel("faux", "faux-1"),
    sessionManager: SessionManager.create(cwd, join(agentDir, "sessions", name)),
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off", retry: { baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } } as never),
  });
  const events: string[] = [];
  session.subscribe((e: unknown) => void events.push(eventJson(e)));
  return { session, faux, events, cwd };
}

/** The scenarios (harness-v2-b §2.5, G0b). Each leaves its session idle. */
const SCENARIOS: Record<string, (r: Run) => Promise<void>> = {
  plain: async ({ session, faux }) => {
    faux.setResponses([reply("Hello there. How can I help?")]);
    await session.prompt("hello");
    await session.waitForIdle();
  },
  thinking: async ({ session, faux }) => {
    faux.setResponses([reply([fauxThinking("The user wants a short answer."), fauxText("Short answer: yes.")])]);
    await session.prompt("Can you think first?");
    await session.waitForIdle();
  },
  "tool-read": async ({ session, faux }) => {
    faux.setResponses([reply([fauxText("Reading it."), fauxToolCall("read", { path: "notes.txt" }, { id: "call_read_1" })], { stopReason: "toolUse" }), reply("It has two lines.")]);
    await session.prompt("What is in notes.txt?");
    await session.waitForIdle();
  },
  "error-retry": async ({ session, faux }) => {
    faux.setResponses([reply("", { stopReason: "error", errorMessage: "503 Service Unavailable: the server is overloaded" }), reply("Worked on the retry.")]);
    await session.prompt("Try this");
    await session.waitForIdle();
  },
  abort: async ({ session, faux }) => {
    let aborted = false;
    session.subscribe((e: any) => {
      if (!aborted && e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        aborted = true;
        void session.abort();
      }
    });
    faux.setResponses([reply(`This reply is long enough to be cut off. ${"More words keep coming. ".repeat(40)}`)]);
    await session.prompt("Write a lot");
    await session.waitForIdle();
  },
  compact: async ({ session, faux }) => {
    faux.setResponses([reply("First answer, with some detail to summarize later."), reply("Second answer.")]);
    await session.prompt("First question");
    await session.waitForIdle();
    await session.prompt("Second question");
    await session.waitForIdle();
    faux.setResponses([reply("## Summary\nTwo questions were answered."), reply("## Summary\nTwo questions were answered.")]);
    await session.compact();
  },
  "steer-followup": async ({ session, faux }) => {
    let queued = false;
    session.subscribe((e: any) => {
      if (!queued && e.type === "tool_execution_start") {
        queued = true;
        void session.steer("and also check the second line");
        void session.followUp("then summarize");
      }
    });
    faux.setResponses([
      reply([fauxToolCall("read", { path: "notes.txt" }, { id: "call_read_2" })], { stopReason: "toolUse" }),
      reply("The second line says line two."),
      reply("Summary: two lines."),
    ]);
    await session.prompt("Read notes.txt");
    await session.waitForIdle();
  },
  "image-resize": async ({ session, faux }) => {
    faux.setResponses([reply("A solid blue rectangle.")]);
    await session.prompt("What is this image?", { images: [{ type: "image", data: png(2560, 1600), mimeType: "image/png" }] });
    await session.waitForIdle();
  },
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * `texts` with what pi mints at random replaced, the same way in each: the run's agent dir by `/golden-agent`,
 * entry ids (8 hex, in file order) by `00000001`…, uuids by `00000000-0000-7000-8000-<12 digits>` in order of
 * first appearance. Same length, same order; times need nothing (the fake clock).
 */
export function normalize(texts: string[], ids: readonly string[], agentDir: string): string[] {
  const idMap = new Map<string, string>();
  ids.forEach((id, i) => idMap.set(id, (i + 1).toString(16).padStart(8, "0")));
  const uuids = new Map<string, string>();
  const replaced = texts.map((t) => t.split(agentDir).join("/golden-agent"));
  for (const t of replaced) for (const m of t.matchAll(UUID)) if (!uuids.has(m[0])) uuids.set(m[0], `00000000-0000-7000-8000-${String(uuids.size + 1).padStart(12, "0")}`);
  return replaced.map((t) => t.replace(UUID, (u) => uuids.get(u)!).replace(/"([0-9a-f]{8})"/g, (q, id: string) => (idMap.has(id) ? `"${idMap.get(id)}"` : q)));
}

/**
 * One event `{type, …}` as pi emitted it, serialized at that moment: pi mutates and shares its objects
 * across events (a message_end carries its message_start's message), so a later serialization would show
 * neither. Functions are dropped; only a true cycle (an object inside itself) becomes "[cycle]".
 */
function eventJson(event: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(event, function (this: unknown, _k, x) {
    if (typeof x === "function") return undefined;
    if (x instanceof Error) return { name: x.name, message: x.message };
    if (!x || typeof x !== "object") return x;
    while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(x)) return "[cycle]";
    ancestors.push(x);
    return x;
  });
}

/** The events as the JSON array events.json holds, one event per line. */
const eventLines = (events: readonly string[]): string => `[\n${events.map((e) => `  ${e}`).join(",\n")}\n]\n`;

export async function recordFaux(outDir: string, only?: readonly string[]): Promise<string[]> {
  const written: string[] = [];
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (only?.length && !only.includes(name)) continue;
    const agentDir = join(RUN_ROOT, name);
    rmSync(agentDir, { recursive: true, force: true });
    mkdirSync(agentDir, { recursive: true });
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    fakeNow = CLOCK_START;
    clock = CLOCK0;
    try {
      const r = await open(agentDir, name);
      await run(r);
      const file = r.session.sessionManager.getSessionFile() as string | undefined;
      r.session.dispose();
      if (!file || !existsSync(file)) throw new Error(`${name}: pi wrote no session file`);
      const jsonl = readFileSync(file, "utf8");
      const ids = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l).id as unknown).filter((id): id is string => typeof id === "string" && /^[0-9a-f]{8}$/.test(id));
      const [session, events] = normalize([jsonl, eventLines(r.events)], ids, agentDir);
      const dir = join(outDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "session.jsonl"), session!);
      writeFileSync(join(dir, "events.json"), events!);
      written.push(name);
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
      rmSync(agentDir, { recursive: true, force: true });
    }
  }
  rmSync(RUN_ROOT, { recursive: true, force: true });
  return written;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1]! : join(import.meta.dirname, "../fixtures/faux");
  const only = args.filter((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1));
  const done = await recordFaux(out, only);
  console.log(`[faux] pi ${pi.version}: ${done.join(", ")} → ${out}`);
}
