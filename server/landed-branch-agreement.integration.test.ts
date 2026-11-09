// §chat.worktrees/nothing-left: every place that asks "does this branch have anything of its own left to land?" gives
// one answer. Each case below is a real git repository with the real queue on it (testing/harness.ts), its branch shaped
// the way the shape arises in use, and every reader asked at the same moment. A case fails naming the whole table when
// any reader differs from what the case requires, so two readers can't disagree and pass. The two that remove folders are
// deliberately none of them (landed-labels-no-removal.integration.test.ts).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LIST_PLUS, resolution, settled, setup } from "./merge-queue/testing/scenario-kit";
import { Fixture, git, until } from "./merge-queue/testing/repo";
import { type HarnessOptions, type QueueHarness } from "./merge-queue/testing/harness";
import { queueGlanceOf, worktreeQueueInfo } from "./merge-queue/view";
import { writeOverride } from "./merge-queue/strategy";
import { computeBranches, computeReadiness, configureReadiness } from "./merge-readiness";
import { branchLeft } from "./nothing-left";
import { treeBucket } from "./overseer-roundup";
import { setOfferDeps, showOffer } from "./session-offers";
import { execGit, worktreeInsights } from "./worktrees";
import { goneTreeState } from "./removed-worktrees";
import { getSessionInsight } from "./insights";
import { rowKeyOf, type RowKeyInput } from "../src/lib/merge-queue";
import { treeMerge } from "../src/lib/agents-board";
import type { MergeEntry } from "../shared/merge-queue";
import type { SessionSummary, WorktreeReadiness } from "../shared/protocol";
import type { QueueDeps } from "./merge-queue/queue";

// A finished chat's reading, so Ready to land is what a real chat would see; served, as every fixture is.
configureReadiness({ finished: () => "yes", served: async () => true });

type B = { branch: string; checkout: string; commit: string };

/** Land `b` and wait for it. */
async function land(h: QueueHarness, branch: string): Promise<MergeEntry> {
  const e = await h.add({ branch });
  const done = await h.waitEntry(e.id, settled);
  assert.equal(done.state, "landed", `${branch}: ${done.state}: ${done.reason ?? ""}`);
  return done;
}
const landNew = async (fx: Fixture, h: QueueHarness, name: string, files: Record<string, string>): Promise<{ b: B; e: MergeEntry }> => {
  const b = fx.branch(name, files);
  return { b, e: await land(h, b.branch) };
};

// ---------------------------------------------------------------- the readers

/** The one question's answers. `unknown` is the shared answer's alone: every other reader has no way to say it, and must read it as work. */
type Left = "nothing" | "drafts" | "work" | "unknown";

interface Readings {
  answer: Left;
  readiness: Left;
  branches: Left;
  ready: Left;
  count: Left;
  land: Left;
  row: Left;
  /** The row where this chat has no readiness of its own for it (an inherited tree), on the branch row's facts alone. With a queue entry
      and no reading, a row stays what the entry says (§chat.composer/worktrees-control), so the entry is left out. */
  inheritedRow: Left;
  bucket: Left;
  /** The Agents board reads the code alone (§app.insights/subagent-cards), so it says nothing of drafts: `drafts` here is the code's "nothing". */
  board: Left;
}

/** Row keys with nothing of the branch's own left to land; `drafts-to-land` is drafts; everything else is work. */
const NOTHING_KEYS = new Set(["landed", "merged", "removed", "no-commits", "cleaned-up"]);

const SESSION = "01a0edcd-e385-72b1-a202-737eb23ceb52";
/** The tracked record a chat holds for this tree. */
const trackedBy = (fx: Fixture, b: B) => ({ path: b.checkout, branch: b.branch, base: git(fx.project, ["rev-list", "--max-parents=0", fx.target]), baseBranch: fx.target, session: SESSION, status: "active" });
const SUMMARY = (fx: Fixture, b: B) => ({ id: SESSION, path: join(fx.state, `${SESSION}.jsonl`), cwd: b.checkout, lastActiveAt: new Date(0).toISOString() }) as unknown as SessionSummary;

/** The tree as a chat's readiness reads it. */
async function chatReading(fx: Fixture, b: B): Promise<WorktreeReadiness | undefined> {
  const r = await computeReadiness(SUMMARY(fx, b), { trees: [trackedBy(fx, b)], merges: [] } as unknown as Parameters<typeof computeReadiness>[1], () => false, true);
  return r?.trees.find((t) => t.path === b.checkout);
}

/** The tree as the Session tab reads it, through the real session insight on a real session file. */
let tabFiles = 0;
async function sessionTabRow(fx: Fixture, b: B) {
  const path = join(fx.state, `session-tab-${++tabFiles}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: SESSION, timestamp: "2026-10-04T10:00:00.000Z", cwd: b.checkout },
    { type: "custom", customType: "worktrees", id: "e1", parentId: null, timestamp: "2026-10-04T10:00:01.000Z", data: { version: 1, trees: [{ ...trackedBy(fx, b), how: "created", at: 1 }] } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const rows = (await getSessionInsight(path)).worktrees ?? [];
  return { rows, row: rows.find((r) => r.path === b.checkout) };
}

/** The tree as the session's branch rows (the composer's control) read it. */
async function branchRow(fx: Fixture, b: B) {
  const rows = await computeBranches(SUMMARY(fx, b), { trees: [trackedBy(fx, b)] } as unknown as Parameters<typeof computeBranches>[1]);
  return rows?.find((r) => r.row.path === b.checkout)?.row;
}

/** Ask every reader, at one moment. The Land gate is asked with the queue paused and its entry cancelled, so asking changes nothing. */
async function readAll(fx: Fixture, h: QueueHarness, b: B): Promise<{ left: Readings; detail: Record<string, unknown> }> {
  const target = { name: fx.target, oid: fx.head() };
  const head = git(b.checkout, ["rev-parse", "HEAD"]);
  const shared = await branchLeft({ root: fx.project, folder: b.checkout, branch: b.branch, head, target });
  const reading = await chatReading(fx, b);
  const rowOfBranch = await branchRow(fx, b);
  // The view caches the Ready list for 15 s per target head; the answer asked here must be today's.
  (h.queue() as unknown as { readyCache: unknown }).readyCache = null;
  const view = await h.view();
  const readyRow = (view.ready ?? []).find((r) => r.branch === b.branch);
  const queue = worktreeQueueInfo(view, b.branch);
  const rowInput: RowKeyInput = { status: "active", exists: true, ...(reading ? { readiness: reading } : {}), ...(queue ? { queue } : {}) };
  const rowKey = rowKeyOf(rowInput);
  const inheritedKey = rowOfBranch ? rowKeyOf(rowOfBranch as RowKeyInput) : null;
  const bucket = reading ? treeBucket(reading) : null;
  const status = await worktreeInsights.treeStatus(b.checkout);
  const merge = status ? treeMerge(status) : null;
  const counted = (queueGlanceOf(view)?.ready ?? -1);
  await h.pause("asking the Land gate");
  const gate = await h.tryAdd({ branch: b.branch });
  if (gate.ok) await h.cancel(gate.entry.id);
  await h.resume();
  return {
    left: {
      answer: shared.whole === "unknown" ? "unknown" : shared.nothingLeft ? "nothing" : shared.code.left ? "work" : "drafts",
      readiness: reading?.left ?? "work",
      branches: rowOfBranch?.left ?? "work",
      ready: !readyRow ? "nothing" : readyRow.draftsOnly ? "drafts" : "work",
      // The count is the Ready list's length (one answer), so it must hold this row exactly when the list does.
      count: counted !== (view.ready ?? []).length ? "unknown" : !readyRow ? "nothing" : readyRow.draftsOnly ? "drafts" : "work",
      // Land can't tell work from drafts: it takes both. Its answer counts as whichever the rest of the row says.
      land: gate.ok ? (shared.code.left ? "work" : "drafts") : "nothing",
      row: rowKey === "drafts-to-land" ? "drafts" : NOTHING_KEYS.has(rowKey) ? "nothing" : "work",
      inheritedRow: inheritedKey === "drafts-to-land" ? "drafts" : inheritedKey && NOTHING_KEYS.has(inheritedKey) ? "nothing" : "work",
      bucket: bucket === "specs" ? "drafts" : bucket === null || bucket === "leftover" ? "nothing" : "work",
      board: merge?.kind === "merged" ? (shared.drafts.length ? "drafts" : "nothing") : "work",
    },
    detail: { inheritedKey, kind: shared.code.kind, error: shared.code.error, whole: shared.whole, codeOnly: shared.codeOnly, drafts: shared.drafts, rowKey, bucket, board: merge, why: reading?.why, reason: reading?.reason, readyLeft: readyRow?.left, gate: gate.ok ? "accepted" : gate.message },
  };
}

/** The whole table in the failure, so what's wrong is one look away. Unknown: the shared answer says so, and everyone else reads work. */
function assertAgree(name: string, want: Left, r: { left: Readings; detail: Record<string, unknown> }): void {
  const wrong = Object.entries(r.left).filter(([k, v]) => v !== (want === "unknown" && k !== "answer" ? "work" : want)).map(([k]) => k);
  assert.deepEqual(wrong, [], `${name}: should read ${want}. Readers ${JSON.stringify(r.left)}; ${JSON.stringify(r.detail)}`);
}

// ---------------------------------------------------------------- the cases

/** The stand-in host a squash needs: the host's own merge is `squash`, as the host's button would. */
function squashHost() {
  const reqs = new Map<number, { head: string; base: string; title: string; state: "open" | "merged" | "closed"; mergeCommit: string | null }>();
  let origin = "";
  let next = 1;
  const facts = (n: number) => {
    const r = reqs.get(n)!;
    const headSha = git(origin, ["rev-parse", "-q", "--verify", `refs/heads/${r.head}`], { allowFail: true }) || null;
    return { number: n, url: `https://github.com/o/r/pull/${n}`, state: r.state, checks: "pending" as const, review: "none" as const, mergeable: "unknown" as const, headSha, headBranch: r.head, baseBranch: r.base, mergeCommit: r.mergeCommit, mergedAt: null };
  };
  const adapter = {
    kind: "github" as const,
    cli: "gh" as const,
    auth: async () => ({ ok: true as const }),
    find: async (_r: unknown, q: { head: string; base: string }) => {
      for (const [n, r] of reqs) if (r.head === q.head && r.base === q.base && r.state === "open") return { ok: true as const, request: facts(n) };
      return { ok: true as const, request: null };
    },
    create: async (_r: unknown, c: { head: string; base: string; title: string }) => {
      const n = next++;
      reqs.set(n, { head: c.head, base: c.base, title: c.title, state: "open", mergeCommit: null });
      return { ok: true as const, request: facts(n) };
    },
    update: async () => ({ ok: true as const }),
    view: async (_r: unknown, n: number) => ({ ok: true as const, request: facts(n) }),
  };
  return {
    reqs,
    setOrigin: (o: string) => void (origin = o),
    deps: { hostAdapter: () => adapter, hostRepo: async () => ({ kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" }) } as unknown as Partial<QueueDeps>,
  };
}

/** A branch with no history in common with the target. It carries the target's files, so its definition is the project's and only its history is odd. */
function orphanIn(fx: Fixture, checkout: string, branch: string): void {
  git(fx.project, ["worktree", "add", "-q", "--orphan", "-b", branch, checkout]);
  git(checkout, ["checkout", "-q", fx.target, "--", "."]);
  writeFileSync(join(checkout, "alone.txt"), "alone\n");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-q", "-m", "no parent"]);
}

/** A commit that holds a check at its gate, so a test can act between approval and landing. */
const GATED = { "tests/g.txt": "gate hold\n" };

interface Built {
  fx: Fixture;
  h: QueueHarness;
  b: B;
  /** What every reader must say. */
  left: Left;
}

/** A landing the host squashed, its pinned commit never on the target by ancestry. */
async function squashed(o: { leftover: boolean; rewrite: boolean; checks?: "none" }): Promise<Built> {
  const host = squashHost();
  const { fx, h } = await setup(o.checks ? { checks: o.checks } : {}, { deps: host.deps });
  host.setOrigin(fx.origin);
  writeOverride(h.queue().store.dir, "github-pr");
  const b = fx.branch("squashed", { "s.txt": "s\n" });
  const e = await h.add({ branch: b.branch });
  await h.waitEntry(e.id, ["request-review"]);
  await h.queue().publish(e.id, { title: "S", body: "Adds s.", draft: false });
  await h.waitEntry(e.id, ["requested"]);
  if (o.leftover) {
    // A landing the local queue doesn't see moves the target, and the chat merges it in while its request is open.
    fx.moveTargetOutside({ "m.txt": "m\n" });
    git(fx.project, ["push", "-q", "origin", fx.target]);
    git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
  }
  // The host's squash, from a clone of its own.
  const side = join(fx.root, "host-side");
  git(fx.root, ["clone", "-q", fx.origin, side]);
  git(side, ["fetch", "-q", join(fx.project, ".git"), `${b.commit}:refs/heads/squash-from`]);
  git(side, ["merge", "-q", "--squash", "squash-from"]);
  git(side, ["commit", "-q", "-m", "S (#1)"]);
  git(side, ["push", "-q", "origin", fx.target]);
  host.reqs.get(1)!.state = "merged";
  host.reqs.get(1)!.mergeCommit = git(side, ["rev-parse", "HEAD"]);
  await h.queue().pollHost();
  assert.equal((await h.entry(e.id)).state, "landed");
  await h.queue().updateLocalMain();
  writeOverride(h.queue().store.dir, null); // what comes after this case lands locally, with no host to wait for
  if (o.rewrite) await landNew(fx, h, "rewrites", { "s.txt": "rewritten on the target\n" });
  return { fx, h, b, left: "nothing" };
}

const CASES: { name: string; noMoreLandings?: boolean; build: () => Promise<Built> }[] = [
  {
    name: "normal landed: head is the pin, on the target",
    build: async () => {
      const { fx, h } = await setup();
      const { b } = await landNew(fx, h, "plain", { "plain.txt": "p\n" });
      return { fx, h, b, left: "nothing" };
    },
  },
  {
    name: "a catch-up merge between approval and landing, clean",
    build: async () => {
      const { fx, h } = await setup();
      const b = fx.branch("between", GATED);
      await landNew(fx, h, "other", { "o.txt": "o\n" });
      const e = await h.add({ branch: b.branch });
      await until("at its gate", () => fx.atGate("hold"));
      git(b.checkout, ["merge", "-q", "--no-edit", fx.target]);
      fx.openGate("hold");
      assert.equal((await h.waitEntry(e.id, settled)).state, "landed");
      // The next landing moves the target, so the head is no longer one a trial merge happens to leave alone by accident.
      await landNew(fx, h, "later", { "l.txt": "l\n" });
      return { fx, h, b, left: "nothing" };
    },
  },
  {
    name: "OpenAI login's shape: a merge with a hand-regenerated file between approval and landing; the target regenerates it, so a trial merge conflicts for good",
    build: async () => {
      const { fx, h } = await setup();
      const b = fx.branch("regen", GATED);
      await landNew(fx, h, "gen0", { "docs/gen.md": "rows 1\n" });
      const e = await h.add({ branch: b.branch });
      await until("at its gate", () => fx.atGate("hold"));
      git(b.checkout, ["merge", "-q", "--no-edit", fx.target]);
      writeFileSync(join(b.checkout, "docs/gen.md"), "rows 1 regenerated on the branch\n");
      git(b.checkout, ["add", "-A"]);
      git(b.checkout, ["commit", "-q", "--amend", "--no-edit"]);
      fx.openGate("hold");
      assert.equal((await h.waitEntry(e.id, settled)).state, "landed");
      await landNew(fx, h, "gen1", { "docs/gen.md": "rows 1\nrows 2\n" });
      const tip = git(b.checkout, ["rev-parse", "HEAD"]);
      assert.notEqual(git(fx.project, ["merge-tree", "--write-tree", "--name-only", fx.target, tip], { allowFail: true }).split("\n")[0], fx.tree(), "the trial merge really differs");
      return { fx, h, b, left: "nothing" };
    },
  },
  {
    name: "a merge after landing: --no-ff, so a real merge sits on the pin",
    build: async () => {
      const { fx, h } = await setup();
      const { b } = await landNew(fx, h, "after", { "after.txt": "a\n" });
      await landNew(fx, h, "other", { "o.txt": "o\n" });
      git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
      return { fx, h, b, left: "nothing" };
    },
  },
  {
    name: "a landing whose conflict the merge thread resolved",
    build: async () => {
      const thread: HarnessOptions["thread"] = {
        conflict: async (h, e) => {
          const c = resolution(h.fx, e.commit, "src/list.txt", LIST_PLUS("delta\necho"));
          await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "delta", theirs: "echo", proposal: "keep both", commit: c });
        },
      };
      const { fx, h } = await setup({}, { thread });
      const b = fx.branch("conflicted", { "src/list.txt": LIST_PLUS("echo") });
      await landNew(fx, h, "first", { "src/list.txt": LIST_PLUS("delta") });
      await land(h, b.branch);
      return { fx, h, b, left: "nothing" };
    },
  },
  {
    name: "a squash on the host plus a leftover merge made while its request was open",
    build: () => squashed({ leftover: true, rewrite: false }),
  },
  {
    name: "a squash on the host, the head still the pin; the target then rewrites the file, so a trial merge conflicts",
    build: () => squashed({ leftover: false, rewrite: true }),
  },
  {
    name: "a squash on the host plus a leftover merge; the target then rewrites the file, so a trial merge conflicts",
    build: () => squashed({ leftover: true, rewrite: true }),
  },
  {
    name: "a queue copy resolve-mq_* with both parents on the target, which then regenerates the file: merges only, no landing of its own, a trial merge conflicts",
    build: async () => {
      const { fx, h } = await setup();
      const a = fx.branch("pin", { "docs/gen.md": "branch\n" });
      await landNew(fx, h, "moved", { "m.txt": "m\n" });
      const checkout = fx.worktreeOf("resolve-mq_regen");
      git(fx.project, ["worktree", "add", "-q", "-b", "feat/resolve-mq_regen", checkout, fx.head()]);
      git(checkout, ["merge", "-q", "--no-ff", "--no-edit", a.commit]);
      writeFileSync(join(checkout, "docs/gen.md"), "regenerated by the thread\n");
      git(checkout, ["add", "-A"]);
      git(checkout, ["commit", "-q", "--amend", "--no-edit"]);
      await land(h, a.branch);
      await landNew(fx, h, "regen", { "docs/gen.md": "regenerated on the target\n" });
      return { fx, h, b: { branch: "feat/resolve-mq_regen", checkout, commit: git(checkout, ["rev-parse", "HEAD"]) }, left: "nothing" };
    },
  },
  {
    name: "a leftover merge on a branch with 21 later landings: the entry has left the view's window, and the answer hasn't moved",
    build: async () => {
      const { fx, h } = await setup({ checks: "none" });
      const b = fx.branch("old", { "old.txt": "old\n" });
      await landNew(fx, h, "base0", { "gen.txt": "0\n" });
      // Paused, so the catch-up merge lands between approval and landing with no check gate to hold it.
      await h.pause("holding the line for the merge");
      const e = await h.add({ branch: b.branch });
      git(b.checkout, ["merge", "-q", "--no-edit", fx.target]);
      writeFileSync(join(b.checkout, "gen.txt"), "0 regenerated on the branch\n");
      git(b.checkout, ["add", "-A"]);
      git(b.checkout, ["commit", "-q", "--amend", "--no-edit"]);
      await h.resume();
      assert.equal((await h.waitEntry(e.id, settled)).state, "landed");
      await landNew(fx, h, "regen", { "gen.txt": "0\n1\n" });
      for (let i = 1; i <= 21; i++) await landNew(fx, h, `later${i}`, { [`later${i}.txt`]: `${i}\n` });
      assert.ok(!(await h.view()).recent.some((r) => r.entry.id === e.id), "the entry really fell out of the view's window");
      return { fx, h, b, left: "nothing" };
    },
  },
  {
    name: "a real commit after landing is work",
    build: async () => {
      const { fx, h } = await setup();
      const { b } = await landNew(fx, h, "more", { "more.txt": "m\n" });
      await landNew(fx, h, "other", { "o.txt": "o\n" });
      fx.commitIn(b.checkout, { "real.txt": "real\n" }, "real work");
      return { fx, h, b, left: "work" };
    },
  },
  {
    name: "a real commit past a landing, hidden under a catch-up merge, is work",
    build: async () => {
      const { fx, h } = await setup();
      const { b } = await landNew(fx, h, "hidden", { "hidden.txt": "h\n" });
      fx.commitIn(b.checkout, { "real.txt": "real\n" }, "real work");
      await landNew(fx, h, "other", { "o.txt": "o\n" });
      git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
      return { fx, h, b, left: "work" };
    },
  },
  {
    name: "a merge of another branch that hasn't landed is work: first-parent reading would call it merges only",
    build: async () => {
      const { fx, h } = await setup();
      const other = fx.branch("unlanded", { "unlanded.txt": "u\n" });
      const { b } = await landNew(fx, h, "taker", { "taker.txt": "t\n" });
      git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", other.branch]);
      return { fx, h, b, left: "work" };
    },
  },
  {
    name: "a queue copy resolve-mq_* with both parents on the target",
    build: async () => {
      const { fx, h } = await setup();
      const a = fx.branch("pin", { "pin.txt": "p\n" });
      const base = fx.head();
      await landNew(fx, h, "moved", { "m.txt": "m\n" });
      const checkout = fx.worktreeOf("resolve-mq_ok");
      git(fx.project, ["worktree", "add", "-q", "-b", "feat/resolve-mq_ok", checkout, fx.head()]);
      git(checkout, ["merge", "-q", "--no-ff", "--no-edit", a.commit]);
      await land(h, a.branch);
      void base;
      return { fx, h, b: { branch: "feat/resolve-mq_ok", checkout, commit: git(checkout, ["rev-parse", "HEAD"]) }, left: "nothing" };
    },
  },
  {
    name: "a queue copy resolve-mq_* with a parent not on the target is kept",
    build: async () => {
      const { fx, h } = await setup();
      const a = fx.branch("pin", { "pin.txt": "p\n" });
      await landNew(fx, h, "moved", { "m.txt": "m\n" });
      const checkout = fx.worktreeOf("resolve-mq_keep");
      git(fx.project, ["worktree", "add", "-q", "-b", "feat/resolve-mq_keep", checkout, fx.head()]);
      git(checkout, ["merge", "-q", "--no-ff", "--no-edit", a.commit]);
      return { fx, h, b: { branch: "feat/resolve-mq_keep", checkout, commit: git(checkout, ["rev-parse", "HEAD"]) }, left: "work" };
    },
  },
  {
    name: "an empty merge plus a fitting draft: the draft is left to land",
    build: async () => {
      const { fx, h } = await setup();
      await fx.withSpec();
      const { b } = await landNew(fx, h, "drafty", { "d.txt": "d\n" });
      await landNew(fx, h, "other", { "o.txt": "o\n" });
      git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
      fx.draft(b.checkout, "drafty");
      return { fx, h, b, left: "drafts" };
    },
  },
  {
    name: "a branch on the target with a draft edited since it landed: unproved, so something is left",
    build: async () => {
      const { fx, h } = await setup();
      await fx.withSpec();
      const b = fx.branch("edited", { "e.txt": "e\n" });
      fx.draft(b.checkout, "edited");
      await land(h, b.branch);
      fx.editDraft(b.checkout, "edited", "The edited feature changed its mind after landing.");
      fx.noteDraft(b.checkout, "edited");
      return { fx, h, b, left: "drafts" };
    },
  },
  {
    name: "a landed draft, proved by its landing: nothing left",
    build: async () => {
      const { fx, h } = await setup();
      await fx.withSpec();
      const b = fx.branch("provedraft", { "e.txt": "e\n" });
      fx.draft(b.checkout, "provedraft");
      await land(h, b.branch);
      await landNew(fx, h, "other", { "o.txt": "o\n" });
      return { fx, h, b, left: "nothing" };
    },
  },
  {
    name: "a merge with a hand edit on a landed branch, the target unchanged where it edits: a trial would call it work, and the commits say nothing is left",
    build: async () => {
      const { fx, h } = await setup();
      const { b } = await landNew(fx, h, "handedit", { "he.txt": "he\n" });
      await landNew(fx, h, "other", { "o.txt": "o\n" });
      git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
      writeFileSync(join(b.checkout, "he.txt"), "edited by hand in the merge\n");
      git(b.checkout, ["add", "-A"]);
      git(b.checkout, ["commit", "-q", "--amend", "--no-edit"]);
      assert.notEqual(git(b.checkout, ["rev-parse", "HEAD^{tree}"]), fx.tree(), "the merge really carries an edit");
      return { fx, h, b, left: "nothing" };
    },
  },
  {
    name: "history that can't be connected to the target is unknown, never nothing",
    build: async () => {
      const { fx, h } = await setup();
      const checkout = fx.worktreeOf("orphan");
      orphanIn(fx, checkout, "feat/orphan");
      return { fx, h, b: { branch: "feat/orphan", checkout, commit: git(checkout, ["rev-parse", "HEAD"]) }, left: "unknown" };
    },
  },
  {
    name: "git failing on the branch's history is unknown, never nothing",
    // Its parent's object is deleted, so git can't walk it. The branch can't be fetched into a merge copy either.
    noMoreLandings: true,
    build: async () => {
      const { fx, h } = await setup();
      const b = fx.branch("broken", { "broken.txt": "1\n" });
      const parent = git(b.checkout, ["rev-parse", "HEAD"]);
      fx.commitIn(b.checkout, { "broken.txt": "2\n" }, "on top");
      rmSync(join(fx.project, ".git/objects", parent.slice(0, 2), parent.slice(2)));
      return { fx, h, b: { ...b, commit: git(b.checkout, ["rev-parse", "HEAD"]) }, left: "unknown" };
    },
  },
  {
    name: "a cancelled approval is no landing: a merge on top of its commit is still work",
    build: async () => {
      const { fx, h } = await setup();
      const b = fx.branch("cancelled", { "c.txt": "c\n" });
      await h.pause("holding it in line");
      const e = await h.add({ branch: b.branch });
      await h.cancel(e.id);
      await h.resume();
      fx.moveTargetOutside({ "m.txt": "m\n" });
      git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
      return { fx, h, b, left: "work" };
    },
  },
  {
    name: "drafts unproved, the code landed: only the drafts are left",
    build: async () => {
      const { fx, h } = await setup();
      await fx.withSpec();
      const { b } = await landNew(fx, h, "codefirst", { "cf.txt": "cf\n" });
      fx.draft(b.checkout, "codefirst");
      return { fx, h, b, left: "drafts" };
    },
  },
];

// ---------------------------------------------------------------- the agreement

describe("every reader, one answer", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const { fx, h, b, left } = await c.build();
      assertAgree(c.name, left, await readAll(fx, h, b));
      if (!c.noMoreLandings) {
        // Only a new commit or an edited draft changes the answer: a newer landing doesn't.
        await landNew(fx, h, "one-more", { "one-more.txt": "1\n" });
        assertAgree(`${c.name} (after one more landing)`, left, await readAll(fx, h, b));
      }
      // Step 1 removes nothing: reading, however it comes out, leaves the folder and the branch.
      assert.ok(existsSync(b.checkout), "its folder stays");
      assert.ok(git(fx.project, ["branch", "--list", b.branch]).includes(b.branch), "and its branch");
    });
  }

  test("a real commit past an answer of nothing left changes it, at once, and everywhere", async () => {
    const { fx, h } = await setup();
    const { b } = await landNew(fx, h, "turns", { "turns.txt": "t\n" });
    git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target], { allowFail: true });
    assertAgree("before", "nothing", await readAll(fx, h, b));
    fx.commitIn(b.checkout, { "real.txt": "real\n" }, "real work");
    assertAgree("after", "work", await readAll(fx, h, b));
  });

  /** The history a catch-up merge was hand-edited into between approval and landing: the commits alone settle it. */
  async function catchUpLanded(): Promise<Built> {
    const { fx, h } = await setup({ checks: "none" });
    const b = fx.branch("old", { "old.txt": "old\n" });
    await landNew(fx, h, "base0", { "gen.txt": "0\n" });
    // Paused, so the catch-up merge lands between approval and landing with no check gate to hold it.
    await h.pause("holding the line for the merge");
    const e = await h.add({ branch: b.branch });
    git(b.checkout, ["merge", "-q", "--no-edit", fx.target]);
    writeFileSync(join(b.checkout, "gen.txt"), "0 regenerated on the branch\n");
    git(b.checkout, ["add", "-A"]);
    git(b.checkout, ["commit", "-q", "--amend", "--no-edit"]);
    await h.resume();
    assert.equal((await h.waitEntry(e.id, settled)).state, "landed");
    await landNew(fx, h, "regen", { "gen.txt": "0\n1\n" });
    return { fx, h, b, left: "nothing" };
  }

  for (const [name, build] of [
    ["a catch-up merge", catchUpLanded],
    // Only the recorded landing can answer this one: its pin isn't on the target, and a trial merge conflicts.
    ["a host's squash plus a leftover merge", () => squashed({ leftover: true, rewrite: true, checks: "none" })],
  ] as const) {
    test(`more than 20 later landings (${name}): the entry has left the view's window, and no reader's answer moved`, async () => {
      const { fx, h, b } = await build();
      const inView = async () => (await h.view()).recent.some((r) => r.entry.branch === b.branch);
      const first = await readAll(fx, h, b);
      assertAgree("just landed", "nothing", first);
      assert.ok(await inView(), "the entry is in the view's window so far");
      for (let i = 1; i <= 21; i++) await landNew(fx, h, `later${i}`, { [`later${i}.txt`]: `${i}\n` });
      assert.ok(!(await inView()), "the entry really fell out of the view's window");
      assert.deepEqual((await readAll(fx, h, b)).left, first.left, "the same answer from every reader");
    });
  }

  /** The draft count on the branch status line, for the merge this chat made last. */
  async function statusLineDrafts(fx: Fixture, b: B): Promise<number | undefined> {
    const card = { id: "merge-1", at: 1, path: b.checkout, branch: b.branch, target: fx.target, sha: git(b.checkout, ["rev-parse", "HEAD"]), commits: 1, added: 0, removed: 0, fastForward: false };
    const r = await computeReadiness(SUMMARY(fx, b), { trees: [trackedBy(fx, b)], merges: [card] } as unknown as Parameters<typeof computeReadiness>[1], () => false, true);
    return r?.status?.specDrafts;
  }

  let offerChats = 0;
  /** The buttons a chat's offer shows when "specs-promoted" decides one of them: real git, on the branch's folder. */
  async function offerButtons(fx: Fixture, b: B): Promise<string[]> {
    const go = { label: "Go", about: "Go on.", send: "go", onlyIf: ["specs-promoted"] };
    const later = { label: "Later", about: "Later on.", send: "later" };
    writeFileSync(join(fx.project, ".sova/offers.json"), JSON.stringify({ version: 1, offers: { spec: { when: "When it is time.", title: "Land?", shownBy: "agent", buttons: [go, later] } } }));
    const id = `01a00000-0000-7000-8000-${String(++offerChats).padStart(12, "0")}`; // an open card holds its chat, so one chat per call
    const path = join(fx.state, `x_${id}.jsonl`);
    setOfferDeps({
      summary: async () => ({ id, path, cwd: b.checkout, title: "Offers", lastActiveAt: 1 }) as unknown as SessionSummary,
      readiness: async () => undefined,
      sessions: async () => [],
      head: async () => ({ id, cwd: b.checkout }),
      projects: async () => [{ id: "p_1", root: fx.project }],
    });
    try {
      return (await showOffer({ path, offer: "spec", tree: b.checkout, by: "agent" })).buttons.map((x) => x.label);
    } finally {
      setOfferDeps(null);
    }
  }

  // Whichever branch the queue lands on is the one a draft is proved against, whatever master or main hold.
  for (const target of ["master", "develop"]) {
    test(`a draft that matches ${target}, the target, with no receipt: proved, for every reader`, async () => {
      const { fx, h } = await setup({ target });
      await fx.withSpec();
      if (target !== "master") git(fx.project, ["branch", "main", git(fx.project, ["rev-list", "--max-parents=0", fx.target])]);
      const { b } = await landNew(fx, h, "plain-code", { "pc.txt": "p\n" });
      const carrier = fx.branch("carrier", { "c.txt": "c\n" });
      fx.draft(carrier.checkout, "twin-draft");
      await land(h, carrier.branch);
      fx.draft(b.checkout, "twin-draft");
      assertAgree("matches the target, not main", "nothing", await readAll(fx, h, b));
      assert.equal(await statusLineDrafts(fx, b), 0, "the branch status line counts none");
      assert.deepEqual(await offerButtons(fx, b), ["Go", "Later"], "an offer reads it as promoted");
    });
  }

  test("a draft that matches main but not develop, the target: unproved, for every reader", async () => {
    const { fx, h } = await setup({ target: "develop" });
    await fx.withSpec();
    const { b } = await landNew(fx, h, "plain-code", { "pc.txt": "p\n" });
    const before = fx.head();
    const carrier = fx.branch("carrier", { "c.txt": "c\n" });
    fx.draft(carrier.checkout, "twin-draft");
    await land(h, carrier.branch);
    // main keeps that landing; the target goes back, so nothing on it ever held the draft.
    git(fx.project, ["branch", "main", fx.head()]);
    git(fx.project, ["reset", "-q", "--hard", before]);
    git(fx.project, ["push", "-qf", "origin", fx.target]);
    fx.draft(b.checkout, "twin-draft");
    assertAgree("matches main, not the target", "drafts", await readAll(fx, h, b));
    assert.equal(await statusLineDrafts(fx, b), 1, "the branch status line counts it");
    assert.deepEqual(await offerButtons(fx, b), ["Later"], "an offer reads it as not promoted");
  });

  test("a commit on main but not on develop, the target: work, for every reader", async () => {
    const { fx, h } = await setup({ target: "develop" });
    const b = fx.branch("only-main", { "om.txt": "m\n" });
    git(fx.project, ["branch", "main", b.commit]);
    const tab = (await sessionTabRow(fx, b)).row;
    assert.ok(tab, "the Session tab lists it");
    assert.equal(tab.mergedInto, undefined, "the Session tab doesn't read Merged off main");
    assert.equal((await branchRow(fx, b))?.mergedInto, undefined, "nor do the branch rows, by the same rule");
    assertAgree("on main, not the target", "work", await readAll(fx, h, b));
    // A gone folder follows the branch it lands on, as the live row did: on main isn't landed.
    const onTarget = fx.branch("on-develop", { "od.txt": "d\n" });
    git(fx.project, ["merge", "-q", "--ff-only", onTarget.commit]);
    const base = git(fx.project, ["rev-list", "--max-parents=0", fx.target]);
    for (const x of [b, onTarget]) rmSync(x.checkout, { recursive: true, force: true });
    git(fx.project, ["worktree", "prune"]);
    assert.equal(await goneTreeState({ path: b.checkout, branch: b.branch, base }, [fx.project]), "unmerged", "on main only");
    assert.equal(await goneTreeState({ path: onTarget.checkout, branch: onTarget.branch, base }, [fx.project]), "merged", "on the target only");
  });

  test("a head that read nothing left by content keeps that answer once the target moves and the same merge conflicts", async () => {
    const { fx, h } = await setup();
    // A squash the queue never heard of: on the target by content only.
    const b = fx.branch("bycontent", { "src/list.txt": LIST_PLUS("delta") });
    fx.moveTargetOutside({ "src/list.txt": LIST_PLUS("delta") });
    assertAgree("the trial is a no-op", "nothing", await readAll(fx, h, b));
    fx.moveTargetOutside({ "src/list.txt": LIST_PLUS("delta-rewritten") });
    assertAgree("the same merge now conflicts", "nothing", await readAll(fx, h, b));
  });

  test("a branch that never had a commit of its own has nothing left, and reads No commits yet, never Landed or Merged", async () => {
    const { fx, h } = await setup();
    const checkout = fx.worktreeOf("nocommits");
    git(fx.project, ["worktree", "add", "-q", "-b", "feat/nocommits", checkout, fx.target]);
    const r = await readAll(fx, h, { branch: "feat/nocommits", checkout, commit: fx.head() });
    assertAgree("no commits", "nothing", r);
    assert.equal(r.detail.rowKey, "no-commits");
  });

  // No client rule hides these: the server leaves them out, or a row reaches the screen with Land on it.
  for (const shape of ["on the target", "on a branch of its own, with a real commit"] as const) {
    test(`a main-checkout row (${shape}): no reader lists it`, async () => {
      const { fx, h } = await setup();
      if (shape !== "on the target") {
        git(fx.project, ["checkout", "-q", "-b", "feat/in-main"]);
        fx.commitIn(fx.project, { "in-main.txt": "m\n" }, "work in the main checkout");
      }
      const b = { branch: git(fx.project, ["symbolic-ref", "--short", "HEAD"]), checkout: fx.project, commit: git(fx.project, ["rev-parse", "HEAD"]) };
      assert.equal(await chatReading(fx, b), undefined, "readiness drops the row at read");
      assert.equal(await branchRow(fx, b), undefined, "the session's branch rows too");
      assert.deepEqual((await sessionTabRow(fx, b)).rows, [], "and the Session tab");
      (h.queue() as unknown as { readyCache: unknown }).readyCache = null;
      assert.equal(((await h.view()).ready ?? []).some((r) => r.branch === b.branch), false, "and the Ready list");
      if (shape === "on the target") assert.equal((await h.tryAdd({ branch: fx.target })).ok, false, "and Land");
      assert.ok(git(fx.project, ["branch", "--list", b.branch]).includes(b.branch));
    });
  }

  test("a folder with no working branch left: readiness calls it gone, not a tree with work, and every other reader has nothing to say of it", async () => {
    const { fx, h } = await setup();
    const { b } = await landNew(fx, h, "left-behind", { "l.txt": "l\n" });
    const keep = join(fx.root, "keep-left-behind");
    mkdirSync(join(keep, "node_modules"), { recursive: true });
    writeFileSync(join(keep, "node_modules/a.js"), "x\n");
    git(fx.project, ["worktree", "remove", "--force", b.checkout]);
    git(fx.project, ["branch", "-D", b.branch]);
    renameSync(keep, b.checkout);
    const reading = await chatReading(fx, b);
    assert.notEqual(reading?.why, "git can't read this worktree", "a folder with no .git is gone, not unreadable");
    for (const wrong of ["built", "land"] as const) assert.notEqual(reading && treeBucket(reading), wrong, "a leftover isn't reported as work");
    const view = await h.view();
    assert.equal((view.ready ?? []).some((r) => r.branch === b.branch), false);
    assert.equal((await h.tryAdd({ branch: b.branch })).ok, false);
    assert.ok(existsSync(join(b.checkout, "node_modules/a.js")), "and nothing touched it");
  });

  test("a branch on the target by content through a merge driver that prints: a gone folder reads as the live one did", async () => {
    const { fx, h } = await setup();
    git(fx.project, ["config", "merge.noisy.driver", "echo noise-from-the-driver; exit 0"]);
    fx.moveTargetOutside({ ".gitattributes": "noisy.txt merge=noisy\n", "noisy.txt": "base\n" });
    const b = fx.branch("noisy", { "noisy.txt": "the branch's\n" });
    fx.moveTargetOutside({ "noisy.txt": "the target's\n" });
    assert.equal(git(fx.project, ["merge-tree", "--write-tree", "--no-messages", fx.target, b.branch]).split("\n")[0], "noise-from-the-driver", "the driver really prints");
    assertAgree("while the folder is there", "nothing", await readAll(fx, h, b));
    rmSync(b.checkout, { recursive: true, force: true });
    git(fx.project, ["worktree", "prune"]);
    assert.equal((await chatReading(fx, b))?.state, "merged", "gone, it reads as it did");
  });

  test("a gone folder's trial merge failing is can't tell, never unmerged", async () => {
    const { fx } = await setup();
    const b = fx.branch("trial-fails", { "t.txt": "t\n" });
    const base = git(fx.project, ["rev-list", "--max-parents=0", fx.target]);
    fx.moveTargetOutside({ "m.txt": "m\n" });
    rmSync(b.checkout, { recursive: true, force: true });
    git(fx.project, ["worktree", "prune"]);
    const failing: typeof execGit = (args, opts) => (args.includes("merge-tree") ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: no\n" }) : execGit(args, opts));
    assert.equal(await goneTreeState({ path: b.checkout, branch: b.branch, base }, [fx.project], { git: failing }), null);
  });

  test("a folder gone, its branch kept, a leftover merge that now conflicts: Landed · cleaned up, by the same answer a live folder reads", async () => {
    const { fx, h } = await setup();
    const { b } = await landNew(fx, h, "gone", { "gen.txt": "from the branch\n" });
    await landNew(fx, h, "other", { "o.txt": "o\n" });
    git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
    writeFileSync(join(b.checkout, "gen.txt"), "regenerated on the branch\n");
    git(b.checkout, ["add", "-A"]);
    git(b.checkout, ["commit", "-q", "--amend", "--no-edit"]);
    fx.moveTargetOutside({ "gen.txt": "regenerated on the target\n" });
    assertAgree("while the folder is there", "nothing", await readAll(fx, h, b));
    rmSync(b.checkout, { recursive: true, force: true });
    git(fx.project, ["worktree", "prune"]);
    const reading = await chatReading(fx, b);
    assert.equal(reading?.state, "merged", JSON.stringify(reading));
    assert.equal(reading?.reason, "Landed · cleaned up");
    assert.notEqual(reading && treeBucket(reading), "at-risk", "and no one is told it was lost");
  });
});

// ---------------------------------------------------------------- Land

/** Every file under `dir` and its bytes: what "writes nothing" is checked against. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const NOTHING_TO_LAND = (target: string) => `Nothing to land: everything on this branch is already on ${target}.`;
const onlySpecFiles = (fx: Fixture, from: string, to: string) => git(fx.project, ["diff", "--name-only", from, to]).split("\n").filter(Boolean).every((f) => f.startsWith(".sova/spec/"));

describe("Land reads the same answer, and never moves the target for nothing", () => {
  for (const shape of ["on the target", "a merge left behind", "a merge left behind that conflicts"] as const) {
    test(`nothing left (${shape}): the refusal says so, writes nothing, and the target doesn't move`, async () => {
      const { fx, h } = await setup();
      const { b } = await landNew(fx, h, "refused", { "r.txt": "r\n", "gen.txt": "branch\n" });
      await landNew(fx, h, "other", { "o.txt": "o\n" });
      if (shape !== "on the target") {
        git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
        if (shape === "a merge left behind that conflicts") {
          writeFileSync(join(b.checkout, "gen.txt"), "regenerated on the branch\n");
          git(b.checkout, ["add", "-A"]);
          git(b.checkout, ["commit", "-q", "--amend", "--no-edit"]);
          fx.moveTargetOutside({ "gen.txt": "regenerated on the target\n" });
        }
      }
      await h.idle();
      const [head, origin, store, mark] = [fx.head(), fx.originHead(), snapshot(h.queue().store.dir), fx.calls().length];
      const gate = await h.tryAdd({ branch: b.branch });
      assert.deepEqual(gate, { ok: false, code: "invalid-request", message: NOTHING_TO_LAND(fx.target) });
      await h.idle();
      assert.equal(fx.head(), head, "the target didn't move");
      assert.equal(fx.originHead(), origin, "nothing pushed");
      assert.deepEqual(snapshot(h.queue().store.dir), store, "no record of any kind");
      assert.equal(fx.callsSince(mark).length, 0, "no check ran");
    });
  }

  test("an answer of unknown is not refused as nothing to land", async () => {
    const { fx, h } = await setup();
    const checkout = fx.worktreeOf("orphan2");
    orphanIn(fx, checkout, "feat/orphan2");
    await h.pause("no need to run it");
    const gate = await h.tryAdd({ branch: "feat/orphan2" });
    assert.equal(gate.ok, true, gate.ok ? "" : gate.message);
  });

  test("drafts only: Land moves the target by exactly one commit, of spec files alone, and then nothing is left", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const { b } = await landNew(fx, h, "drafted-merge", { "d.txt": "d\n" });
    await landNew(fx, h, "other", { "o.txt": "o\n" });
    git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
    fx.draft(b.checkout, "drafted-merge");
    const before = fx.head();
    const e = await h.add({ branch: b.branch });
    const done = await h.waitEntry(e.id, settled);
    assert.equal(done.state, "landed", `${done.state}: ${done.reason ?? ""}`);
    assert.equal(git(fx.project, ["rev-list", "--count", `${before}..${fx.head()}`]), "1", "one commit");
    assert.ok(onlySpecFiles(fx, before, fx.head()), "of spec files alone");
    assert.match(git(fx.project, ["log", "-1", "--format=%s", fx.head()]), /^Spec: land/);
    assert.ok(fx.fileAt(fx.head(), ".sova/spec/claims/b/drafted-merge.md"), "the draft is official on the target");
    assertAgree("after", "nothing", await readAll(fx, h, b));
  });

  test("drafts only on a host's squash, a trial of the pin conflicting: the merge is never tried, and the target moves by the spec commit alone", async () => {
    const { fx, h, b } = await squashed({ leftover: false, rewrite: true });
    await fx.withSpec();
    fx.draft(b.checkout, "squash-draft");
    const before = fx.head();
    const e = await h.add({ branch: b.branch });
    const done = await h.waitEntry(e.id, settled);
    assert.equal(done.state, "landed", `${done.state}: ${done.reason ?? ""}`);
    assert.equal(git(fx.project, ["rev-list", "--count", `${before}..${fx.head()}`]), "1", "one commit");
    assert.ok(onlySpecFiles(fx, before, fx.head()), "of spec files alone");
  });

  test("the target took the code and the draft while it waited: the docs step finds nothing, and the target doesn't move", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const files = { "twin.txt": "same\n" };
    const first = fx.branch("twin-a", files);
    const second = fx.branch("twin-b", files);
    for (const c of [first, second]) fx.draft(c.checkout, "twin");
    await h.pause("both in line, in this order");
    const [a, z] = [await h.add({ branch: first.branch }), await h.add({ branch: second.branch })];
    await h.resume();
    assert.equal((await h.waitEntry(a.id, settled)).state, "landed");
    const [head, origin, mark] = [fx.head(), fx.originHead(), fx.calls().length];
    const done = await h.waitEntry(z.id, settled);
    assert.equal(done.state, "cancelled", `${done.state}: ${done.reason ?? ""}`);
    assert.equal(done.reason, NOTHING_TO_LAND(fx.target));
    assert.equal(fx.head(), head, "the target didn't move");
    assert.equal(fx.originHead(), origin, "nothing pushed");
    assert.equal(fx.callsSince(mark).filter((c) => c.script === "unit").length, 0, "no check ran");
  });

  test("a merge carrying real edits, every commit of it on the target by the time it runs: it is merged, not skipped, and reads Landed only once it has", async () => {
    const { fx, h } = await setup();
    const b = fx.branch("edits", { "e.txt": "e\n" });
    const real = b.commit;
    fx.moveTargetOutside({ "m.txt": "m\n" });
    git(b.checkout, ["merge", "-q", "--no-ff", "--no-edit", fx.target]);
    writeFileSync(join(b.checkout, "e.txt"), "edited by hand in the merge\n");
    git(b.checkout, ["add", "-A"]);
    git(b.checkout, ["commit", "-q", "--amend", "--no-edit"]);
    await h.pause("holding it in line");
    const e = await h.add({ branch: b.branch });
    // The approved head is now merges only: a reading of the commits alone would call it done.
    git(fx.project, ["merge", "-q", "--no-ff", "--no-edit", real]);
    git(fx.project, ["push", "-q", "origin", fx.target]);
    const held = await h.view();
    const queue = worktreeQueueInfo(held, b.branch);
    const key = rowKeyOf({ status: "active", exists: true, ...(queue ? { queue } : {}) });
    assert.ok(!NOTHING_KEYS.has(key), `in line it reads ${key}, not landed`);
    const before = fx.head();
    await h.resume();
    const done = await h.waitEntry(e.id, settled);
    assert.equal(done.state, "landed", `${done.state}: ${done.reason ?? ""}`);
    assert.notEqual(fx.head(), before, "the target moved");
    assert.equal(fx.fileAt(fx.head(), "e.txt"), "edited by hand in the merge\n", "with the edit");
  });

  for (const shape of ["the same content by another way", "the very commit"] as const) {
    test(`the target took ${shape} while it waited: a landing that changes nothing never moves the target`, async () => {
      const { fx, h } = await setup();
      const b = fx.branch("same", { "same.txt": "same\n" });
      await h.pause("holding it in line");
      const e = await h.add({ branch: b.branch });
      if (shape === "the very commit") {
        git(fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
        git(fx.project, ["push", "-q", "origin", fx.target]);
      } else fx.moveTargetOutside({ "same.txt": "same\n" });
      const [head, origin, mark] = [fx.head(), fx.originHead(), fx.calls().length];
      await h.resume();
      const done = await h.waitEntry(e.id, settled);
      assert.equal(done.state, "cancelled", `${done.state}: ${done.reason ?? ""}`);
      assert.equal(done.reason, NOTHING_TO_LAND(fx.target));
      assert.equal(fx.head(), head, "the target didn't move");
      assert.equal(fx.originHead(), origin, "nothing pushed");
      assert.deepEqual(fx.callsSince(mark).map((c) => c.script), [], "no drafts to land, so no setup or check ever ran");
    });
  }
});
