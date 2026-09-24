// Run: npx tsx --test server/sandbox-state.test.ts (or npm test)
// The sandbox adapter against fake runtimes: no pi runtime, no session file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeActive } from "../pi-config/extensions/sandbox/state.ts";
import type { ChatServerMessage } from "../shared/protocol";
import { applySandbox, onSandboxAppend, parseSandboxBody, sandboxCommandOf, sandboxInfo, type SandboxHost } from "./sandbox-state";

const EXT = "/home/u/.pi/agent/extensions/sandbox/index.ts";
type Entry = { type: string; customType?: string; data?: unknown };
const entry = (data: Record<string, unknown>): Entry => ({ type: "custom", customType: "sandbox", data: { version: 1, level: "workspace-write", ...data } });

/** A runtime whose /sandbox handler appends the entry the real extension would, and reports it. */
function fakeHost(opts: { command?: boolean; path?: string; foreign?: boolean; enforcement?: string } = {}) {
  const branch: Entry[] = [{ type: "message" }];
  const sent: ChatServerMessage[] = [];
  const calls: string[] = [];
  const host: SandboxHost = {
    command: () =>
      opts.command === false
        ? undefined
        : sandboxCommandOf({
            getCommand: (name) =>
              name !== "sandbox"
                ? undefined
                : {
                    sourceInfo: { path: opts.path ?? EXT },
                    handler: async (args: string) => {
                      calls.push(`handler ${args}`);
                      const e = entry(args === "on" ? { on: true, backend: "linux-bwrap", enforcement: opts.enforcement ?? "full" } : { on: false, backend: "none", enforcement: "none" });
                      branch.push(e);
                      onSandboxAppend(host, e); // what ChatSession's entry_appended hook does
                    },
                  },
          }),
    foreign: () => !!opts.foreign,
    commandContext: () => ({}),
    beforeCommand: () => calls.push("flush"),
    afterCommand: () => calls.push("owned"),
    branch: () => branch,
    broadcast: (m) => sent.push(m),
  };
  return { host, branch, sent, calls };
}

test("presence: the sandbox extension's own command only", () => {
  assert.ok(fakeHost().host.command());
  assert.equal(fakeHost({ command: false }).host.command(), undefined);
  // Another extension's "sandbox" is not ours, and is never run.
  assert.equal(fakeHost({ path: "/x/extensions/other/index.ts" }).host.command(), undefined);
});

test("absent: applySandbox answers unsupported, runs nothing and sends nothing", async () => {
  const { host, sent, calls, branch } = fakeHost({ command: false });
  assert.deepEqual(await applySandbox(host, true), { outcome: "unsupported" });
  assert.deepEqual(sent, []);
  assert.deepEqual(calls, []);
  assert.equal(branch.length, 1);
});

test("absent: an appended entry sends nothing either", () => {
  const { host, sent } = fakeHost({ command: false });
  onSandboxAppend(host, entry({ on: true, enforcement: "full" }));
  assert.deepEqual(sent, []);
});

test("a flip runs /sandbox on|off and every client hears the runtime's answer", async () => {
  const { host, sent, calls } = fakeHost();
  const on = await applySandbox(host, true);
  assert.deepEqual(calls, ["flush", "handler on", "owned"]);
  const status = describeActive({ on: true, level: "workspace-write", enforcement: "full" });
  assert.deepEqual(on, { outcome: "command", sandbox: { on: true, enforcement: "full", status } });
  assert.ok(sent.length >= 1);
  for (const m of sent) assert.deepEqual(m, { type: "sandbox", on: true, enforcement: "full", status });

  sent.length = 0;
  const off = await applySandbox(host, false);
  assert.deepEqual(off.sandbox, { on: false, enforcement: "none", status: "Sandbox off" });
  assert.ok(sent.length >= 1 && sent.every((m) => m.type === "sandbox" && m.on === false));
});

test("unavailable and partial reach the client as the extension wrote them", async () => {
  for (const enforcement of ["partial", "unavailable"] as const) {
    const { host } = fakeHost({ enforcement });
    const r = await applySandbox(host, true);
    assert.equal(r.sandbox?.enforcement, enforcement);
    assert.equal(r.sandbox?.on, true);
  }
});

test("a foreign or TUI writer: nothing runs and nothing is written", async () => {
  const { host, calls, branch } = fakeHost({ foreign: true });
  const r = await applySandbox(host, true);
  assert.equal(r.outcome, "skip");
  assert.deepEqual(calls, []);
  assert.equal(branch.length, 1);
});

test("a handler that throws still ends on the runtime's state", async () => {
  const { host, sent } = fakeHost();
  const broken: SandboxHost = { ...host, command: () => ({ sourceInfo: { path: EXT }, handler: () => Promise.reject(new Error("boom")) }) };
  const r = await applySandbox(broken, true);
  assert.deepEqual(r, { outcome: "command", sandbox: { on: false, enforcement: "none", status: "Sandbox off" } });
  assert.equal(sent.length, 1);
});

test("status: the newest entry wins; no entry is off", () => {
  assert.deepEqual(sandboxInfo([]), { on: false, enforcement: "none", status: "Sandbox off" });
  const s = sandboxInfo([entry({ on: true, backend: "b", enforcement: "full" }), { type: "message" }, entry({ on: false, backend: "none", enforcement: "none" })]);
  assert.equal(s.on, false);
  // A malformed entry is skipped, by the extension's own restore rule.
  assert.equal(sandboxInfo([entry({ on: true, backend: "b", enforcement: "full" }), { type: "custom", customType: "sandbox", data: { version: 9 } }]).on, true);
});

test("the POST body is { on: boolean } and nothing looser", () => {
  assert.deepEqual(parseSandboxBody({ on: true }), { on: true });
  assert.deepEqual(parseSandboxBody({ on: false }), { on: false });
  for (const bad of [undefined, null, [], {}, { on: "on" }, { on: 1 }]) assert.ok("error" in parseSandboxBody(bad), JSON.stringify(bad));
});
