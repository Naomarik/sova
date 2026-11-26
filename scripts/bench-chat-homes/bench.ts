// The many-chats bench (§app.chat-homes/change-log): what reading the homes costs with thousands of them. A scratch
// agent dir and homes folder of `homes` chats, each with its records, a conversation and two finished helpers, `active`
// of them not archived (the main run: 150 active of 5,000, a realistic mix; all active is the worst case, for reference), plus stray folders that
// aren't homes; then the costs that grew with every home:
//   check     a second of list activity: the next store read after the 1 s trust ran out
//   newChat   a new chat made and its first record written, then the open-card and open-offer indexes asked
//   listFiles the homed conversation files for a full list build (a page connecting)
//   start     the worker registry's start (every home's helpers)
//   strays    500 "not a home" names asked about again
//   sweep     the 5-minute backstop sweep of the records (only where it exists)
// Imports only APIs the code before the change log had too, so the same file measures both (the I/O counters only
// where they exist). Run it with scripts/bench-chat-homes/run.ts; the landing check is
// server/chat-homes/scale.integration.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HomesBench {
  homes: number;
  active: number;
  sweepMs?: number;
  seedMs: number;
  firstLoadMs: number;
  checkMs: number;
  newChatMs: number;
  listFilesMs: number;
  startMs: number;
  straysMs: number;
  /** Only where the change log exists. */
  io?: { checkStats: number; newChatFolders: number; newChatFull: number; listReaddirs: number; strayManifestReads: number; sweepStats: number };
}

const id = (n: number) => `019a${n.toString(16).padStart(4, "0")}-0000-7000-8000-${String(n).padStart(12, "0")}`;
const avg = async (n: number, fn: (i: number) => unknown): Promise<number> => {
  const t = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  return (performance.now() - t) / n;
};

export async function benchHomes(o: { homes: number; active?: number; scratch?: string }): Promise<HomesBench> {
  const active = Math.min(o.active ?? o.homes, o.homes);
  const scratch = o.scratch ?? mkdtempSync(join(tmpdir(), "sova-homes-bench-"));
  const agent = join(scratch, "agent");
  const homes = join(scratch, "homes");
  const state = join(agent, "sova");
  // Everything Sova reads its places from points into the scratch folder (a chat process's own env names real ones).
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.SOVA_CHAT_STATE_ROOT = state;
  process.env.SOVA_CHAT_HOMES = homes;
  delete process.env.SOVA_CHAT_HOMES_ROOT;
  delete process.env.SOVA_CHAT_HOME;
  mkdirSync(state, { recursive: true });
  mkdirSync(join(agent, "sessions"), { recursive: true });

  let t = performance.now();
  for (let i = 0; i < o.homes; i++) {
    const sid = id(i);
    const home = join(homes, sid);
    mkdirSync(join(home, "sessions"), { recursive: true });
    mkdirSync(join(home, "chat"), { recursive: true });
    mkdirSync(join(home, "workers"), { recursive: true });
    writeFileSync(join(home, "home.json"), JSON.stringify({ v: 1, id: sid, stateRoot: state, layout: 1, device: { id: "bench", name: "bench" }, createdAt: "2026-11-01T00:00:00.000Z" }));
    const archived = i >= active;
    writeFileSync(join(home, "chat", "meta.json"), JSON.stringify({ version: 1, id: sid, "session-titles.json#titles": { [sid]: { title: `Chat ${i}`, by: "user", at: 1 } }, ...(archived ? { "archived-sessions.json": [sid] } : {}) }));
    writeFileSync(join(home, "chat", "seen.json"), JSON.stringify({ version: 1, id: sid, "seen.json": { [sid]: 1000 + i } }));
    const conv = join(home, "sessions", `2026-11-01T00-00-00-000Z_${sid}.jsonl`);
    writeFileSync(conv, `${JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-11-01T00:00:00.000Z", cwd: scratch })}\n`);
    for (const w of [1, 2]) {
      const hid = `${sid.slice(0, -2)}${String(w).padStart(2, "0")}`.replace(/^019a/, "019b");
      const rec = { v: 1, chatId: hid, path: join(home, "sessions", `x_${hid}.jsonl`), key: `${sid}:ag_0${w}:1`, kind: "worker", parent: { sessionId: sid, path: conv, workerId: `ag_0${w}` }, spec: { kind: "worker", parent: { sessionId: sid, path: conv, workerId: `ag_0${w}` }, cwd: scratch }, state: "ended", startedAt: "2026-11-01T00:00:00.000Z", ended: { cause: "done", at: "2026-11-01T00:01:00.000Z" } };
      writeFileSync(join(home, "workers", `${hid}.json`), JSON.stringify(rec));
    }
  }
  const strays: string[] = [];
  for (let i = 0; i < 500; i++) {
    const s = `019c0000-0000-7000-8000-${String(i).padStart(12, "0")}`;
    mkdirSync(join(homes, s), { recursive: true });
    strays.push(s);
  }
  const seedMs = performance.now() - t;

  const root = await import("../../server/chat-homes/root");
  const records = await import("../../server/chat-homes/records");
  const { markSeen } = await import("../../server/seen");
  const { listSessionFiles } = await import("../../server/sessions-index");
  const { WorkerRegistry } = await import("../../server/chat-workers");
  const { openCardsOf } = await import("../../server/transcript-cards");
  const { openOfferOf } = await import("../../server/session-offers");
  const r = records as Record<string, unknown> & typeof records;
  const rootX = root as Record<string, unknown>;
  const recordsIo = r.recordsIo as { stats: number } | undefined;
  const openIndexIo = ((await import("../../server/chat-homes/open-index").catch(() => ({}))) as { openIndexIo?: { full: number; homes: number; readdirs: number } }).openIndexIo;
  const sessionFilesIo = ((await import("../../server/chat-homes/session-files").catch(() => ({}))) as { sessionFilesIo?: { readdirs: number } }).sessionFilesIo;
  const homeIo = rootX.homeIo as { manifestReads: number } | undefined;

  t = performance.now();
  const procs = { start: async () => { throw new Error("no process in the bench"); }, stop: async () => {} };
  new WorkerRegistry(procs as never);
  const startMs = performance.now() - t;

  t = performance.now();
  records.homesGeneration();
  const firstLoadMs = performance.now() - t;

  // Warm: the indexes read whole once.
  openCardsOf(id(1));
  openOfferOf(id(1));
  await listSessionFiles();

  const s0 = recordsIo?.stats ?? 0;
  const checkMs = await avg(20, () => {
    records.expireHomeRecordChecksForTest();
    return records.homesGeneration();
  });
  const checkStats = Math.round(((recordsIo?.stats ?? 0) - s0) / 20);

  const f0 = (openIndexIo?.readdirs ?? 0) + 0;
  const full0 = openIndexIo?.full ?? 0;
  const newChatMs = await avg(10, (i) => {
    const sid = `019d0000-0000-7000-8000-${String(i).padStart(12, "0")}`;
    root.ensureChatHome(sid);
    markSeen(sid, Date.now());
    openCardsOf(id(1));
    openOfferOf(id(1));
  });
  const newChatFolders = Math.round(((openIndexIo?.readdirs ?? 0) - f0) / 10);
  const newChatFull = (openIndexIo?.full ?? 0) - full0;

  // Every folder aged past the racy-stat guard is what a list a while later sees; a just-written one is read again.
  await new Promise((res) => setTimeout(res, 2100));
  await listSessionFiles();
  const l0 = sessionFilesIo?.readdirs ?? 0;
  const listFilesMs = await avg(5, () => listSessionFiles());
  const listReaddirs = Math.round(((sessionFilesIo?.readdirs ?? 0) - l0) / 5);

  for (const s of strays) root.hasHome(s);
  const m0 = homeIo?.manifestReads ?? 0;
  const straysMs = await avg(10, () => {
    for (const s of strays) root.hasHome(s);
  });
  const strayManifestReads = Math.round(((homeIo?.manifestReads ?? 0) - m0) / 10);

  let sweepMs: number | undefined;
  let sweepStats = 0;
  const expireSweep = r.expireHomeRecordSweepForTest as (() => void) | undefined;
  if (expireSweep && recordsIo) {
    const w0 = recordsIo.stats;
    sweepMs = await avg(5, () => {
      expireSweep();
      return records.homesGeneration();
    });
    sweepStats = Math.round((recordsIo.stats - w0) / 5);
  }

  if (!o.scratch) rmSync(scratch, { recursive: true, force: true });
  const out: HomesBench = { homes: o.homes, active, seedMs, firstLoadMs, checkMs, newChatMs, listFilesMs, startMs, straysMs, ...(sweepMs !== undefined ? { sweepMs } : {}) };
  if (recordsIo) out.io = { checkStats, newChatFolders, newChatFull, listReaddirs, strayManifestReads, sweepStats };
  return out;
}
