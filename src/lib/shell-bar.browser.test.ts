// Run: pnpm test -- src/lib/shell-bar.browser.test.ts (Solid's reactive build).
// The running commands' bar (§chat.shell-mode/card), as ShellDock.tsx presses it: Stop Command on the
// bar with 1 command running, Stop All on the list with 3, and the stop frames each sends over the
// chat socket, with a command that already ended never stopped again.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createShellBar } = await import("./shell-bar");
const { nextShellRuns } = await import("./shell-runs");
type ShellRun = import("../../shared/protocol").ShellRun;
type ChatServerMessage = import("../../shared/protocol").ChatServerMessage;

const run = (id: string, over: Partial<ShellRun> = {}): ShellRun => ({ id, command: `sleep ${id}`, output: "", state: "running", startedAt: 1, ...over });

/** A bar over a stand-in chat: its runs, moved by the chat's own messages, and every frame its socket took. */
function chat(start: ShellRun[]) {
  const frames: unknown[] = [];
  const [runs, setRuns] = solid.createSignal<ShellRun[]>(start);
  let bar!: ReturnType<typeof createShellBar>;
  const dispose = solid.createRoot((dispose) => {
    bar = createShellBar({ runs, send: (f) => (frames.push(f), true) });
    return dispose;
  });
  /** A message from the chat, as ChatView feeds it. */
  const hear = (m: unknown) => setRuns((r) => nextShellRuns(r, m as ChatServerMessage) ?? r);
  return { bar, frames, hear, dispose };
}

test("1 running: Stop Command sits on the bar, sends that command's stop once, and waits for its end", () => {
  const c = chat([run("a")]);
  assert.equal(c.bar.action(), "stop", "the bar's own button");
  assert.equal(c.bar.newest()?.id, "a");
  c.bar.stop(c.bar.newest()!.id);
  assert.deepEqual(c.frames, [{ type: "shell_stop", id: "a" }]);
  assert.ok(c.bar.stopping().has("a"), "the button reads Stopping… and is held");
  c.bar.stop("a");
  assert.equal(c.frames.length, 1, "a second press sends nothing");
  // The chat ends it: nothing waits, and the bar has nothing running.
  c.hear({ type: "shell_end", id: "a", output: "", cancelled: true, cancelReason: "user" });
  assert.equal(c.bar.stopping().size, 0);
  assert.deepEqual(c.bar.running(), []);
  assert.equal(c.bar.action(), null);
  c.dispose();
});

test("3 running: no button until the list opens, then Stop All stops each with its own stop; one that ended isn't stopped", () => {
  const c = chat([run("a"), run("b"), run("c")]);
  assert.equal(c.bar.action(), null, "the shut bar has no Stop for several");
  c.bar.toggle();
  assert.equal(c.bar.listOpen(), true);
  assert.equal(c.bar.action(), "stop-all");
  // b ends on its own before the press.
  c.hear({ type: "shell_end", id: "b", output: "done", exitCode: 0 });
  assert.deepEqual(c.bar.running(), ["a", "c"]);
  c.bar.stopAll();
  assert.deepEqual(c.frames, [
    { type: "shell_stop", id: "a" },
    { type: "shell_stop", id: "c" },
  ]);
  assert.equal(c.bar.allStopping(), true, "Stop All reads Stopping… and is held");
  c.bar.stopAll();
  assert.equal(c.frames.length, 2, "a second Stop All while they wait sends nothing");
  // a ends; c still waits. Then c ends too, and the list shuts with nothing running.
  c.hear({ type: "shell_end", id: "a", output: "", cancelled: true, cancelReason: "user" });
  assert.deepEqual([...c.bar.stopping()], ["c"]);
  c.hear({ type: "shell_end", id: "c", output: "", cancelled: true, cancelReason: "user" });
  assert.equal(c.bar.listOpen(), false);
  assert.equal(c.bar.stopping().size, 0);
  c.dispose();
});

test("a command already stopped on its row isn't stopped again by Stop All", () => {
  const c = chat([run("a"), run("b")]);
  c.bar.toggle();
  c.bar.stop("a");
  c.bar.stopAll();
  assert.deepEqual(c.frames, [
    { type: "shell_stop", id: "a" },
    { type: "shell_stop", id: "b" },
  ]);
  c.dispose();
});

test("a stop the socket didn't take holds nothing, so the button can be pressed again", () => {
  const frames: unknown[] = [];
  let open = false;
  const [runs] = solid.createSignal([run("a")]);
  const bar = solid.createRoot(() => createShellBar({ runs, send: (f) => (open ? (frames.push(f), true) : false) }));
  bar.stop("a");
  assert.equal(bar.stopping().size, 0);
  open = true;
  bar.stop("a");
  assert.deepEqual(frames, [{ type: "shell_stop", id: "a" }]);
});
