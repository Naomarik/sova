import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import type { TourJob } from "../../shared/tour";
import { createSessionFile } from "../harness/pi/state";
import { MODE, SANDBOX } from "../harness/state-kinds";
import type { ChatHandle } from "../chat-handle";

// b1 through the default production runtime: a real session file whose own Sandbox entry is the only
// policy source, the default context snapshot, the real resolver, runner, confined child and browser.
// Nothing injected but the explained page. The agent dir is fixed before any module reads it.
// The sandbox remaps /tmp to its private tmp, so this fixture lives outside /tmp.
const cache = resolve(import.meta.dirname, "../../.cache/guided-tours/recorder");
mkdirSync(cache, { recursive: true });
const root = realpathSync(mkdtempSync(join(cache, "tour-b1-runtime-")));
const agentDir = join(root, "agent"), sessions = join(agentDir, "sessions"), cwd = join(root, "checkout");
mkdirSync(sessions, { recursive: true });
mkdirSync(cwd, { recursive: true });
mkdirSync(join(agentDir, "sandbox-policy", process.platform), { recursive: true });
const policy = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../pi-config/sandbox-policy/${process.platform}/policy.json`), "utf8"));
policy.proxy.allow = ["tour-probe.invalid"];
policy.writable = [];
policy.shadowed = [];
// Recording never reads the policy's default: a default chat that is not On must still record unconfined.
policy.defaultOn = true;
writeFileSync(join(agentDir, "sandbox-policy", process.platform, "policy.json"), JSON.stringify(policy));
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = agentDir;

type Seed = Parameters<typeof createSessionFile>[0]["seed"];
const page = "<!doctype html><html><body><main><h1>Saved drafts</h1><p>Made-up private loopback page.</p></main></body></html>";
const settledPhases = ["checking", "ready", "failed", "cancelled", "needs-site-approval", "needs-test-account", "interrupted"];

/** A loopback page that counts requests and connections, and the default runtime driven against it. */
async function loopbackFixture() {
  let requests = 0, connections = 0;
  const server = createServer((_req, res) => { requests++; res.setHeader("content-type", "text/html"); res.end(page); });
  server.on("connection", () => { connections++; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { TourRuntime } = await import("./runtime");
  const { stateView } = await import("../harness/state-view");
  const script = tourScriptFixture();
  script.source = { kind: "site", origin };
  const view = script.steps[0]!.views[0]!;
  if (view.kind !== "page") throw new Error("fixture");
  view.route = "/private";
  // The caller's own view claims Sandbox off; only the server-read session file or held chat may decide.
  const forged = stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "none" } }] as Parameters<typeof stateView>[0]);
  let n = 0;
  const run = async (seed: Seed): Promise<TourJob> => {
    const session = createSessionFile({ cwd, sessionsDir: sessions, seed });
    const caller = { sessionId: session.id, sessionFile: session.path, cwd: "/forged", state: forged };
    const runtime = new TourRuntime({ root: join(agentDir, "sova", `runtime-${++n}`) });
    try {
      runtime.approvals.approve(origin);
      const { job } = await runtime.dryRun(caller, script, `tour-${n}`);
      for (let i = 0; i < 2400; i++) {
        const now = runtime.queue.get(caller.sessionId, job.id)!;
        if (settledPhases.includes(now.phase)) {
          await runtime.queue.waitForSessionIdle(caller.sessionId);
          return now;
        }
        await new Promise((ok) => setTimeout(ok, 50));
      }
      throw new Error("The recording job did not settle.");
    } finally { runtime.close(); }
  };
  return {
    run,
    counts: () => ({ requests, connections }),
    reset: () => { requests = 0; connections = 0; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); },
  };
}
const vis: NonNullable<Seed>[number] = [MODE, { active: { version: 1, mode: "normal", strict: false, minorModes: ["vis"] } }];
const sandboxEntry = (on: boolean): NonNullable<Seed>[number] => [SANDBOX, { version: 1, on, level: "workspace-write", enforcement: on ? "full" : "none", backend: on ? "test" : "none" }];

/** Stand-in for the process holding the chat: it reports what the chat's own sandbox says now. */
async function hold(info: { on: boolean; enforcement: string; state: string; status: string; starting?: true } | null | "unheld") {
  const { setChatRouter } = await import("../chat-handle");
  setChatRouter(info === "unheld" ? null : {
    ready: async () => {}, all: () => [], acquire: async () => { throw new Error("not in this test"); }, close: async () => false,
    get: () => ({ mirror: { cwd }, sandboxInfo: async () => info }) as unknown as ChatHandle,
  });
}
const heldOff = { on: false, enforcement: "none", state: "subagents", status: "Sandbox subagents only" };
const heldOn = { on: true, enforcement: "full", state: "on", status: "Sandbox on" };

test.after(() => {
  for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});

test("b1: the default TourRuntime follows a chat's own Sandbox On entry; a denied loopback port gets no request", { timeout: 180_000 }, async () => {
  const f = await loopbackFixture();
  // The holding process reports Off throughout: a recorded On entry still confines, never loosened.
  await hold(heldOff);
  try {
    // Positive control: the same flow from a Sandbox Off chat really reaches the page.
    const open = await f.run([sandboxEntry(false), vis]);
    assert.equal(open.phase, "checking", JSON.stringify(open.failure));
    assert.ok(f.counts().requests > 0, "the request counter must distinguish an unconfined recorder");
    f.reset();
    const confined = await f.run([sandboxEntry(true), vis]);
    assert.equal(confined.phase, "failed", JSON.stringify(confined));
    // A launch failure has no step: only an attempt that really navigated counts as containment.
    assert.equal(confined.failure?.stepId, "find-draft", JSON.stringify(confined.failure));
    assert.deepEqual(f.counts(), { requests: 0, connections: 0 }, "the loopback server receives no request and no connection");
  } finally { await hold("unheld"); await f.close(); }
});

// G1: a default chat writes no sandbox entry. Its effective state is what the chat process that holds
// it reports (the same in-memory branch its own tools run under), never the policy's default.
test("G1: a default chat with no sandbox entry records as its held chat reports; not held refuses before contact", { timeout: 240_000 }, async () => {
  const f = await loopbackFixture();
  try {
    // Not held by this server: unknown, refused before any job or contact (this policy's defaultOn is true and is not read).
    await hold("unheld");
    await assert.rejects(() => f.run([vis]), /sandbox state can't be established/);
    // Held, but its runtime has no sandbox: still unknown.
    await hold(null);
    await assert.rejects(() => f.run([vis]), /sandbox state can't be established/);
    assert.deepEqual(f.counts(), { requests: 0, connections: 0 });
    // Held in Subagents only: its own tools are unconfined, so the recorder reaches the page.
    await hold(heldOff);
    const open = await f.run([vis]);
    assert.equal(open.phase, "checking", JSON.stringify(open.failure));
    assert.ok(f.counts().requests > 0, "positive control: the held Subagents-only chat records unconfined");
    f.reset();
    // Still turning on (the extension's provisional entry, in the file or as the held report): refused, no contact.
    const provisional: NonNullable<Seed>[number] = [SANDBOX, { version: 1, on: true, level: "workspace-write", backend: "linux-bwrap", enforcement: "unavailable", reasons: ["starting"] }];
    await hold("unheld");
    await assert.rejects(() => f.run([provisional, vis]), /still turning on/);
    await hold({ on: true, enforcement: "unavailable", state: "on", status: "Sandbox turning on…", starting: true } as typeof heldOn);
    await assert.rejects(() => f.run([vis]), /still turning on/);
    assert.deepEqual(f.counts(), { requests: 0, connections: 0 }, "nothing runs while the sandbox is turning on");
    // Held On with no entry in the file yet: the live On wins and the recorder runs, confined.
    await hold(heldOn);
    const confined = await f.run([vis]);
    assert.equal(confined.phase, "failed", JSON.stringify(confined));
    assert.equal(confined.failure?.stepId, "find-draft", JSON.stringify(confined.failure));
    assert.deepEqual(f.counts(), { requests: 0, connections: 0 }, "a held On chat's recorder cannot reach the denied loopback port");
  } finally { await hold("unheld"); await f.close(); }
});
