import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import labJson from "../../shared/retire-lab.json";
import { stateRoot } from "../state-root";
import { scratchRoot } from "../test-scratch";
import { MergeFailure } from "./queue";
import { needsRehearsal, REHEARSAL_NEEDED, rehearsalPassedAt, rehearsalRefusal, touchesCleanup } from "./rehearsal";
import { makeKit, sh, until } from "./testing/queue-kit";

const NOW = new Date(2026, 5, 10, 12).getTime();
const EARLY_TODAY = new Date(2026, 5, 10, 0, 0, 1).getTime();
const LATE_YESTERDAY = new Date(2026, 5, 9, 23, 59, 59).getTime();
const HEAD = "target-head";
const CLEANUP = "server/worktree-retire.ts\n";
const pass = (commit: string, snapshotAt = EARLY_TODAY) => ({ commit, snapshotAt, passedAt: snapshotAt + 1 });

describe("the rehearsal gate", () => {
  let dir: string;
  let sova: string;
  let other: string;
  let record: string;
  let commits = 0;
  // The gate remembers a commit's answer by root, target and commit: each case gets a commit of its own.
  const fresh = () => `commit-${++commits}`;
  const gitSays = (commit: string, code: number, stdout: string) => async (args: string[], cwd: string) => {
    assert.deepEqual(args, ["diff", "--name-only", `${HEAD}...${commit}`]);
    assert.ok(cwd === sova || cwd === other);
    return { code, stdout };
  };
  const writeRecord = (text: string) => writeFileSync(record, text);
  const writePasses = (...passes: unknown[]) => writeRecord(JSON.stringify({ passes }));

  before(() => {
    dir = scratchRoot("rehearsal-unit-");
    sova = join(dir, "sova");
    other = join(dir, "other");
    record = join(dir, "retire-rehearsals.json");
    mkdirSync(join(sova, "shared"), { recursive: true });
    mkdirSync(other);
    writeFileSync(join(sova, "shared", "retire-lab.json"), "{}");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a pass at the exact commit, on a copy taken today, lets it through", async () => {
    const c = fresh();
    writePasses(pass(c));
    assert.equal(rehearsalPassedAt(c, NOW, record), true);
    assert.equal(await needsRehearsal(gitSays(c, 0, CLEANUP), sova, HEAD, c, NOW, record), false);
  });

  test("a pass at another commit is no pass", async () => {
    const c = fresh();
    writePasses(pass(`${c}0`), pass(c.slice(0, -1)));
    assert.equal(await needsRehearsal(gitSays(c, 0, CLEANUP), sova, HEAD, c, NOW, record), true);
  });

  test("a snapshot from another day is no pass, by a second", async () => {
    const c = fresh();
    writePasses(pass(c, LATE_YESTERDAY));
    assert.equal(await needsRehearsal(gitSays(c, 0, CLEANUP), sova, HEAD, c, NOW, record), true);
  });

  test("a record that can't be read is no pass", async () => {
    const c = fresh();
    const unreadable: (() => void)[] = [
      () => rmSync(record, { force: true }),
      () => writeRecord("{ not json"),
      () => writeRecord(JSON.stringify({ passes: "all of them" })),
      () => writePasses({ ...pass(c), snapshotAt: "today" }),
      () => writePasses(null),
    ];
    for (const make of unreadable) {
      make();
      assert.equal(await needsRehearsal(gitSays(c, 0, CLEANUP), sova, HEAD, c, NOW, record), true);
    }
  });

  test("git can't say what changed: it waits", async () => {
    const c = fresh();
    writePasses();
    assert.equal(await needsRehearsal(gitSays(c, 128, ""), sova, HEAD, c, NOW, record), true);
  });

  test("a repository that isn't Sova's never waits", async () => {
    const c = fresh();
    writePasses();
    assert.equal(await needsRehearsal(gitSays(c, 0, CLEANUP), other, HEAD, c, NOW, record), false);
  });

  test("a change that touches no trigger never waits", async () => {
    const c = fresh();
    writePasses();
    assert.equal(await needsRehearsal(gitSays(c, 0, "server/merge-queue/queue.ts\nREADME.md\n"), sova, HEAD, c, NOW, record), false);
  });

  test("every trigger catches what it names, and only from the repository's root", () => {
    for (const glob of labJson.triggers) {
      const path = glob.replace(/\*/g, "-x.ts");
      assert.equal(touchesCleanup(["README.md", path]), true, path);
      assert.equal(touchesCleanup([`nested/${path}`]), false, `nested/${path}`);
    }
    assert.equal(touchesCleanup(["server/worktree-retire-x/deeper.ts"]), false, "a star stops at a folder");
    assert.equal(touchesCleanup([]), false);
  });
});

describe("the queue's refusals", () => {
  /** A queue on a repository of Sova's, with the record where the queue reads it (the state root the test moved). */
  async function onSovaRepo(body: (k: ReturnType<typeof makeKit>, passes: (...commits: string[]) => void) => Promise<void>) {
    const agentDir = scratchRoot("rehearsal-agent-");
    const inherited = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const k = makeKit({ deps: { now: () => NOW } });
    try {
      mkdirSync(stateRoot(), { recursive: true });
      k.repo.commitOn(k.repo.root, { "shared/retire-lab.json": "{}\n" }, "Sova's own repository");
      sh(k.repo.root, "push", "-q", "origin", k.repo.target);
      await body(k, (...commits) => writeFileSync(join(stateRoot(), "retire-rehearsals.json"), JSON.stringify({ passes: commits.map((c) => pass(c)) })));
    } finally {
      await k.done();
      if (inherited === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inherited;
      rmSync(agentDir, { recursive: true, force: true });
    }
  }

  test("Land on a change to cleanup is refused with nothing queued until a rehearsal passed at that commit, then lands", () =>
    onSovaRepo(async (k, passes) => {
      const b = k.repo.branch("feat/cleanup", { "server/worktree-retire.ts": "x\n" });
      const q = await k.q();
      await assert.rejects(
        q.add({ branch: "feat/cleanup", by: "land-button" }),
        (e: unknown) => e instanceof MergeFailure && e.code === "invalid-request" && e.message === rehearsalRefusal("feat/cleanup", b.head),
      );
      const refused = await q.view();
      assert.deepEqual([refused.checking, refused.waiting, refused.needsYou, refused.needsFix, refused.recent], [[], [], [], [], []], "nothing was queued");
      assert.equal(k.run.inputs.length, 0, "nothing ran");

      passes(b.head);
      const { entry } = await q.add({ branch: "feat/cleanup", by: "land-button" });
      assert.equal(entry.commit, b.head);
      await until(async () => (await k.entry(entry.id)).state === "landed", "landed");
    }));

  test("a checked fix that changes cleanup waits with its chat for a pass of its own", () =>
    onSovaRepo(async (k, passes) => {
      const b = k.repo.branch("feat/cleanup", { "server/worktree-retire.ts": "x\n" });
      passes(b.head);
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed" }));
      const q = await k.q();
      const { entry } = await q.add({ branch: "feat/cleanup", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).requests?.length === 1, "sent back");
      const rq = (await k.entry(entry.id)).requests![0]!;
      const fix = k.repo.commitOn(b.path, { "server/worktree-retire.ts": "fixed\n" }, "fix");
      await q.respond(rq.id, "s1", { answer: "fixed", commit: fix, text: "x" });
      await until(async () => (await k.entry(entry.id)).fix !== undefined, "fix recorded");
      await q.fixRuling(entry.id, rq.id, true, "");
      const e = await until(async () => {
        const now = await k.entry(entry.id);
        return now.reason === REHEARSAL_NEEDED ? now : null;
      }, "waits for its rehearsal");
      assert.deepEqual([e.state, e.commit, k.run.inputs.length], ["with-chat", fix, 1]);
    }));
});
