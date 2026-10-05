// The usage helper child process (§app.insights/usage-ledger). Started by the server
// (server/usage-helper/client.ts) with the server's own runtime; never imports the pi SDK.
//
//   <runtime> server/usage-helper/main.ts        (PI_CODING_AGENT_DIR names the agent dir)
//
// stdin: one JSON request per line, `{"id": <n>, "op": "...", ...}`.
// stdout: one frame per answer, `<id> <status> <byte length>\n` then that many bytes of JSON, so
// the server finds an answer's end without parsing it. stderr: log lines.
// At start it catches up every day directory and every file past its saved offset, then follows
// appends (fs.watch on the root and the recent days, a sweep every 30 s for anything missed), saves
// its snapshots every few seconds, closes days, and pulls prices every 6 hours. stdin closing (the
// server gone) or SIGTERM saves and exits.
import fs from "node:fs";
import path from "node:path";
import { defaultAgentDir, readDeviceId, usageRoot as usageRootOf, validUsageDay } from "../../pi-config/extensions/llm-inflight/usage-record";
import { BadRequest, createService } from "./service";

const SAVE_MS = 3_000;
const SWEEP_MS = 30_000;
const CLOSE_MS = 60_000;
const RELOAD_MS = 5_000;
const SETTLE_MS = 100;

const agentDir = defaultAgentDir();
const usageRoot = usageRootOf(agentDir);
const stateRoot = path.join(agentDir, "sova");
const log = (line: string) => process.stderr.write(`[usage-helper] ${line}\n`);

fs.mkdirSync(usageRoot, { recursive: true });
const t0 = performance.now();
const svc = createService({
  usageRoot,
  stateDir: path.join(stateRoot, "usage-ledger"),
  pricesPath: path.join(stateRoot, "model-prices.json"),
  device: () => readDeviceId(agentDir),
  log,
});
const { ledger, prices } = svc;
ledger.scanAll();
ledger.indexAll();
ledger.closeDays();
ledger.flush();
// The catch-up's garbage, returned before following starts.
(globalThis as { Bun?: { gc(sync: boolean): void } }).Bun?.gc(true);
log(`caught up in ${Math.round(performance.now() - t0)} ms: ${ledger.stats.records} records, ${ledger.dayNames().length} days`);

// ---- following appends ------------------------------------------------------------------------

/** Files an event named, per day, not yet read. */
const pending = new Map<string, Set<string>>();
let settle: ReturnType<typeof setTimeout> | null = null;
const drain = () => {
  if (settle) clearTimeout(settle);
  settle = null;
  for (const [day, files] of pending) {
    pending.delete(day);
    ledger.scanDay(day, files);
  }
};
const touched = (day: string, file: string | null) => {
  let set = pending.get(day);
  if (!set) pending.set(day, (set = new Set()));
  if (file) set.add(file);
  settle ??= setTimeout(drain, SETTLE_MS);
};

const watchers = new Map<string, fs.FSWatcher>();
const watchDay = (day: string) => {
  if (watchers.has(day)) return;
  try {
    const w = fs.watch(path.join(usageRoot, day), (_e, name) => {
      if (name) touched(day, name.toString());
      else ledger.scanDay(day);
    });
    w.on("error", () => watchers.delete(day));
    watchers.set(day, w);
  } catch {
    // Not there yet: the root's watcher or the sweep finds it.
  }
};
/**
 * Writers append to today's directory (UTC) and, around midnight, yesterday's: those, and the two
 * newest directories there are (a host whose clock disagrees with a writer's still follows it live).
 */
const recentDays = () => {
  const now = Date.now();
  const days = new Set([new Date(now - 86_400_000), new Date(now)].map((d) => d.toISOString().slice(0, 10)));
  try {
    for (const d of fs.readdirSync(usageRoot).filter(validUsageDay).sort().slice(-2)) days.add(d);
  } catch {
    // The root is made at start; gone means nothing to follow.
  }
  return [...days];
};
const rewatch = () => {
  const keep = new Set(recentDays());
  for (const [day, w] of watchers) {
    if (keep.has(day)) continue;
    w.close();
    watchers.delete(day);
  }
  for (const day of keep) watchDay(day);
};
fs.watch(usageRoot, (_e, name) => {
  const day = name?.toString();
  if (!day || !validUsageDay(day)) return;
  rewatch();
  watchDay(day);
  ledger.scanDay(day);
});
rewatch();

const timers = [
  setInterval(() => ledger.flush(), SAVE_MS),
  setInterval(() => {
    rewatch();
    for (const day of recentDays()) ledger.scanDay(day);
  }, SWEEP_MS),
  setInterval(() => {
    ledger.scanAll();
    ledger.closeDays();
  }, CLOSE_MS * 10),
  setInterval(() => ledger.closeDays(), CLOSE_MS),
  setInterval(() => prices.reload(), RELOAD_MS),
];
const priceTimer = prices.start();

// ---- requests ---------------------------------------------------------------------------------

const send = (id: number, status: number, body: unknown) => {
  if (exiting) return;
  const bytes = Buffer.from(JSON.stringify(body));
  // Backpressure: while the server isn't reading answers, stop reading requests, so neither side
  // queues without bound (the requests wait in the kernel's pipe).
  if (!process.stdout.write(Buffer.concat([Buffer.from(`${id} ${status} ${bytes.length}\n`), bytes])) && !paused) {
    paused = true;
    process.stdin.pause();
    process.stdout.once("drain", () => {
      paused = false;
      process.stdin.resume();
    });
  }
};
let paused = false;
// Nobody reads the answers any more (the server's end closed): stop, never queue them.
process.stdout.on("error", () => exit());

const handle = async (line: string) => {
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = typeof req.id === "number" ? req.id : 0;
  try {
    // An answer is current to the last append the watcher saw.
    drain();
    send(id, 200, await svc.answer(req));
  } catch (err) {
    if (err instanceof BadRequest) send(id, 400, { error: err.message });
    else {
      log(`${String(req.op)} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      send(id, 500, { error: "usage-helper-failed" });
    }
  }
};

// A request is one short line. Input that never ends a line (a wrong stdin, /dev/zero) is never
// buffered without bound: only the new chunk is searched, and a line over 1 MB means whatever is on
// stdin isn't the server, so the helper stops.
const MAX_LINE = 1024 * 1024;
let buf = "";
let dropping = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  let start = 0;
  let nl: number;
  while ((nl = chunk.indexOf("\n", start)) >= 0) {
    const line = dropping ? "" : buf + chunk.slice(start, nl);
    buf = "";
    dropping = false;
    start = nl + 1;
    if (line) void handle(line);
  }
  if (dropping) return;
  buf += chunk.slice(start);
  if (buf.length > MAX_LINE) {
    log("stdin sent a line over 1 MB: not the server; exiting");
    buf = "";
    dropping = true;
    exit();
  }
});

let exiting = false;
const exit = () => {
  if (exiting) return;
  exiting = true;
  for (const t of timers) clearInterval(t);
  priceTimer.stop();
  try {
    drain();
    ledger.flush();
  } finally {
    process.exit(0);
  }
};
process.stdin.on("end", exit);
process.on("SIGTERM", exit);
process.on("SIGINT", exit);
