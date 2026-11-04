// A host for stall-recorder.integration.test.ts: a process with the real recorder, told by its
// environment what to do. It reports on stdout, one JSON line at a time.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opEnd, opNote, opStart, opTrack, publishStallFigures, stallGauge, stallRecorderStatus, startStallRecorder } from "./stall-recorder";

const dir = process.env.FIXTURE_DIR!;
const mode = process.env.FIXTURE_MODE!;
const release = join(dir, "release");
const say = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
const until = async (ok: () => boolean) => {
  while (!ok()) await new Promise((r) => setTimeout(r, 10));
};
const quick = { beatMs: 100, stallMs: 400, tickMs: 100, drainMs: 500 };

/** Holds the loop until the test says so: what a long synchronous build does. Never yields. */
function blockTheLoopForTest(): number {
  let spins = 0;
  while (!existsSync(release)) spins++;
  return spins;
}

if (mode === "block") {
  startStallRecorder({ dir, ...quick });
  stallGauge("fixture rows", () => 2706);
  publishStallFigures(process.memoryUsage());
  await until(() => stallRecorderStatus().state === "on");
  await new Promise((r) => setTimeout(r, 400)); // the sampler's start is asynchronous
  opTrack("finished before", () => 1);
  opNote("small read", 1000);
  opNote("large read", 4 * 1024 * 1024);
  const op = opStart("GET /api/fixture/:id", 42);
  say({ blocking: true });
  blockTheLoopForTest();
  opEnd(op);
  await until(() => stallRecorderStatus().recent.some((r) => r.kind === "stall"));
  say({ status: stallRecorderStatus() });
  process.exit(0);
}

if (mode === "memory") {
  startStallRecorder({ dir, ...quick, memoryFirstBytes: process.memoryUsage.rss() + 96 * 1024 * 1024 });
  await new Promise((r) => setTimeout(r, 400));
  const keep: Buffer[] = [];
  say({ allocating: true });
  function allocateForTest() {
    keep.push(Buffer.alloc(16 * 1024 * 1024, 1));
  }
  // A climb the watchdog can follow a rung at a time: a tick is 100 ms, the two rungs at least 96 MB apart.
  while (!existsSync(release)) {
    allocateForTest();
    await new Promise((r) => setTimeout(r, 30));
    keep.length = Math.min(keep.length, 48);
  }
  process.exit(0);
}

// A host whose recorder fails: it must go on as if there were none.
if (mode === "failing") {
  const workerUrl = process.env.FIXTURE_WORKER ? new URL(process.env.FIXTURE_WORKER, import.meta.url) : undefined;
  startStallRecorder({ dir: process.env.FIXTURE_LOG_DIR ?? dir, ...quick, ...(workerUrl ? { workerUrl } : {}) });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const op = opStart("before");
  const want = process.env.FIXTURE_WANT_STATE;
  // Once the recorder has failed (or, wanting nothing, some while on), the host must still run.
  await until(() => ticks >= 50 && (!want || stallRecorderStatus().state === want));
  opEnd(op);
  opEnd(opStart("after"));
  opNote("x", 1);
  publishStallFigures(process.memoryUsage());
  opTrack("after too", () => 1);
  clearInterval(timer);
  say({ ticks, state: stallRecorderStatus().state });
  writeFileSync(join(dir, "finished"), "yes");
  process.exit(0);
}
