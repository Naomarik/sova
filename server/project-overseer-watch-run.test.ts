// Run: pnpm exec tsx --test server/project-overseer-watch-run.test.ts. The project overseer's
// unattended runs end to end on a local stub model (server/stream-stub.ts, through pi's real
// openai-completions provider): the last run records how it really ended. A throwaway
// PI_CODING_AGENT_DIR; ~/.pi is never read or written and no real model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startStreamStub, stubModelsJson } from "./stream-stub";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-run-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const stub = await startStreamStub({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(stubModelsJson(stub.port)));

const orgs = await import("./orgs");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const recovery = await import("./wrapup-recovery");

after(async () => {
  await disposeAllChats();
  await stub.close();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

type LastRun = NonNullable<ReturnType<typeof store.readMemo>["lastRun"]>;

describe("the overseer's last run says how it ended", async () => {
  const org = await orgs.createOrg({ name: "Runs", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const p = store.projectOverseerPaths(org.id, project.id);
  let path = "";

  before(async () => {
    path = (await po.ensureProjectOverseer(org.id, project.id)).path;
    const chat = await acquireChat(path);
    await chat.setModelRef("stub/runaway");
  });

  /** Run Now, then wait until the memo no longer says it is running. */
  async function look(): Promise<LastRun> {
    const r = await po.lookNow(org.id, project.id, true);
    assert.equal(r.started, true, r.why);
    assert.equal(store.readMemo(p).lastRun?.outcome, "started", "running while the turn runs");
    for (let i = 0; i < 400 && store.readMemo(p).lastRun?.outcome === "started"; i++) await new Promise((res) => setTimeout(res, 25));
    return store.readMemo(p).lastRun!;
  }

  test("a run that ends normally is recorded finished", async () => {
    stub.reset({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
    const run = await look();
    assert.equal(run.outcome, "finished");
    assert.equal(run.detail, undefined);
    assert.equal(stub.stats.finished, true);
  });

  test("a runaway run the stream guard stops is recorded stopped, with the guard's reason", async () => {
    stub.reset({ payload: "letters", perDelta: 128 });
    const run = await look();
    const chat = await acquireChat(path);
    assert.ok(chat.lastStreamTrip, "the guard tripped");
    assert.equal(run.outcome, "stopped");
    assert.equal(run.detail, chat.lastStreamTrip!.detail);
  });

  test("a run the server's shutdown aborts is recorded cut off by a restart", async () => {
    stub.reset({ payload: "letters", perDelta: 1 });
    const r = await po.lookNow(org.id, project.id, true);
    assert.equal(r.started, true, r.why);
    const chat = await acquireChat(path);
    for (let i = 0; i < 200 && stub.stats.startedAt === null; i++) await new Promise((res) => setTimeout(res, 10));
    recovery.markShutdown();
    try {
      await chat.session.abort();
      for (let i = 0; i < 200 && store.readMemo(p).lastRun?.outcome === "started"; i++) await new Promise((res) => setTimeout(res, 25));
      const run = store.readMemo(p).lastRun!;
      assert.equal(run.outcome, "cut-off");
      assert.equal(run.detail, "The server restarted during the run.");
    } finally {
      recovery.clearShutdownForTest();
    }
  });

  test("a run left running by an earlier process becomes cut off when the loop starts", () => {
    const at = new Date(recovery.PROCESS_START - 60_000).toISOString();
    store.writeMemo(p, { ...store.readMemo(p), lastRun: { at, reasons: ["The operator asked."], outcome: "started" } });
    po.startProjectOverseerLoop();
    const run = store.readMemo(p).lastRun!;
    assert.equal(run.outcome, "cut-off");
    assert.equal(run.detail, "The server restarted during the run.");
    assert.equal(run.at, at, "the same run, not a new one");
  });
});
