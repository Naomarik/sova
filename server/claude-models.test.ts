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
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const graces = { eofGraceMs: 20, termGraceMs: 20 };

describe("Claude discovery process cleanup", () => {
  test("a CLI that exits on EOF is never signalled", async () => {
    const c = scriptedChild({ closeOnEof: true });
    assert.deepEqual(await discoverClaudeModels({ spawnImpl: c.spawnImpl, ...graces }), [{ id: "opus", name: "Opus" }]);
    await wait(80);
    assert.deepEqual(c.signals, []);
  });

  test("a CLI that exits before answering: the close that settles it also stops escalation", async () => {
    const c = scriptedChild({ closeBeforeAnswer: true });
    await assert.rejects(discoverClaudeModels({ spawnImpl: c.spawnImpl, ...graces }), /exited before listing its models/);
    await wait(80);
    assert.deepEqual(c.signals, [], "no TERM/KILL scheduled for a process already gone");
  });

  test("a CLI that ignores EOF gets TERM, and nothing after it exits", async () => {
    const c = scriptedChild({ closeOnTerm: true });
    await discoverClaudeModels({ spawnImpl: c.spawnImpl, ...graces });
    await wait(100);
    assert.deepEqual(c.signals, ["SIGTERM"], "KILL is cancelled once TERM worked");
  });

  test("a CLI that ignores TERM gets KILL, once", async () => {
    const c = scriptedChild({});
    await discoverClaudeModels({ spawnImpl: c.spawnImpl, ...graces });
    await wait(120);
    assert.deepEqual(c.signals, ["SIGTERM", "SIGKILL"]);
  });

  test("a timed-out CLI is escalated the same way, and a spawn error signals nothing", async () => {
    const c = scriptedChild({ answer: false, closeOnTerm: true });
    await assert.rejects(discoverClaudeModels({ spawnImpl: c.spawnImpl, timeoutMs: 20, ...graces }), /did not list its models/);
    await wait(100);
    assert.deepEqual(c.signals, ["SIGTERM"]);
    const failed = new EventEmitter() as ChildProcess & EventEmitter;
    const signals: string[] = [];
    Object.assign(failed, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: (s: string) => (signals.push(s), true) });
    const pending = discoverClaudeModels({ spawnImpl: (() => failed) as never, ...graces });
    failed.emit("error", new Error("ENOENT"));
    await assert.rejects(pending, /Could not run the Claude Code CLI/);
    await wait(80);
    assert.deepEqual(signals, []);
  });
});
