// Run: pnpm exec tsx --test server/project-overseer-watch-run.test.ts. The project overseer's
// unattended runs end to end on a local stub model (server/stream-stub.ts, through pi's real
// openai-completions provider): the last run records how it really ended. A throwaway
// PI_CODING_AGENT_DIR; ~/.pi is never read or written and no real model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startStreamStub, stubModelsJson } from "./stream-stub";
import { clockTime } from "../pi-config/extensions/stamp/format.ts";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-run-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const stub = await startStreamStub({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(stubModelsJson(stub.port)));

const orgs = await import("./orgs");
const { closeOrgHost, hostOf } = await import("./org-engine");
const po = await import("./project-overseer");
const { allBatons } = await import("./baton");
const store = await import("./project-overseer-store");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const recovery = await import("./wrapup-recovery");

after(async () => {
  po.setClockForTest(null);
  await disposeAllChats();
  await stub.close();
  await settled(join(root, "ws"));
  await settled(join(root, "ws2"));
  rmSync(root, { recursive: true, force: true });
});

type LastRun = NonNullable<ReturnType<typeof store.readMemo>["lastRun"]>;

describe("the overseer's last run says how it ended", async () => {
  const org = await orgs.createOrg({ name: "Runs", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
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

  test("a run the server's shutdown aborts is recorded cut off by the next start, the same run", async () => {
    stub.reset({ payload: "letters", perDelta: 1 });
    const r = await po.lookNow(org.id, project.id, true);
    assert.equal(r.started, true, r.why);
    const at = store.readMemo(p).lastRun!.at;
    const chat = await acquireChat(path);
    for (let i = 0; i < 200 && stub.stats.startedAt === null; i++) await new Promise((res) => setTimeout(res, 10));
    recovery.markShutdown();
    try {
      await chat.session.abort();
      await new Promise((res) => setTimeout(res, 50));
      assert.equal(store.readMemo(p).lastRun?.outcome, "started", "nothing recorded while the process goes down");
      // The next process: its org engine resumes the watch, whose look was running (`sova/resumed`).
      await closeOrgHost(org.id);
      await orgs.openAttachedOrgs();
      const run = store.readMemo(p).lastRun!;
      assert.equal(run.outcome, "cut-off");
      assert.equal(run.detail, "The server restarted during the run.");
      assert.equal(run.at, at, "the same run, not a new one");
    } finally {
      recovery.clearShutdownForTest();
    }
  });
});

/**
 * The stalled story (bw-e2e round 3, R1-c): the operator's one goal message started a gathering
 * session, and the looks on its own that followed drew on that message's allowance of 3, so the
 * 4th gathering session the story needed was refused, and the overseer said it would start it "on
 * its next look", which nothing scheduled.
 */
describe("a story that needs 4 gathering sessions goes on by itself", async () => {
  const org = await orgs.createOrg({ name: "Story", dir: join(root, "ws2") });
  await orgs.addPerson(org.id, { name: "Alperen", role: "Owner", decides: ["menu", "hours"] });
  const gather = JSON.stringify({ gap: "none", person: "Alperen", why: "Nobody has said this yet.", public_title: "Opening hours", goal: "Settle the opening hours.", question: "When should the shop open?" });

  async function setUp(name: string) {
    mkdirSync(join(root, name));
    const project = await orgs.addProject(org.id, { name, root: join(root, name) });
    const p = store.projectOverseerPaths(org.id, project.id);
    // No hold (q10): its unattended starts go at once; these tests are about the allowances.
    store.patchPoSettings(p, { holdMin: 0 });
    const { path } = await po.ensureProjectOverseer(org.id, project.id);
    const chat = await acquireChat(path);
    await chat.setModelRef("stub/runaway");
    const started = () => allBatons().filter((b) => b.projectId === project.id && typeof b.owner === "object" && b.owner.overseerOf === project.id).length;
    const settle = async () => {
      for (let i = 0; i < 400 && store.readMemo(p).lastRun?.outcome === "started"; i++) await new Promise((res) => setTimeout(res, 25));
    };
    /** One look on its own that calls sova_start_gathering once. */
    const look = async () => {
      stub.reset({ payload: "letters", perDelta: 16, tool: "sova_start_gathering", args: gather });
      const r = await po.lookNow(org.id, project.id, true);
      assert.equal(r.started, true, r.why);
      await settle();
      assert.equal(store.readMemo(p).lastRun?.outcome, "finished");
    };
    const refusals = () =>
      readFileSync(p.actions, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((a) => a.outcome === "refused");
    return { project, p, path, chat, started, look, settle, refusals };
  }

  test("the operator's goal starts 1; 3 looks on its own start 3 more with the default limits, and nobody writes", async () => {
    const s = await setUp("story");
    stub.reset({ payload: "letters", perDelta: 16, tool: "sova_start_gathering", args: gather });
    const { turn } = s.chat.acceptPrompt("Get the menu, hours, prices and delivery decided.", undefined, "client");
    await turn;
    assert.equal(s.started(), 1, "the operator's own turn");
    for (let i = 0; i < 3; i++) await s.look();
    assert.equal(s.started(), 4, "the 4th gathering session starts with no operator message");
    assert.deepEqual(s.refusals(), []);
    const info = await po.projectOverseerInfo(org.id, s.project.id);
    assert.equal(info.usage.allowance.message.gather.used, 1);
    assert.equal(info.usage.allowance.today.gather.used, 3);
  });

  test("with 2 a day on its own: the 3rd is refused and held, and the next day's tick looks again and starts it", async () => {
    const s = await setUp("capped");
    await po.patchProjectOverseer(org.id, s.project.id, { caps: { gatherPerDay: 2 } });
    await s.look();
    await s.look();
    await s.look();
    assert.equal(s.started(), 2);
    assert.deepEqual(s.refusals().map((a) => a.error), ["Today's allowance is used: 2 of 2 gathering sessions started on its own. It looks again at midnight."]);
    const held = store.readMemo(s.p).held;
    const midnight = store.nextMidnight(new Date());
    assert.deepEqual(held.map((h) => [h.key, h.retryAt]), [["day:gather", midnight.toISOString()]]);
    assert.deepEqual(store.readMemo(s.p).pending, [], "nothing waits but the held item");
    // The next day: the watch's midnight turns it into a reason to look soon, and the day's allowance is fresh.
    po.setClockForTest(() => midnight.getTime() + 3_600_000);
    // The statecharts' midnight (the watch's day ledger) is a host timer: fired now that the clock has passed it.
    hostOf(org.id).fireDue();
    try {
      stub.reset({ payload: "letters", perDelta: 16, tool: "sova_start_gathering", args: gather });
      assert.deepEqual(store.readMemo(s.p).held, [], "released at midnight");
      // The soon look (a minute on, on the watch's 20 s tick).
      po.setClockForTest(() => midnight.getTime() + 3_600_000 + 2 * 60_000);
      hostOf(org.id).fireDue();
      const run = store.readMemo(s.p).lastRun!;
      assert.deepEqual(run.reasons, [`Today's allowance is back: it may start gathering sessions again (refused ${clockTime(held[0]!.since)}).`]);
      await s.settle();
      assert.equal(s.started(), 3);
      assert.deepEqual(store.readMemo(s.p).held, []);
    } finally {
      po.setClockForTest(null);
    }
  });
});
