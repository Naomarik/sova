import assert from "node:assert/strict";
import { test } from "node:test";
import { SHELL_LIVE_MAX, type ChatServerMessage, type ShellRun } from "../../shared/protocol";
import { AFTER_REPLY, answersAtHello, SHELL_DROPPED, cardOfRow, cardOfRun, nextShellRuns, runShell, shellAnswerOf, shellFrame, shellNotes, shellOffered, shellStatus, stillStopping, stopOnClose, stopRun, stopAll, barButtons, clock, lastLines } from "./shell-runs";
import { NOT_CONNECTED } from "./shell-mode";

const run = (over: Partial<ShellRun> = {}): ShellRun => ({ id: "s1", command: "pnpm test", output: "", state: "running", startedAt: 1, ...over });
const msg = (m: unknown) => m as ChatServerMessage;

test("every hello rebuilds the live cards from what it carries, and none when it carries none", () => {
  const kept = [run({ id: "old" })];
  assert.deepEqual(nextShellRuns(kept, msg({ type: "hello", items: [], shell: [run({ output: "so far" })] })), [run({ output: "so far" })]);
  assert.deepEqual(nextShellRuns(kept, msg({ type: "hello", items: [] })), []);
});

test("a start shows the card at once, output appends to it and its end replaces it with the saved output", () => {
  let runs = nextShellRuns([], msg({ type: "shell_start", run: run(), clientId: "c1" }))!;
  assert.equal(runs.length, 1);
  runs = nextShellRuns(runs, msg({ type: "shell_output", id: "s1", delta: "ok 1\n" }))!;
  runs = nextShellRuns(runs, msg({ type: "shell_output", id: "s1", delta: "ok 2\n" }))!;
  assert.equal(runs[0]!.output, "ok 1\nok 2\n");
  runs = nextShellRuns(runs, msg({ type: "shell_end", id: "s1", output: "cut", exitCode: 1, underReply: true }))!;
  assert.deepEqual(runs[0], run({ output: "cut", state: "ended", exitCode: 1, underReply: true }));
  // Its row came with an append just before: the live card goes.
  assert.deepEqual(nextShellRuns(runs, msg({ type: "shell_saved", id: "s1", entryId: "e9" })), []);
});

test("the chat closing stops its running commands' cards at once; an ended one stays as it was", () => {
  const ended = run({ id: "s2", state: "ended", exitCode: 0 });
  const [stopped, kept] = stopOnClose([run({ output: "so far" }), ended]);
  assert.deepEqual(stopped, run({ output: "so far", state: "ended", cancelled: true, cancelReason: "closed" }));
  assert.equal(shellStatus(cardOfRun(stopped!)).word, "Stopped when the chat closed");
  assert.deepEqual(kept, ended);
});

test("Stop from the floating card sends one shell_stop and waits for that command's end", () => {
  const frames: unknown[] = [];
  const send = (f: unknown) => (frames.push(f), true);
  let stopping: ReadonlySet<string> = new Set();
  stopping = stopRun(stopping, "s1", send);
  assert.deepEqual(frames, [{ type: "shell_stop", id: "s1" }]);
  assert.ok(stopping.has("s1"));
  // A second press (the card's or its window's) while it waits sends nothing.
  assert.equal(stopRun(stopping, "s1", send), stopping);
  assert.equal(frames.length, 1);
  // Another command's Stop is its own.
  stopping = stopRun(stopping, "s2", send);
  assert.deepEqual([...stopping], ["s1", "s2"]);
  // s1 ended: it stops waiting; s2 still runs and still waits.
  const runs = [run({ id: "s1", state: "ended", cancelled: true, cancelReason: "user" }), run({ id: "s2" })];
  assert.deepEqual([...stillStopping(stopping, runs)], ["s2"]);
  // No open socket: nothing is held, so the button can be pressed again.
  assert.equal(stopRun(new Set(), "s3", () => false).size, 0);
});

test("a command stopped from outside the page reads plain Stopped, never by you", () => {
  assert.deepEqual(shellStatus(cardOfRow({ command: "x", output: "", cancelled: true, cancelReason: "other" })), { word: "Stopped", tone: "plain" });
});

test("a command Sova stopped at the output limit says so, in the error tone", () => {
  assert.deepEqual(shellStatus(cardOfRow({ command: "yes", output: "y", cancelled: true, cancelReason: "limit" })), { word: "Stopped at the 1 GB output limit", tone: "error" });
});

test("Stop All stops each running command with its own stop, once, and none that already ended", () => {
  const frames: unknown[] = [];
  const send = (f: unknown) => (frames.push(f), true);
  const runs = [run({ id: "a" }), run({ id: "b", state: "ended", exitCode: 0 }), run({ id: "c" })];
  let stopping = stopAll(new Set(["c"]), runs, send);
  assert.deepEqual(frames, [{ type: "shell_stop", id: "a" }], "c is already stopping, b ended");
  assert.deepEqual([...stopping].sort(), ["a", "c"]);
  stopping = stopAll(stopping, runs, send);
  assert.equal(frames.length, 1, "a second Stop All while they wait sends nothing");
});

test("the bar: Show Output and Stop Command for 1 running, no Show All; Show All for more, Stop All with the list open", () => {
  // 1 running: Show Output and Stop Command on the bar, no Show All (open or not, there is no list).
  assert.deepEqual(barButtons(1, false), { showOutput: true, stop: true, showAll: false, stopAll: false });
  assert.deepEqual(barButtons(1, true), barButtons(1, false));
  // 2 or more: Show All, never Show Output; Stop All only with the list open.
  assert.deepEqual(barButtons(2, false), { showOutput: false, stop: false, showAll: true, stopAll: false });
  assert.deepEqual(barButtons(3, true), { showOutput: false, stop: false, showAll: true, stopAll: true });
  assert.deepEqual(barButtons(0, false), { showOutput: false, stop: false, showAll: false, stopAll: false });
});

test("durations read as a clock, and a finished card shows the last 3 lines", () => {
  assert.equal(clock(7_400), "0:07");
  assert.equal(clock(750_000), "12:30");
  assert.equal(clock(3_725_000), "1:02:05");
  assert.equal(lastLines("1\n2\n3\n4\n5\n"), "3\n4\n5");
  assert.equal(lastLines("only"), "only");
});

test("live output keeps only the newest SHELL_LIVE_MAX characters", () => {
  const runs = nextShellRuns([run({ output: "a".repeat(SHELL_LIVE_MAX) })], msg({ type: "shell_output", id: "s1", delta: "bc" }))!;
  assert.equal(runs[0]!.output.length, SHELL_LIVE_MAX);
  assert.ok(runs[0]!.output.endsWith("bc"));
});

test("a start for a run already shown replaces it, and other messages leave the runs alone", () => {
  const runs = nextShellRuns([run({ output: "x" })], msg({ type: "shell_start", run: run({ output: "" }) }))!;
  assert.equal(runs.length, 1);
  assert.equal(nextShellRuns(runs, msg({ type: "agent_start" })), null);
});

test("the composer hears its own Run's start by its id, and a refusal with the reason to show", () => {
  assert.deepEqual(shellAnswerOf(msg({ type: "shell_start", run: run(), clientId: "c1" })), { clientId: "c1" });
  // Another tab's start (no id of ours) answers nothing.
  assert.equal(shellAnswerOf(msg({ type: "shell_start", run: run() })), null);
  assert.deepEqual(shellAnswerOf(msg({ type: "shell_refused", clientId: "c2", reason: "running", message: "A command is already running in this chat." })), {
    clientId: "c2",
    refused: "A command is already running in this chat.",
  });
});

test("the card's status: Running, then Exit n (the error tone when it isn't 0), or who stopped it", () => {
  assert.deepEqual(shellStatus(cardOfRun(run())), { word: "Running", tone: "live" });
  assert.deepEqual(shellStatus(cardOfRow({ command: "x", output: "", exitCode: 0 })), { word: "Exit 0", tone: "plain" });
  assert.deepEqual(shellStatus(cardOfRow({ command: "x", output: "", exitCode: 2 })), { word: "Exit 2", tone: "error" });
  assert.deepEqual(shellStatus(cardOfRow({ command: "x", output: "", cancelled: true, cancelReason: "user" })), { word: "Stopped by you", tone: "plain" });
  assert.deepEqual(shellStatus(cardOfRow({ command: "x", output: "", cancelled: true, cancelReason: "closed" })), { word: "Stopped when the chat closed", tone: "plain" });
  // Stopped in pi's own terminal: the row says only that it was cancelled.
  assert.equal(shellStatus(cardOfRow({ command: "x", output: "", cancelled: true })).word, "Stopped by you");
  // An ended run that isn't saved yet is no longer running.
  assert.equal(shellStatus(cardOfRun(run({ state: "ended", exitCode: 0 }))).word, "Exit 0");
});

test("a card's notes: none for a plain command", () => {
  assert.deepEqual(shellNotes(cardOfRow({ command: "x", output: "", exitCode: 0, truncated: { by: "lines", max: 2000 }, fullOutputPath: "/tmp/pi-bash-1.log" }), false), { notShared: false, afterReply: false });
});

test("!! says it isn't shared, and a mid-reply run says when the model gets it, only while that reply runs", () => {
  assert.equal(shellNotes(cardOfRow({ command: "x", output: "", private: true }), false).notShared, true);
  const mid = cardOfRun(run({ underReply: true }));
  assert.equal(shellNotes(mid, true).afterReply, true);
  assert.equal(shellNotes(mid, false).afterReply, false);
  // A private one never reaches the model, so it says nothing about when.
  assert.equal(shellNotes(cardOfRun(run({ underReply: true, private: true })), true).afterReply, false);
  assert.equal(AFTER_REPLY, "The model gets this after its reply.");
});

test("Run sends the command without its marker, private only for !!, over the open socket", () => {
  const sent: unknown[] = [];
  const o = { open: true, send: (f: unknown) => (sent.push(f), true), newId: () => "c7" };
  assert.deepEqual(runShell(o, "git status", false), { clientId: "c7" });
  assert.deepEqual(runShell(o, "env", true), { clientId: "c7" });
  assert.deepEqual(sent, [
    { type: "shell", command: "git status", clientId: "c7" },
    { type: "shell", command: "env", private: true, clientId: "c7" },
  ]);
  assert.deepEqual(shellFrame("ls", false, "c1"), { type: "shell", command: "ls", clientId: "c1" });
});

test("Run sends nothing with no open connection, and says why; a command already running holds nothing up", () => {
  const sent: unknown[] = [];
  const send = (f: unknown) => (sent.push(f), true);
  assert.deepEqual(runShell({ open: false, send, newId: () => "c1" }, "ls", false), { refused: NOT_CONNECTED });
  assert.deepEqual(sent, []);
  assert.deepEqual(runShell({ open: true, send, newId: () => "c2" }, "sleep 9", false), { clientId: "c2" }, "a second command goes while the first runs");
  // The socket refusing the frame keeps the command too.
  assert.deepEqual(runShell({ open: true, send: () => false, newId: () => "c1" }, "ls", false), { refused: NOT_CONNECTED });
});

test("after a dropped connection, the hello answers a waiting Run: started when a run carries its id, else the dropped answer", () => {
  const runs = [run({ clientId: "c1" }), run({ id: "s2" })];
  assert.deepEqual(answersAtHello(["c1", "c9"], runs), [{ clientId: "c1" }, { clientId: "c9", refused: SHELL_DROPPED }]);
  assert.deepEqual(answersAtHello([], runs), []);
});

test("the box offers shell mode as the chat's hello says; before it, unless the view knows the chat has none", () => {
  // The hello's word wins: a project assistant's hello (or an older server's) carries no flag, and nothing
  // else in the view marks it.
  assert.equal(shellOffered({ helloShellMode: true }), true);
  assert.equal(shellOffered({ helloShellMode: false }), false, "a chat the server says has no shell mode");
  // Before the first hello: offered, unless the chat is one the view already knows has none.
  assert.equal(shellOffered({ helloShellMode: null }), true);
  for (const known of [{ overseer: true }, { projectOverseer: true }, { baton: true }, { batonHeld: true }]) {
    assert.equal(shellOffered({ helloShellMode: null, ...known }), false, JSON.stringify(known));
    assert.equal(shellOffered({ helloShellMode: true, ...known }), false, `${JSON.stringify(known)} even with the flag`);
  }
});
