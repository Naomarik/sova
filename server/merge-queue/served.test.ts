import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { recordGoAhead } from "../../pi-config/extensions/worktrees/landing.ts";
import { definitionAt } from "../project-services/deploy-recipe";
import { checksOf } from "./checks";
import { ingestOnce } from "./ingest";
import { recordedRoots } from "./routes";
import { NOT_SERVED, ServedRule } from "./served";
import { makeKit, makeRepo, type Repo, sh } from "./testing/queue-kit";
import { ingestDepsFor } from "./wire";

/**
 * Plan-review blocker b2 (al_1): a queue record kept for a repo that isn't on the Projects list must not take typed
 * go-aheads. Driven through `ingestDepsFor`, the composition the server itself starts ingest with, so a wiring that
 * counts recorded roots as served fails here.
 */

function declare(repo: Repo, text: string): void {
  mkdirSync(join(repo.root, ".sova"), { recursive: true });
  writeFileSync(join(repo.root, ".sova", "project.json"), text);
  sh(repo.root, "add", ".sova/project.json");
  sh(repo.root, "commit", "-q", "-m", "declare");
}

type Row = { root: string; archived?: { at: string } };
const ruleOver = (rows: () => Row[]) => new ServedRule({ listed: rows, definitionAt: (r, ref) => definitionAt(r, ref), checksOf, ttlMs: 0 });

/** Every queue.json under the queue's base: dir → its text. */
function records(base: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(base)) return out;
  for (const d of readdirSync(base)) {
    const f = join(base, d, "queue.json");
    if (existsSync(f)) out.set(d, readFileSync(f, "utf8"));
  }
  return out;
}

describe("b2: typed go-aheads reach only repos the merge queue serves", () => {
  test("a recorded but unregistered root: refused with the exact sentence, nothing queued, no record written; a listed set-up root still queues", async () => {
    const k = makeKit();
    const stray = makeRepo({ prefix: "mq-stray-", target: "main" });
    try {
      const base = join(k.repo.state, "merge-queue");
      const file = join(k.repo.state, "landing.json");
      declare(k.repo, JSON.stringify({ version: 1, merge: { checks: "none" } }));
      // The stray record a Land press once left (al_1 t5): a root, no entries.
      mkdirSync(join(base, "stray0000000000"), { recursive: true });
      writeFileSync(join(base, "stray0000000000", "queue.json"), JSON.stringify({ v: 1, root: stray.root, project: stray.root, target: "main", entries: [], landed: [] }));
      assert.deepEqual(recordedRoots(base), [stray.root], "the stray record is what recordedRoots sees");
      const q = await k.q();
      await q.pause("hold");

      const listed: Row[] = [{ root: k.repo.root }];
      const refused: { session: string; text: string }[] = [];
      const asked: string[] = [];
      const deps = ingestDepsFor({
        base,
        file,
        rule: ruleOver(() => listed),
        queue: (root) => {
          asked.push(root);
          return k.queues.get(root);
        },
        repoOf: async (session) => (session === "s-stray" ? stray.root : k.repo.root),
        refused: (session, text) => void refused.push({ session, text }),
      });
      assert.deepEqual(await ingestOnce(deps), [], "the first read is a baseline");
      const before = records(base);

      const b = stray.branch("feat/build", { "b.txt": "b\n" });
      recordGoAhead({ branch: "feat/build", commit: b.head, session: "s-stray", at: "2026-11-03T10:00:00Z", by: "owner-chat" }, file);
      const did = await ingestOnce(deps);
      assert.equal(did.length, 1);
      assert.match(did[0]!, /refused: not a project the merge queue serves/, "the stray root was found and refused, not missed");
      assert.deepEqual(refused, [{ session: "s-stray", text: `feat/build at ${b.head.slice(0, 7)} couldn't be queued to land: ${NOT_SERVED}.` }]);
      assert.equal(NOT_SERVED, "not a project the merge queue serves: merge it into main from the chat");
      assert.deepEqual(asked, [], "the queue is never asked for an unserved root");
      assert.deepEqual(records(base), before, "no queue record written or changed");
      assert.equal(q.entries().length, 0);

      // The listed, set-up project: as today.
      const ok = k.repo.branch("feat/ok", { "ok.txt": "ok\n" });
      recordGoAhead({ branch: "feat/ok", commit: ok.head, session: "s-ok", at: "2026-11-03T10:00:01Z", by: "owner-chat" }, file);
      const did2 = await ingestOnce(deps);
      assert.match(did2[0]!, /^queued feat\/ok/);
      assert.equal(q.entries().find((e) => e.branch === "feat/ok")?.approval.by, "typed");
      assert.equal(refused.length, 1);

      // Archived (contract §6): no longer served; refused like the stray.
      listed[0] = { root: k.repo.root, archived: { at: "2026-11-03T10:00:02Z" } };
      const late = k.repo.branch("feat/late", { "late.txt": "l\n" });
      recordGoAhead({ branch: "feat/late", commit: late.head, session: "s-late", at: "2026-11-03T10:00:03Z", by: "owner-chat" }, file);
      await ingestOnce(deps);
      assert.equal(q.entries().some((e) => e.branch === "feat/late"), false, "an archived project's go-ahead isn't queued");
      assert.match(refused[1]?.text ?? "", /not a project the merge queue serves/);
    } finally {
      stray.done();
      await k.done();
    }
  });

  test("listed without a merge setup: refused, no record; listed with a definition that doesn't parse: taken (a broken setup is said, not bypassed)", async () => {
    const bare = makeRepo({ prefix: "mq-bare-" });
    const broken = makeRepo({ prefix: "mq-broken-" });
    const k = makeKit({ repo: broken });
    try {
      declare(broken, "{ not json");
      const base = join(broken.state, "merge-queue");
      const file = join(broken.state, "landing.json");
      const refused: string[] = [];
      const asked: string[] = [];
      const deps = ingestDepsFor({
        base,
        file,
        rule: ruleOver(() => [{ root: bare.root }, { root: broken.root }]),
        queue: (root) => {
          asked.push(root);
          return k.queues.get(root);
        },
        repoOf: async (session) => (session === "s-x" ? bare.root : broken.root),
        refused: (_s, t) => void refused.push(t),
      });
      await ingestOnce(deps);
      const x = bare.branch("feat/x", { "x.txt": "x\n" });
      recordGoAhead({ branch: "feat/x", commit: x.head, session: "s-x", at: "2026-11-03T11:00:00Z", by: "owner-chat" }, file);
      await ingestOnce(deps);
      assert.match(refused[0] ?? "", /couldn't be queued to land: not a project the merge queue serves: merge it into main from the chat\.$/);
      assert.deepEqual(asked, [], "listed but not set up: the queue is never asked");
      assert.deepEqual([...records(base).values()].filter((t) => t.includes(bare.root)), [], "no record for the bare repo");

      const y = broken.branch("feat/y", { "y.txt": "y\n" });
      recordGoAhead({ branch: "feat/y", commit: y.head, session: "s-y", at: "2026-11-03T11:00:01Z", by: "owner-chat" }, file);
      await ingestOnce(deps);
      assert.deepEqual(asked, [broken.root], "an invalid definition still counts as set up: the queue is asked (and says what is wrong)");
    } finally {
      bare.done();
      await k.done();
      broken.done();
    }
  });

  test("a served repo whose branch moved past the go-ahead (amended, rebased): refused as a moved head, never NOT_SERVED; a chat whose repo can't be resolved or isn't served still hears NOT_SERVED", async () => {
    const k = makeKit();
    const side = makeRepo({ prefix: "mq-side-" });
    try {
      const base = join(k.repo.state, "merge-queue");
      const file = join(k.repo.state, "landing.json");
      declare(k.repo, JSON.stringify({ version: 1, merge: { checks: "none" } }));
      const q = await k.q();
      await q.pause("hold");
      const refused: { session: string; text: string }[] = [];
      const repos: Record<string, string> = { "s-amend": k.repo.root, "s-side": side.root };
      const deps = ingestDepsFor({
        base,
        file,
        rule: ruleOver(() => [{ root: k.repo.root }]),
        queue: (root) => k.queues.get(root),
        repoOf: async (session) => repos[session] ?? null,
        refused: (session, text) => void refused.push({ session, text }),
      });
      await ingestOnce(deps);

      const b = k.repo.branch("feat/amend", { "a.txt": "a\n" });
      recordGoAhead({ branch: "feat/amend", commit: b.head, session: "s-amend", at: "2026-11-03T12:00:00Z", by: "owner-chat" }, file);
      sh(b.path, "commit", "-q", "--amend", "-m", "amended");
      assert.notEqual(sh(b.path, "rev-parse", "HEAD"), b.head, "the go-ahead's commit is no longer on the branch");
      await ingestOnce(deps);
      assert.equal(refused.length, 1);
      assert.equal(refused[0]!.session, "s-amend");
      assert.doesNotMatch(refused[0]!.text, /not a project the merge queue serves/, "a served repo is never told to merge it itself");
      assert.match(refused[0]!.text, /^feat\/amend at [0-9a-f]{7} couldn't be queued to land: .*feat\/amend/);
      assert.equal(q.entries().length, 0);

      // Not served (unlisted) and unresolvable chats: the plain-merge sentence.
      recordGoAhead({ branch: "feat/gone", commit: "b".repeat(40), session: "s-side", at: "2026-11-03T12:00:01Z", by: "owner-chat" }, file);
      recordGoAhead({ branch: "feat/gone", commit: "c".repeat(40), session: "s-unknown", at: "2026-11-03T12:00:02Z", by: "owner-chat" }, file);
      await ingestOnce(deps);
      assert.equal(refused.length, 3);
      for (const r of refused.slice(1)) assert.match(r.text, /couldn't be queued to land: not a project the merge queue serves: merge it into main from the chat\.$/, r.session);
    } finally {
      side.done();
      await k.done();
    }
  });
});
