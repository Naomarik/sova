// Run: pnpm test -- server/chat-shell.test.ts. A chat's commands from shell mode (§chat.shell-mode/running,
// /card, /lifecycle): Sova's refusals come first and a refused command never starts, is never shown and never
// saved; several run at once; output goes out throttled; an unsaved run stays in the hello until its entry
// is saved (mid-reply: after the reply); Stop Command stops only that run, one still being prepared included;
// a run past the output limit is stopped and marked so; a closing chat stops every command (one still being
// prepared never starts) and saves each as stopped by the close, waiting for a deferred record (it stops the
// reply in flight), and a second close waits for the same one. The
// harness is a fake: what pi does is the pi adapter's (shell.ts, its own test and quirk P40's canary).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HEntry, ShellResult } from "../shared/harness";
import type { ChatServerMessage, ShellRefusal, TranscriptItem } from "../shared/protocol";
import { SHELL_CLOSING_TEXT } from "../shared/chat-runtime";
import { SHELL_OUTPUT_MAX_BYTES } from "../shared/protocol";
import { ChatShell, SHELL_EMPTY_TEXT } from "./chat-shell";

type RunOpts = { id: string; private?: boolean; signal?: AbortSignal; maxBytes?: number; onStart(): void; onOutput(chunk: string): void };
type Outcome = ShellResult | { refused: string; why: "sandbox" | "failed" | "stopped" };

/** A deferred value, settled by the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const entry = (id: string, cancelled = false): HEntry => ({ id, parentId: null, kind: "shell", command: "c", output: "o", ...(cancelled ? { cancelled } : {}) });

/** `prepare`: each run waits for `begin(i)` before it starts, as a hook or the sandbox makes it wait; a stop
    meanwhile means it never starts (the adapter's rule). */
function rig(o: { refusal?: { reason: ShellRefusal; message: string } | null; platform?: string; refuse?: string; prepare?: boolean } = {}) {
  const sent: ChatServerMessage[] = [];
  const toSender: ChatServerMessage[] = [];
  const calls: { command: string; o: RunOpts; done: ReturnType<typeof deferred<Outcome>> }[] = [];
  const stops: string[] = [];
  const marked: [string, string][] = [];
  const rowsAsked: { id: string | null; stopped: string | null }[] = [];
  const durations: [string, number][] = [];
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
        opts.signal?.addEventListener("abort", () => void stops.push(opts.id), { once: true });
        if (o.refuse) done.resolve({ refused: o.refuse, why: "sandbox" });
        else if (!o.prepare) opts.onStart();
        return done.promise;
      },
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
    rowsOf: (e, stopped, _durationMs) => {
      rowsAsked.push({ id: e.id, stopped });
      return [{ id: e.id ?? "?", kind: "shell", text: "$ c" } as TranscriptItem];
    },
    markRun: (id, facts) => {
      if (facts.stopped) marked.push([id, facts.stopped]);
      if (facts.durationMs !== undefined) durations.push([id, facts.durationMs]);
    },
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
  /** A prepared run starts now, unless it was stopped meanwhile: then it never does. */
  const begin = (i: number) => {
    const c = calls[i]!;
    if (c.o.signal?.aborted) c.done.resolve({ refused: "stopped before it started", why: "stopped" });
    else c.o.onStart();
  };
  return {
    shell, sent, toSender, calls, stops, marked, durations, rowsAsked, client, sentWhere, result, begin,
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

  test("several at once: a second command runs beside the first, each its own run in the hello; `!!` asks the harness for a private run", async () => {
    const r = rig();
    r.shell.start(r.client, { command: "sleep 9", private: true, clientId: "a" });
    assert.equal(r.calls[0]!.o.private, true);
    assert.equal(r.calls[0]!.o.maxBytes, SHELL_OUTPUT_MAX_BYTES, "every run carries the output limit");
    r.shell.start(r.client, { command: "ls", clientId: "b" });
    assert.deepEqual(r.toSender, [], "nothing refused");
    assert.equal(r.calls.length, 2);
    const starts = r.sent.filter((m): m is Extract<ChatServerMessage, { type: "shell_start" }> => m.type === "shell_start");
    assert.deepEqual(starts.map((m) => [m.clientId, m.run.command, m.run.private, m.run.state]), [["a", "sleep 9", true, "running"], ["b", "ls", undefined, "running"]]);
    assert.notEqual(starts[0]!.run.id, starts[1]!.run.id);
    assert.equal(r.shell.snapshot()!.length, 2);
    assert.deepEqual(r.shell.list().map((l) => l.command), ["", "ls"], "the list never shows a !! command's text");
    r.calls[1]!.done.resolve(r.result());
    await r.sentWhere((m) => m.type === "shell_saved");
    assert.equal(r.shell.snapshot()!.length, 1, "the first still runs");
    assert.equal(r.shell.running(), true);
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
    r.shell.start(r.client, { command: "sleep 8", clientId: "b" });
    assert.equal(r.shell.stop("sh_other"), false);
    assert.deepEqual(r.stops, []);
    assert.equal(r.shell.stop(id), true);
    assert.deepEqual(r.stops, [id], "the other run goes on");
    r.calls[0]!.done.resolve(r.result({ exitCode: undefined, cancelled: true }, Promise.resolve(entry("e2", true))));
    const end = (await r.sentWhere((m) => m.type === "shell_end")) as Extract<ChatServerMessage, { type: "shell_end" }>;
    assert.deepEqual({ cancelled: end.cancelled, cancelReason: end.cancelReason, exitCode: end.exitCode }, { cancelled: true, cancelReason: "user", exitCode: undefined });
    await r.sentWhere((m) => m.type === "shell_saved");
    assert.deepEqual(r.marked, [], "no close marker for a command you stopped");
    assert.deepEqual(r.rowsAsked, [{ id: "e2", stopped: null }]);
  });

  test("every finished run says how long it ran, on its end and in its marker; a stop from the entry reads stopped by other", async () => {
    const r = rig();
    r.shell.start(r.client, { command: "sleep 9", clientId: "a" });
    const id = r.calls[0]!.o.id;
    assert.equal(r.shell.stop(id, true), true);
    r.calls[0]!.done.resolve(r.result({ exitCode: undefined, cancelled: true }, Promise.resolve(entry("e8", true))));
    const end = (await r.sentWhere((m) => m.type === "shell_end")) as Extract<ChatServerMessage, { type: "shell_end" }>;
    assert.equal(end.cancelReason, "other", "not stopped by you");
    assert.equal(typeof end.durationMs, "number");
    assert.ok(end.durationMs! >= 0);
    await r.sentWhere((m) => m.type === "shell_saved");
    assert.deepEqual(r.marked, [["e8", "other"]]);
    assert.deepEqual(r.durations, [["e8", end.durationMs!]], "the saved row's duration is the end's");
  });

  test("Stop on a command still being prepared: it never starts, and its sender's box is told", async () => {
    const r = rig({ prepare: true });
    r.shell.start(r.client, { command: "make", clientId: "a" });
    const id = r.calls[0]!.o.id;
    assert.equal(r.shell.running(), true, "taken: it counts as running while prepared");
    assert.equal(r.shell.stop(id), true);
    r.begin(0);
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(r.sent, [], "no card: it never ran");
    assert.equal((r.toSender[0] as Extract<ChatServerMessage, { type: "shell_refused" }>).reason, "unavailable");
    assert.equal(r.shell.running(), false);
  });

  test("a run whose output passes the limit is stopped by the harness and reads stopped at the limit, with its marker", async () => {
    const r = rig();
    r.shell.start(r.client, { command: "yes", clientId: "a" });
    r.calls[0]!.done.resolve(r.result({ exitCode: undefined, cancelled: true, limited: true }, Promise.resolve(entry("e9", true))));
    const end = (await r.sentWhere((m) => m.type === "shell_end")) as Extract<ChatServerMessage, { type: "shell_end" }>;
    assert.equal(end.cancelReason, "limit");
    await r.sentWhere((m) => m.type === "shell_saved");
    assert.deepEqual(r.marked, [["e9", "limit"]]);
    assert.deepEqual(r.rowsAsked, [{ id: "e9", stopped: "limit" }]);
  });

  test("a closing chat stops its command and saves it as stopped by the close; nothing starts afterwards", async () => {
    const r = rig();
    r.shell.start(r.client, { command: "sleep 60", clientId: "a" });
    r.shell.start(r.client, { command: "sleep 61", clientId: "a2" });
    const closing = r.shell.close();
    assert.equal(r.stops.length, 2, "the close stops every one");
    let second = false;
    void r.shell.close().then(() => (second = true));
    r.calls[0]!.done.resolve(r.result({ exitCode: undefined, cancelled: true }, Promise.resolve(entry("e3", true))));
    await new Promise((res) => setImmediate(res));
    assert.equal(second, false, "a second close waits for the same close, not past it");
    r.calls[1]!.done.resolve(r.result({ exitCode: undefined, cancelled: true }, Promise.resolve(entry("e5", true))));
    await closing;
    const ends = r.sent.filter((m): m is Extract<ChatServerMessage, { type: "shell_end" }> => m.type === "shell_end");
    assert.deepEqual(ends.map((e) => e.cancelReason), ["closed", "closed"]);
    assert.deepEqual(r.marked, [["e3", "closed"], ["e5", "closed"]], "the markers name the saved entries");
    assert.deepEqual(r.rowsAsked, [{ id: "e3", stopped: "closed" }, { id: "e5", stopped: "closed" }]);
    r.shell.start(r.client, { command: "ls", clientId: "b" });
    assert.deepEqual(r.toSender.at(-1), { type: "shell_refused", clientId: "b", reason: "unavailable", message: SHELL_CLOSING_TEXT });
    assert.equal(r.calls.length, 2);
  });

  test("a chat that closes while a command is still being prepared: it never starts (t7)", async () => {
    const r = rig({ prepare: true });
    r.shell.start(r.client, { command: "rm -rf build", clientId: "a" });
    const closing = r.shell.close();
    r.begin(0);
    await closing;
    assert.deepEqual(r.sent, [], "no card, nothing ran");
    assert.deepEqual(r.toSender, [{ type: "shell_refused", clientId: "a", reason: "unavailable", message: SHELL_CLOSING_TEXT }]);
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
