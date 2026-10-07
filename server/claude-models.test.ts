// Run: npx tsx --test server/claude-models.test.ts (or npm test). Spawns no real CLI.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
// The extension's own argv builder, imported by this test only: the server keeps claude-code out of
// its runtime graph (see claude-models.ts), and this is what stops the two copies drifting.
import { buildDiscoveryArgv } from "../pi-config/extensions/claude-code/transport.ts";
import { CLAUDE_DISCOVERY_ARGV, discoverClaudeModels, parseClaudeModels } from "./claude-models";

/** A fake `claude`: answers the initialize request with whatever `respond` returns for it. */
function fakeClaude(respond: (request: { request_id: string }) => unknown[] | "exit" | "hang") {
  const calls: { command: string; args: string[] }[] = [];
  const spawnImpl = (command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, pid: undefined, kill: () => true });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stdout.end();
      queueMicrotask(() => child.emit("close", 0));
    };
    stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString().trim());
      const answer = respond(request);
      if (answer === "exit") return close();
      if (answer === "hang") return;
      for (const line of answer) stdout.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
    });
    stdin.on("finish", close);
    return child;
  };
  return { spawnImpl: spawnImpl as never, calls };
}

const success = (id: string, models: unknown) => ({ type: "control_response", response: { request_id: id, subtype: "success", response: { models, account: { email: "secret@example.com" } } } });

describe("Claude model discovery (server)", () => {
  test("argv is byte-identical to the claude-code extension's discovery argv", () => {
    assert.deepEqual([...CLAUDE_DISCOVERY_ARGV], buildDiscoveryArgv());
  });

  test("initialize-only handshake: ids, names and efforts; nothing else retained", async () => {
    const fake = fakeClaude((request) => [
      "not json at all",
      { type: "system", subtype: "init" },
      success("someone-else", [{ value: "wrong", displayName: "Wrong" }]),
      success(request.request_id, [
        { value: "opus[1m]", displayName: "Opus", supportedEffortLevels: ["low", "high", "low"], resolvedModel: "claude-opus-5" },
        { value: "haiku", displayName: "Haiku" },
        { value: "opus[1m]", displayName: "Duplicate" },
      ]),
    ]);
    const models = await discoverClaudeModels({ spawnImpl: fake.spawnImpl, executable: "claude-test" });
    assert.deepEqual(models, [
      { id: "opus[1m]", name: "Opus", efforts: ["low", "high"] },
      { id: "haiku", name: "Haiku" },
    ]);
    assert.equal(fake.calls[0]!.command, "claude-test");
    assert.deepEqual(fake.calls[0]!.args, buildDiscoveryArgv());
    assert.ok(!JSON.stringify(models).includes("secret"), "account metadata never kept");
  });

  test("failures reject with a sentence; none of them claims a model is absent", async () => {
    const refused = fakeClaude((r) => [{ type: "control_response", response: { request_id: r.request_id, subtype: "error", error: "raw secret-bearing text" } }]);
    await assert.rejects(discoverClaudeModels({ spawnImpl: refused.spawnImpl }), (err: Error) => /refused to list its models/.test(err.message) && !err.message.includes("secret"));
    const exits = fakeClaude(() => "exit");
    await assert.rejects(discoverClaudeModels({ spawnImpl: exits.spawnImpl }), /exited before listing its models/);
    const hangs = fakeClaude(() => "hang");
    await assert.rejects(discoverClaudeModels({ spawnImpl: hangs.spawnImpl, timeoutMs: 50 }), /did not list its models within/);
    const broken = fakeClaude((r) => [success(r.request_id, "nope")]);
    await assert.rejects(discoverClaudeModels({ spawnImpl: broken.spawnImpl }), /no model list/);
    await assert.rejects(discoverClaudeModels({ executable: "/nonexistent/claude-for-sova-test" }), /Could not run the Claude Code CLI/);
  });

  test("parity: every shared fixture parses as the extension's parser parses it", () => {
    // The same file claude-code/models.test.ts runs through the extension's discoverClaudeModels.
    const fixtures = JSON.parse(readFileSync(new URL("../pi-config/extensions/claude-code/tests/fixtures/discovery-parity.json", import.meta.url), "utf8")) as {
      cases: { name: string; input: unknown; models?: { id: string; efforts?: string[] }[]; error?: string }[];
    };
    assert.ok(fixtures.cases.length >= 10);
    for (const c of fixtures.cases) {
      if (c.error) {
        assert.throws(() => parseClaudeModels(c.input), (err: Error) => err.message.includes(c.error!), c.name);
      } else {
        const got = parseClaudeModels(c.input).map((m) => ({ id: m.id, ...(m.efforts ? { efforts: m.efforts } : {}) }));
        assert.deepEqual(got, c.models, c.name);
      }
    }
  });
});

/** A child whose lifecycle the test scripts: what it does on stdin EOF and on each signal. */
function scriptedChild(opts: { answer?: boolean; closeOnEof?: boolean; closeOnTerm?: boolean; closeBeforeAnswer?: boolean }) {
  const signals: string[] = [];
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
  };
  Object.assign(child, {
    stdin,
    stdout,
    stderr: new PassThrough(),
    pid: undefined,
    kill: (signal: string) => {
      signals.push(signal);
      if (signal === "SIGKILL" || (signal === "SIGTERM" && opts.closeOnTerm)) close();
      return true;
    },
  });
  stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString().trim());
    if (opts.closeBeforeAnswer) return close();
    if (opts.answer !== false) stdout.write(`${JSON.stringify(success(request.request_id, [{ value: "opus", displayName: "Opus" }]))}\n`);
  });
  stdin.on("finish", () => {
    if (opts.closeOnEof) close();
  });
  return { spawnImpl: (() => child) as never, signals };
}
/** A stepped scheduler for discovery's deadline and escalation: its timers fire only when the test
    runs them, in due order, each one's consequences (stream events, exit) landing before the next. */
function steppedTimers() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      pending.set(++next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (handle: unknown) => void pending.delete(handle as number),
  };
  /** Fire every timer until none is left (a guard of 100 stops a loop). */
  const runAll = async () => {
    for (let i = 0; i < 100 && pending.size; i++) {
      const [handle, t] = [...pending].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]!;
      pending.delete(handle);
      now = t.at;
      t.fn();
      await settle();
    }
    assert.equal(pending.size, 0, "the timers stop");
  };
  return { timers, runAll, pending: () => pending.size };
}
/** Let queued stream events, microtasks and the scripted child's exit land. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const graces = { eofGraceMs: 20, termGraceMs: 20 };

describe("Claude discovery process cleanup", () => {
  test("a CLI that exits on EOF is never signalled", async () => {
    const c = scriptedChild({ closeOnEof: true });
    const s = steppedTimers();
    assert.deepEqual(await discoverClaudeModels({ spawnImpl: c.spawnImpl, timers: s.timers, ...graces }), [{ id: "opus", name: "Opus" }]);
    await settle();
    assert.equal(s.pending(), 0, "its exit cleared the escalation");
    await s.runAll();
    assert.deepEqual(c.signals, []);
  });

  test("a CLI that exits before answering: the close that settles it also stops escalation", async () => {
    const c = scriptedChild({ closeBeforeAnswer: true });
    const s = steppedTimers();
    await assert.rejects(discoverClaudeModels({ spawnImpl: c.spawnImpl, timers: s.timers, ...graces }), /exited before listing its models/);
    await settle();
    assert.equal(s.pending(), 0, "no TERM/KILL scheduled for a process already gone");
    await s.runAll();
    assert.deepEqual(c.signals, []);
  });

  test("a CLI that ignores EOF gets TERM, and nothing after it exits", async () => {
    const c = scriptedChild({ closeOnTerm: true });
    const s = steppedTimers();
    await discoverClaudeModels({ spawnImpl: c.spawnImpl, timers: s.timers, ...graces });
    await settle();
    assert.equal(s.pending(), 1, "TERM waits for its grace");
    await s.runAll();
    assert.deepEqual(c.signals, ["SIGTERM"], "KILL is cancelled once TERM worked");
  });

  test("a CLI that ignores TERM gets KILL, once", async () => {
    const c = scriptedChild({});
    const s = steppedTimers();
    await discoverClaudeModels({ spawnImpl: c.spawnImpl, timers: s.timers, ...graces });
    await s.runAll();
    assert.deepEqual(c.signals, ["SIGTERM", "SIGKILL"]);
  });

  test("a timed-out CLI is escalated the same way, and a spawn error signals nothing", async () => {
    const c = scriptedChild({ answer: false, closeOnTerm: true });
    const s = steppedTimers();
    const timedOut = discoverClaudeModels({ spawnImpl: c.spawnImpl, timeoutMs: 20, timers: s.timers, ...graces });
    await settle();
    assert.equal(s.pending(), 1, "only the deadline is armed");
    const refused = assert.rejects(timedOut, /did not list its models/);
    await s.runAll();
    await refused;
    assert.deepEqual(c.signals, ["SIGTERM"]);
    const failed = new EventEmitter() as ChildProcess & EventEmitter;
    const signals: string[] = [];
    Object.assign(failed, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: (s: string) => (signals.push(s), true) });
    const f = steppedTimers();
    const pending = discoverClaudeModels({ spawnImpl: (() => failed) as never, timers: f.timers, ...graces });
    failed.emit("error", new Error("ENOENT"));
    await assert.rejects(pending, /Could not run the Claude Code CLI/);
    await settle();
    await f.runAll();
    assert.deepEqual(signals, []);
  });
});
