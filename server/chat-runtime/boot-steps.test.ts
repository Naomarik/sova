// Run: pnpm test -- server/chat-runtime/boot-steps.test.ts. A chat process's start-up trail
// (§app.chat-processes/boot-log) on a fake clock and beat: one summary line per phase, a beat every
// 10 s only while the phase lasts, the stuck step on a stop, child programs read from a fake /proc,
// and no line the supervisor could read as an exit.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FrameOf } from "../../shared/chat-runtime-wire";
import { scratchRoot } from "../test-scratch";
import { BootTrail, childPrograms, childProgramsText, stoppedText } from "./boot-steps";
import { announcedExit, exitOfLog } from "./supervisor";

function rig(phase: "starting" | "opening" = "starting", cpuBefore = 0) {
  let now = 1_000;
  let cpu = cpuBefore;
  const beats: (() => void)[] = [];
  let stopped = 0;
  const lines: string[] = [];
  const sent: FrameOf<"boot">[] = [];
  const trail = new BootTrail({
    phase,
    since: now,
    log: (l) => void lines.push(l),
    send: (f) => void sent.push(f),
    clock: { now: () => now, cpuMs: () => cpu },
    every: (ms, fn) => {
      assert.equal(ms, 10_000, "a beat every 10 s");
      beats.push(fn);
      return () => void stopped++;
    },
  });
  return {
    trail,
    lines,
    sent,
    advance: (ms: number, cpuMs = 0) => {
      now += ms;
      cpu += cpuMs;
    },
    beat: () => beats.forEach((b) => b()),
    stopped: () => stopped,
  };
}

/** Neither of the supervisor's exit readers takes `lines` for an exit. */
function readsAsNoExit(lines: string[]) {
  assert.equal(announcedExit(lines, process.pid), null, lines.join("\n"));
  for (const l of lines) assert.equal(announcedExit([l.replace(/pid \d+/, `pid ${process.pid}`)], process.pid), null, l);
  assert.equal(exitOfLog(lines), null, lines.join("\n"));
}

test("a healthy start leaves one summary line: each step's time, the time before the first, the processor time", () => {
  const r = rig();
  r.advance(50);
  r.trail.step("headless");
  r.advance(10);
  r.trail.step("chat code");
  r.advance(610, 400);
  r.trail.step("model setup");
  r.advance(90);
  r.trail.step("extensions load");
  r.advance(520, 600);
  r.trail.step("extensions start");
  r.advance(150, 100);
  r.trail.finish();
  assert.deepEqual(r.lines, ["[chat-runtime] ready in 1.43 s (headless 0.01 s, chat code 0.61 s, model setup 0.09 s, extensions load 0.52 s, extensions start 0.15 s, other 0.05 s; cpu 1.1 s)"]);
  assert.equal(r.stopped(), 1, "the beat is stopped at ready");
  // After the phase: a step, a beat and a second finish add nothing.
  r.trail.step("late");
  r.beat();
  r.trail.finish();
  assert.equal(r.lines.length, 1);
  assert.equal(r.trail.done, true);
  readsAsNoExit(r.lines);
});

test("each step goes to the server as it is entered, a repeated step once", () => {
  const r = rig();
  r.trail.step("chat code");
  r.trail.step("chat code");
  r.advance(300);
  r.trail.step("model setup");
  assert.deepEqual(r.sent, [
    { t: "boot", phase: "starting", step: "chat code", stepMs: 0, totalMs: 0 },
    { t: "boot", phase: "starting", step: "model setup", stepMs: 0, totalMs: 300 },
  ]);
});

test("a slow phase says where it is at every beat, and only while it lasts; a stop names the step", () => {
  const r = rig();
  r.trail.step("chat code");
  r.advance(1_300, 300);
  r.trail.step("extensions start");
  r.advance(8_700, 100);
  r.beat();
  r.advance(10_000);
  r.beat();
  assert.deepEqual(r.lines, [
    "[chat-runtime] still starting: extensions start for 8.7 s (10.0 s since start, cpu 0.4 s)",
    "[chat-runtime] still starting: extensions start for 18.7 s (20.0 s since start, cpu 0.4 s)",
  ]);
  // Each beat also tells the server.
  assert.deepEqual(r.sent.at(-1), { t: "boot", phase: "starting", step: "extensions start", stepMs: 18_700, totalMs: 20_000 });
  r.advance(19_000, 50);
  const line = stoppedText("SIGTERM", r.trail, [{ pid: 4242, name: "claude", upMs: 38_200 }]);
  assert.equal(line, "[chat-runtime] SIGTERM while starting: stuck in extensions start for 37.7 s (39.0 s since start, cpu 0.5 s); child programs: claude pid 4242 up 38 s");
  r.trail.finish(false);
  r.beat();
  assert.equal(r.lines.length, 2, "a failed phase logs no summary, and no beat after it");
  readsAsNoExit([...r.lines, line]);
});

test("an open's trail: its own lines, its own processor time", () => {
  const r = rig("opening", 500); // 0.5 s before the open: not the open's
  const t = new BootTrail({ phase: "opening", since: 0, log: () => {}, clock: { now: () => 0, cpuMs: () => 0 }, every: () => () => {} });
  assert.equal(t.stuckText(), "no step yet (0.0 s since open, cpu 0.0 s)");
  r.trail.step("open file");
  r.advance(10_000, 200);
  r.beat();
  assert.deepEqual(r.lines, ["[chat-runtime] still opening: open file for 10.0 s (10.0 s since open, cpu 0.2 s)"]);
  r.trail.step("extensions start");
  r.advance(500);
  r.trail.finish();
  assert.equal(r.lines[1], "[chat-runtime] opened in 10.50 s (open file 10.00 s, extensions start 0.50 s; cpu 0.2 s)");
  assert.equal(r.sent[0]!.phase, "opening");
  readsAsNoExit(r.lines);
});

const root = scratchRoot("sova-boot-steps-");
after(() => rmSync(root, { recursive: true, force: true }));

test("child programs come from /proc: name without arguments, pid, age; anything unreadable is left out", () => {
  const proc = join(root, "proc");
  const put = (p: string, text: string) => {
    mkdirSync(join(proc, p, ".."), { recursive: true });
    writeFileSync(join(proc, p), text);
  };
  put("uptime", "1000.50 4000.00\n");
  put("77/task/77/children", "101 102 ");
  put("77/task/78/children", "103\n");
  // A program with a secret in its arguments: only its name is kept.
  put("101/cmdline", "/usr/local/bin/claude\0--token\0sk-secret\0");
  put("101/stat", `101 (claude) S 77 ${"0 ".repeat(17)}95050 0 0`);
  // A name with spaces and parens in comm; no command line.
  put("102/cmdline", "");
  put("102/comm", "my (odd) prog\n");
  put("102/stat", `102 (my (odd) prog) S 77 ${"0 ".repeat(17)}100000 0 0`);
  // 103 ended between the reads: no files.
  const kids = childPrograms({ root: proc, pid: 77, platform: "linux" })!;
  assert.deepEqual(kids, [
    { pid: 101, name: "claude", upMs: 50_000 },
    { pid: 102, name: "my__odd__prog", upMs: 500 },
    { pid: 103, name: "?", upMs: null },
  ]);
  const text = childProgramsText(kids);
  assert.equal(text, "; child programs: claude pid 101 up 50 s, my__odd__prog pid 102 up 1 s, ? pid 103");
  assert.doesNotMatch(text, /secret|token/);
  readsAsNoExit([text]);
  // No such process, and not Linux.
  assert.deepEqual(childPrograms({ root: proc, pid: 999, platform: "linux" }), []);
  assert.equal(childPrograms({ root: proc, pid: 77, platform: "darwin" }), null);
  assert.equal(childProgramsText(null), "");
  assert.equal(childProgramsText([]), "; no child programs");
});
