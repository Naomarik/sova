// Run: pnpm exec tsx --test server/wrapup-recovery.test.ts. A throwaway PI_CODING_AGENT_DIR and
// workspace in the OS temp dir; ~/.pi is never read or written. No model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { WrapupInfo } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-wrapup-recovery-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const wrap = await import("./baton-wrapup");
const { sweepStaleWrapups, STALE_AFTER_MS } = await import("./wrapup-recovery");
const { onBatonEvent } = await import("./baton-events");

after(() => rmSync(root, { recursive: true, force: true }));

describe("stale wrap-up rows", async () => {
  const org = await orgs.createOrg({ name: "Rec", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = orgs.addProject(org.id, { name: "P", root: join(root, "proj") });
  const tony = orgs.addPerson(org.id, { name: "Tony", role: "IT" });
  const mk = (wrapup: WrapupInfo) => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "t", goal: "g" });
    baton.markDone(c.sessionId, new Date());
    baton.setWrapup(c.sessionId, wrapup);
    return c.sessionId;
  };
  const running = (at: number): WrapupInfo => ({ state: "running", at: new Date(at).toISOString(), applied: 0, refused: [] });
  const state = (sid: string) => baton.batonById(sid)!.row.wrapup;

  test("left running by an earlier process → failed; running here, done or recent → left alone; too old → failed", () => {
    const now = Date.now();
    const start = now - 5_000; // this process started 5 s ago
    const orphan = mk(running(start - 1_000));
    const mine = mk(running(start - 1_000));
    wrap.beginWrapupRun(mine); // this process is running it
    const fresh = mk(running(now - 1_000)); // started by this process, still within any run's time
    const ancient = mk(running(now - STALE_AFTER_MS - 1));
    const ancientMine = mk(running(now - STALE_AFTER_MS - 1));
    wrap.beginWrapupRun(ancientMine);
    const done = mk({ state: "done", at: new Date(start - 1_000).toISOString(), applied: 2, refused: [] });
    const events: string[] = [];
    const off = onBatonEvent((e) => e.type === "wrapup" && events.push(e.sessionId));
    try {
      const changed = sweepStaleWrapups(now, start);
      assert.deepEqual(new Set(changed), new Set([orphan, ancient, ancientMine]));
      assert.deepEqual(new Set(events), new Set(changed), "each change is announced");
      assert.deepEqual(sweepStaleWrapups(now, start), [], "a second sweep changes nothing");
    } finally {
      off();
      wrap.endWrapupRun(mine);
      wrap.endWrapupRun(ancientMine);
    }
    assert.equal(state(orphan)?.state, "failed");
    assert.equal(state(orphan)?.error, "The server shut down during the wrap-up.");
    assert.equal(state(orphan)?.at, running(start - 1_000).at, "keeps when it started");
    assert.equal(state(ancient)?.error, "It ran past 10 minutes without finishing.");
    assert.equal(state(mine)?.state, "running");
    assert.equal(state(fresh)?.state, "running");
    assert.equal(state(done)?.state, "done");
    assert.equal(wrap.wantsWrapup(baton.batonById(orphan)!.row), false, "a recovered row never retries on its own");
    // Control: once this process no longer runs it, the same row is an orphan too.
    assert.deepEqual(sweepStaleWrapups(now, start), [mine]);
  });
});
