// Run: pnpm exec tsx --test server/wrapup-recovery.test.ts. A throwaway PI_CODING_AGENT_DIR and
// workspace in the OS temp dir; ~/.pi is never read or written. No model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-wrapup-recovery-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const wrap = await import("./baton-wrapup");
const { closeOrgHost, hostOf, setOrgClockForTest } = await import("./org-engine");
const { replyEnded } = await import("./org-test-fixtures");

after(() => rmSync(root, { recursive: true, force: true }));

/** The wrap-up runs in the baton chart (its :sova/wrapup run): left running by a process that stopped, or past
    its time, the chart records it failed itself. No sweeper. */
describe("a wrap-up that never ended", async () => {
  const org = await orgs.createOrg({ name: "Rec", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "P", root: join(root, "proj") });
  const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT" });
  /** Runs that never answer: the wrap-up stays running until the chart ends it. */
  const hang = () => hostOf(org.id).invocations.register("sova/wrapup", { start() {}, stop() {} });
  /** A session Tony wrote in, done: its wrap-up starts at once. */
  const running = async () => {
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "t", goal: "g" });
    baton.noteMessage(c.sessionId, tony.id);
    await replyEnded(c.sessionId);
    await baton.markDone(c.sessionId);
    assert.equal(baton.batonById(c.sessionId)!.row.wrapup?.state, "running");
    return c.sessionId;
  };
  const wrapup = (sid: string) => baton.batonById(sid)!.row.wrapup;

  test("left running when the server stopped: failed at the next start, saying so; never retried on its own", async () => {
    hang();
    const orphan = await running();
    const at = wrapup(orphan)!.at;
    const silent = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "s", goal: "g" });
    await baton.markDone(silent.sessionId); // nobody wrote: skipped, and left alone
    await closeOrgHost(org.id);
    await orgs.openAttachedOrgs();
    assert.equal(wrapup(orphan)?.state, "failed");
    assert.equal(wrapup(orphan)?.error, "The server shut down during the wrap-up.");
    assert.equal(wrapup(orphan)?.at, at, "keeps when it started");
    assert.equal(wrap.wantsWrapup(baton.batonById(orphan)!.row), false, "a recovered row never retries on its own");
    assert.equal(wrapup(silent.sessionId)?.state, "skipped");
  });

  test("past its time (10 minutes): failed by the chart's own timer; one still in time is left alone", async () => {
    hang();
    const late = await running();
    const t0 = Date.now();
    setOrgClockForTest(() => t0 + 10 * 60_000);
    try {
      hostOf(org.id).fireDue();
      assert.equal(wrapup(late)?.state, "running", "not before its time");
      setOrgClockForTest(() => t0 + 11 * 60_000 + 1);
      hostOf(org.id).fireDue();
      assert.equal(wrapup(late)?.state, "failed");
      assert.equal(wrapup(late)?.error, "It ran past 10 minutes without finishing.");
      assert.equal(wrap.wantsWrapup(baton.batonById(late)!.row), false);
    } finally {
      setOrgClockForTest(null);
    }
  });
});
