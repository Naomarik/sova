// Run: pnpm test -- server/chat-shell.test.ts. A chat's commands from shell mode (§chat.shell-mode/running,
// /card, /lifecycle): Sova's refusals come first and a refused command never starts, is never shown and never
// saved; one runs at a time; its output goes out throttled; an unsaved run stays in the hello until its entry
// is saved (mid-reply: after the reply); Stop Command stops only that run; a closing chat stops its command
// and saves it as stopped by the close, waiting for a deferred record (it stops the reply in flight). The
// harness is a fake: what pi does is the pi adapter's (shell.ts, its own test and quirk P40's canary).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HEntry, ShellResult } from "../shared/harness";
import type { ChatServerMessage, ShellRefusal, TranscriptItem } from "../shared/protocol";
import { ChatShell, SHELL_EMPTY_TEXT, SHELL_RUNNING_TEXT } from "./chat-shell";

type RunOpts = { id: string; private?: boolean; onStart(): void; onOutput(chunk: string): void };
type Outcome = ShellResult | { refused: string; why: "sandbox" | "failed" };

/** A deferred value, settled by the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const entry = (id: string, cancelled = false): HEntry => ({ id, parentId: null, kind: "shell", command: "c", output: "o", ...(cancelled ? { cancelled } : {}) });

function rig(o: { refusal?: { reason: ShellRefusal; message: string } | null; platform?: string; refuse?: string } = {}) {
  const sent: ChatServerMessage[] = [];
  const toSender: ChatServerMessage[] = [];
  const calls: { command: string; o: RunOpts; done: ReturnType<typeof deferred<Outcome>> }[] = [];
  const stops: number[] = [];
  const marked: string[] = [];
  const rowsAsked: { id: string | null; closed: boolean }[] = [];
  let streaming = false;
  let aborts = 0;
  const waiters: (() => void)[] = [];
  const harness = {
    isRunning: () => streaming,
    abort: async () => {
      aborts++;
      streaming = false;
    },
    shell: {
      run: (command: string, opts: RunOpts) => {
        const done = deferred<Outcome>();
        calls.push({ command, o: opts, done });
        if (o.refuse) done.resolve({ refused: o.refuse, why: "sandbox" });
        else opts.onStart();
        return done.promise;
      },
      stop: () => void stops.push(1),
      isRunning: () => false,
    },
  };
  const shell = new ChatShell({
    harness: () => harness as never,
    broadcast: (m) => {
      sent.push(m);
      for (const w of waiters.splice(0)) w();
    },
    refusal: () => o.refusal ?? null,
    beforeWrite: () => {},
    rowsOf: (e, closed) => {
      rowsAsked.push({ id: e.id, closed });
      return [{ id: e.id ?? "?", kind: "shell", text: "$ c" } as TranscriptItem];
    },
    markClosed: (id) => void marked.push(id),
    changed: () => {},
    platform: o.platform ?? "linux",
  });
  const client = { send: (m: ChatServerMessage) => void toSender.push(m) };
  /** Resolves once a broadcast matching `pred` went out (an event, never a sleep). */
  const sentWhere = (pred: (m: ChatServerMessage) => boolean) =>
    new Promise<ChatServerMessage>((resolve) => {
      const check = () => {
        const m = sent.find(pred);
        if (m) resolve(m);
        else waiters.push(check);
      };
      check();
    });
  const result = (over: Partial<ShellResult> = {}, saved: Promise<HEntry | null> = Promise.resolve(entry("e1"))): ShellResult => ({ output: "out", exitCode: 0, cancelled: false, saved, ...over });
  return {
    shell, sent, toSender, calls, stops, marked, rowsAsked, client, sentWhere, result,
    setStreaming: (v: boolean) => void (streaming = v),
    aborts: () => aborts,
  };
}

const types = (ms: ChatServerMessage[]) => ms.map((m) => m.type);

describe("a chat's commands from shell mode", () => {
  test("Sova's refusals come first: nothing starts, nothing is shown, the sender alone is told why", () => {
    const empty = rig();
    empty.shell.start(empty.client, { command: "   ", clientId: "c1" });
    assert.deepEqual(empty.toSender, [{ type: "shell_refused", clientId: "c1", reason: "empty", message: SHELL_EMPTY_TEXT }]);

    const held = rig({ refusal: { reason: "busy", message: "A terminal has it." } });
    held.shell.start(held.client, { command: "ls", clientId: "c2" });
    assert.deepEqual(held.toSender, [{ type: "shell_refused", clientId: "c2", reason: "busy", message: "A terminal has it." }]);

    for (const r of [empty, held]) {
      assert.equal(r.calls.length, 0, "the harness was never asked");
      assert.deepEqual(r.sent, [], "no card anywhere");
      assert.equal(r.shell.snapshot(), undefined);
      assert.equal(r.shell.inFlight(), false);
    }
  });

  test("the macOS kill guard refuses a mis-written kill before it runs, in the user's words; elsewhere it runs", () => {
    const mac = rig({ platform: "darwin" });
    mac.shell.start(mac.client, { command: "pkill -f x", clientId: "k" });
    const r = mac.toSender[0] as Extract<ChatServerMessage, { type: "shell_refused" }>;
    assert.equal(r.reason, "kill-guard");
    assert.match(r.message, /^Sova refused this command before it ran; nothing ran\./);
    assert.doesNotMatch(r.message, /bash|project_verbs/, "the agent's wording stays the agent's");
    assert.equal(mac.calls.length, 0);
    const linux = rig({ platform: "linux" });
    linux.shell.start(linux.client, { command: "pkill -f x", clientId: "k" });
    assert.equal(linux.calls.length, 1);
  });

  test("a sandbox that can't be prepared: refused with its reason, no card, not saved", () => {
    const r = rig({ refuse: "The sandbox couldn't be prepared, so nothing ran: probe failed" });
    r.shell.start(r.client, { command: "ls", clientId: "s" });
    return new Promise<void>((done) =>
      setImmediate(() => {
        assert.deepEqual(r.toSender, [{ type: "shell_refused", clientId: "s", reason: "sandbox", message: "The sandbox couldn't be prepared, so nothing ran: probe failed" }]);
        assert.deepEqual(r.sent, []);
        assert.equal(r.shell.inFlight(), false);
        done();
      }),
    );
  });

  test("one at a time: a second command while one runs is refused, the first unaffected; `!!` asks the harness for a private run", async () => {
    const r = rig();
    r.shell.start(r.client, { command: "sleep 9", private: true, clientId: "a" });
    assert.equal(r.calls[0]!.o.private, true);
    r.shell.start(r.client, { command: "ls", clientId: "b" });
    assert.deepEqual(r.toSender, [{ type: "shell_refused", clientId: "b", reason: "running", message: SHELL_RUNNING_TEXT }]);
    assert.equal(r.calls.length, 1);
    const start = r.sent[0] as Extract<ChatServerMessage, { type: "shell_start" }>;
    assert.equal(start.type, "shell_start");
    assert.equal(start.clientId, "a");
    assert.deepEqual({ command: start.run.command, private: start.run.private, state: start.run.state }, { command: "sleep 9", private: true, state: "running" });
    r.calls[0]!.done.resolve(r.result());
    await r.sentWhere((m) => m.type === "shell_saved");
    r.shell.start(r.client, { command: "ls", clientId: "c" });
    assert.equal(r.calls.length, 2, "once it ended, the next one runs");
  });

  test("output goes out throttled, the hello carries the run so far, and once saved the row comes before the run goes", async () => {
    const r = rig();
    r.shell.start(r.client, { command: "make", clientId: "a" });
    const { o, done } = r.calls[0]!;
    o.onOutput("one ");
    o.onOutput("two");
    const out = (await r.sentWhere((m) => m.type === "shell_output")) as Extract<ChatServerMessage, { type: "shell_output" }>;
    assert.equal(out.delta, "one two", "both pieces in one message");
    assert.equal(r.sent.filter((m) => m.type === "shell_output").length, 1);
    o.onOutput(" three");
    const snap = r.shell.snapshot()!;
    assert.equal(snap.length, 1);
    assert.equal(snap[0]!.output, "one two three", "the hello has what is not sent yet too");
    assert.equal(r.shell.inFlight(), true);
    done.resolve(r.result({ output: "one two three", exitCode: 2 }));
    await r.sentWhere((m) => m.type === "shell_saved");
    assert.deepEqual(types(r.sent), ["shell_start", "shell_output", "shell_output", "shell_end", "append", "shell_saved"]);
    const end = r.sent.find((m) => m.type === "shell_end") as Extract<ChatServerMessage, { type: "shell_end" }>;
    assert.equal(end.exitCode, 2);
    assert.equal(end.output, "one two three");
    assert.equal(end.underReply, undefined);
    assert.deepEqual(r.sent.at(-1), { type: "shell_saved", id: snap[0]!.id, entryId: "e1" });
    assert.equal(r.shell.snapshot(), undefined, "saved: no longer in the hello");
    assert.equal(r.shell.inFlight(), false);
  });

  test("a command that ends while the model replies stays in the hello, ended, until its record is written after the reply", async () => {
    const r = rig();
    r.setStreaming(true);
    r.shell.start(r.client, { command: "ls", clientId: "a" });
    assert.equal((r.sent[0] as Extract<ChatServerMessage, { type: "shell_start" }>).run.underReply, true);
    const saved = deferred<HEntry | null>();
    r.calls[0]!.done.resolve(r.result({ output: "x" }, saved.promise));
    const end = (await r.sentWhere((m) => m.type === "shell_end")) as Extract<ChatServerMessage, { type: "shell_end" }>;
    assert.equal(end.underReply, true);
    const snap = r.shell.snapshot()!;
    assert.deepEqual({ state: snap[0]!.state, output: snap[0]!.output, underReply: snap[0]!.underReply }, { state: "ended", output: "x", underReply: true });
    assert.equal(r.shell.inFlight(), true, "an unsaved run keeps the chat from being quiet");
    saved.resolve(entry("e7"));
    await r.sentWhere((m) => m.type === "shell_saved");
    assert.equal(r.shell.snapshot(), undefined);
  });

  test("Stop Command stops only the run it names, while it runs; a stopped run reads stopped by you", async () => {
    const r = rig();
    r.shell.start(r.client, { command: "sleep 9", clientId: "a" });
    const id = (r.sent[0] as Extract<ChatServerMessage, { type: "shell_start" }>).run.id;
    r.shell.stop("sh_other");
    assert.equal(r.stops.length, 0);
    r.shell.stop(id);
    assert.equal(r.stops.length, 1);
    r.calls[0]!.done.resolve(r.result({ exitCode: undefined, cancelled: true }, Promise.resolve(entry("e2", true))));
    const end = (await r.sentWhere((m) => m.type === "shell_end")) as Extract<ChatServerMessage, { type: "shell_end" }>;
    assert.deepEqual({ cancelled: end.cancelled, cancelReason: end.cancelReason, exitCode: end.exitCode }, { cancelled: true, cancelReason: "user", exitCode: undefined });
    await r.sentWhere((m) => m.type === "shell_saved");
    assert.deepEqual(r.marked, [], "no close marker for a command you stopped");
    assert.deepEqual(r.rowsAsked, [{ id: "e2", closed: false }]);
  });

  test("a closing chat stops its command and saves it as stopped by the close; nothing starts afterwards", async () => {
    const r = rig();
    r.shell.start(r.client, { command: "sleep 60", clientId: "a" });
    const closing = r.shell.close();
    assert.equal(r.stops.length, 1, "the close stops it");
    r.calls[0]!.done.resolve(r.result({ exitCode: undefined, cancelled: true }, Promise.resolve(entry("e3", true))));
    await closing;
    const end = r.sent.find((m) => m.type === "shell_end") as Extract<ChatServerMessage, { type: "shell_end" }>;
    assert.equal(end.cancelReason, "closed");
    assert.deepEqual(r.marked, ["e3"], "the marker names the saved entry");
    assert.deepEqual(r.rowsAsked, [{ id: "e3", closed: true }]);
    r.shell.start(r.client, { command: "ls", clientId: "b" });
    assert.equal((r.toSender.at(-1) as Extract<ChatServerMessage, { type: "shell_refused" }>).reason, "unavailable");
    assert.equal(r.calls.length, 1);
  });

  test("a closing chat with a run waiting for the reply stops the reply, so its record is written before the chat goes", async () => {
    const r = rig();
    r.setStreaming(true);
    r.shell.start(r.client, { command: "ls", clientId: "a" });
    const saved = deferred<HEntry | null>();
    r.calls[0]!.done.resolve(r.result({ output: "x" }, saved.promise));
    await r.sentWhere((m) => m.type === "shell_end");
    const closing = r.shell.close();
    await new Promise((res) => setImmediate(res));
    assert.equal(r.aborts(), 1, "the reply in flight is stopped");
    saved.resolve(entry("e4"));
    await closing;
    assert.ok(r.sent.some((m) => m.type === "shell_saved"), "saved before the close returned");
    assert.deepEqual(r.marked, [], "it had ended on its own: not stopped by the close");
  });
});
