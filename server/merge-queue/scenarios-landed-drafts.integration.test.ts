import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP, settled, setup, STATE } from "./testing/scenario-kit";
import { git, REPO_ROOT, until } from "./testing/repo";
import type { QueueHarness } from "./testing/harness";
import type { Fixture } from "./testing/repo";
import type { SessionSummary } from "../../shared/protocol";
import { draftsLeft } from "../spec-drafts-state";
import { backfillLandedDrafts } from "./landed-drafts";
import { writeOverride } from "./strategy";

/**
 * A branch the queue landed with its spec drafts: the drafts stay in the branch folder, marked with the landing's
 * receipt, and read as landed (no "its spec drafts didn't make it"); without the receipt, or once edited, they don't.
 * The real queue on the real run (testing/harness.ts) on a real git repository.
 */

/** Ancestry asked of git in the branch folder, as readiness asks it. */
const ancestor = async (commit: string, ref: string, cwd: string) => {
  try {
    git(cwd, ["merge-base", "--is-ancestor", commit, ref]);
    return true;
  } catch {
    return false;
  }
};
const HERE = new URL(".", import.meta.url).pathname;
const BIN = join(process.env.TMPDIR ?? "/tmp", `sova-standin-gh-${process.pid}`);
mkdirSync(BIN, { recursive: true });
if (!existsSync(join(BIN, "gh"))) symlinkSync(join(HERE, "testing/stand-in-gh.mjs"), join(BIN, "gh"));
process.env.PATH = `${BIN}:${process.env.PATH ?? ""}`;
const hostDeps = () => ({ hostRepo: async () => ({ kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" }) });

let sessions = 0;
/** The branch's real Worktrees row: the published readiness reading of a chat that owns `checkout`, on real git and the
 *  real drafts; only the chat's own state is stood in for. */
async function rowOf(checkout: string, branch: string, base: string, target: string) {
  const r = await import("../merge-readiness");
  const { fileLandingStore } = await import("../ready-to-land");
  const n = ++sessions;
  const id = `01a0eeee-e385-72b1-a202-${String(n).padStart(12, "0")}`;
  const dir = join(STATE, `row-${n}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-26T00-00-00-000Z_${id}.jsonl`);
  const at = "2026-10-26T00:00:00.000Z";
  const lines = [
    { type: "session", version: 3, id, timestamp: at, cwd: checkout },
    { type: "custom", customType: "worktrees", id: "a0000001", parentId: null, timestamp: at, data: { version: 1, trees: [{ path: checkout, branch, base, baseBranch: target, status: "active", session: id, how: "created", at: 1 }] } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  r.configureReadiness({ asksUser: () => undefined, finished: () => "off", nudge: undefined, served: async () => true, processStart: 0, landing: fileLandingStore(() => join(dir, "landing.json")) });
  const row: SessionSummary = { id, path, cwd: checkout, title: "t", createdAt: "", lastActiveAt: at, model: null, live: null, busy: false, origin: "web", archived: false };
  try {
    return await until("the row's reading", async () => {
      r.readinessOverlay(row);
      await r.readinessIdle();
      const t = r.readinessReading(path);
      return t.known ? t.value?.trees[0] : null;
    });
  } finally {
    r.resetReadiness();
  }
}
const LOST = /spec drafts? not landed/;

/** The host merges the request (or, push branch only, the user merges the branch there): on the bare origin. */
function mergeOnOrigin(fx: Fixture, branch: string): string {
  const side = join(fx.root, `host-merge-${branch.replace(/\W/g, "-")}`);
  git(fx.project, ["fetch", "-q", "origin"]);
  git(fx.project, ["worktree", "add", "-q", "--detach", side, `origin/${fx.target}`]);
  git(side, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  git(side, ["merge", "-q", "--no-ff", "-m", "host merge", `origin/${branch}`]);
  const sha = git(side, ["rev-parse", "HEAD"]);
  git(side, ["push", "-q", "origin", `HEAD:refs/heads/${fx.target}`]);
  return sha;
}

/** A draft whose record names no authority: the landing gives it `accepted`, so the record it writes isn't the draft's. */
function draftNoAuthority(fx: Fixture, checkout: string, name: string): void {
  fx.draft(checkout, name);
  const file = join(checkout, ".sova/spec/drafts", name, "spec/claims/b", `${name}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8")) as Record<string, { authority?: string }>;
  delete rec[`§b/${name}`]!.authority;
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  fx.noteDraft(checkout, name);
}

async function publishOf(h: QueueHarness, id: string): Promise<void> {
  const q = h.queue() as unknown as { publish: (id: string, t: { title: string; body: string; draft: boolean }) => Promise<unknown> };
  await q.publish(id, { title: "Doc", body: "Opened by Sova", draft: false });
}

const draftJson = (checkout: string, name: string) => JSON.parse(readFileSync(join(checkout, ".sova/spec/drafts", name, "draft.json"), "utf8")) as { promotions: unknown[]; landed?: { commit: string; hash: string; target: string } };

describe("drafts a queue landing made official", () => {
  test("landed with its drafts: the branch folder's drafts carry the landing's receipt and read as landed", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"], "before the landing the draft isn't official");
    const e = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    const tip = fx.head();
    assert.match(fx.fileAt(tip, ".sova/spec/claims/b/doc.md") ?? "", /The doc feature does its one thing/);
    const d = draftJson(b.checkout, "doc");
    assert.equal(d.landed?.commit, tip, "the receipt names the spec commit that landed");
    assert.equal(d.landed?.target, fx.target);
    assert.ok(d.promotions.length > 0, "the spec tool's own promotion receipt is copied back");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), [], "a landed draft doesn't count as lost");
    // A receipt whose commit isn't on the branch it names speaks for nothing.
    const file = join(b.checkout, ".sova/spec/drafts/doc/draft.json");
    git(fx.project, ["branch", "elsewhere", `${tip}~1`]);
    writeFileSync(file, JSON.stringify({ ...d, landed: { ...d.landed, target: "elsewhere" } }, null, 2));
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
  });

  test("a draft edited after its landing reads as not landed again", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const e = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), []);
    writeFileSync(join(b.checkout, ".sova/spec/drafts/doc/spec/claims/b/doc.md"), "# §b/doc\n\nThe doc feature now does two things.\n");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"], "the receipt no longer speaks for the edited draft");
  });

  test("landed without its specs: no receipt, and the drafts still read as not landed", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const e = await h.add({ branch: b.branch, withoutSpecs: true });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(fx.fileAt(fx.head(), ".sova/spec/claims/b/doc.md"), null, "no docs landed");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined);
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
  });

  test("a run that fails after its docs commit writes no receipt", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed"), "tests/a.txt": "fail" });
    fx.draft(b.checkout, "doc");
    const e = await h.add({ branch: b.branch });
    const done = await h.waitEntry(e.id, settled);
    assert.notEqual(done.state, "landed", `${done.state}: ${done.reason}`);
    assert.equal(h.run(done.run!).steps.find((x) => x.kind === "docs")?.result, "passed", "the docs commit was made before the failing check");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined);
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
  });

  test("the one-off backfill marks a draft that landed before receipts, once; never one edited since", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const e = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    const spec = fx.head();
    // As a branch landed before this change left it: no receipt in the folder.
    const file = join(b.checkout, ".sova/spec/drafts/doc/draft.json");
    const { landed: _gone, ...before } = draftJson(b.checkout, "doc");
    writeFileSync(file, JSON.stringify(before, null, 2) + "\n");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
    const dry = await backfillLandedDrafts({ worktree: b.checkout, commit: spec.slice(0, 9), target: fx.target, write: false });
    assert.deepEqual(dry.rows, [{ draft: "doc", state: "marked" }]);
    assert.equal(draftJson(b.checkout, "doc").landed, undefined, "a dry run writes nothing");
    await backfillLandedDrafts({ worktree: b.checkout, commit: spec, target: fx.target, write: true });
    assert.equal(draftJson(b.checkout, "doc").landed?.commit, spec);
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), []);
    const again = readFileSync(file, "utf8");
    assert.deepEqual((await backfillLandedDrafts({ worktree: b.checkout, commit: spec, target: fx.target, write: true })).rows, [{ draft: "doc", state: "current" }]);
    assert.equal(readFileSync(file, "utf8"), again, "idempotent");
    // Not official at a commit before the docs landed: left alone.
    writeFileSync(file, JSON.stringify(before, null, 2) + "\n");
    const early = await backfillLandedDrafts({ worktree: b.checkout, commit: landed.landed!.from, target: fx.target, write: true });
    assert.equal(early.rows[0]?.state, "not-landed");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined);
    // Edited since it landed: not what the spec at that commit says, so left alone, at the very commit that landed it.
    const claim = join(b.checkout, ".sova/spec/drafts/doc/spec/claims/b/doc.md");
    const said = readFileSync(claim, "utf8");
    writeFileSync(claim, "# §b/doc\n\nThe doc feature now does two things.\n");
    const edited = await backfillLandedDrafts({ worktree: b.checkout, commit: spec, target: fx.target, write: true });
    assert.equal(edited.rows[0]?.state, "not-landed");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined, "no receipt for a draft edited since");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
    writeFileSync(claim, said);
    const after = fx.commitIn(b.checkout, { "src/later.txt": "later\n" }, "doc: after landing");
    await assert.rejects(backfillLandedDrafts({ worktree: b.checkout, commit: after, target: fx.target, write: true }), /is not on/);
  });

  test("the Worktrees row: no lost-drafts warning after a queue landing; the warning stays for a landing without its specs", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const base = fx.head();
    const a = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(a.checkout, "doc");
    const c = fx.branch("bare", { "src/other.txt": "other\n" });
    fx.draft(c.checkout, "bare");
    const e = await h.waitEntry((await h.add({ branch: a.branch })).id, settled);
    assert.equal(e.state, "landed", `${e.state}: ${e.reason}`);
    const w = await h.waitEntry((await h.add({ branch: c.branch, withoutSpecs: true })).id, settled);
    assert.equal(w.state, "landed", `${w.state}: ${w.reason}`);
    const landed = await rowOf(a.checkout, a.branch, base, fx.target);
    assert.equal(landed?.state, "merged", JSON.stringify(landed));
    assert.doesNotMatch(landed?.reason ?? "", LOST);
    const without = await rowOf(c.checkout, c.branch, base, fx.target);
    assert.equal(without?.state, "merged", JSON.stringify(without));
    assert.match(without?.reason ?? "", LOST);
    // New work after the landing: Ready to land, and the landed drafts aren't offered again as docs.
    const next = fx.commitIn(a.checkout, { "src/later.txt": "later\n" }, "doc: after landing");
    const again = await rowOf(a.checkout, a.branch, base, fx.target);
    assert.equal(again?.landing?.state, "ready", JSON.stringify(again));
    assert.equal(again?.landing?.commit, next);
    assert.equal(again?.landing?.docs, undefined);
  });

  test("a drafts lock another writer holds: the receipt isn't written and the lock is left alone; the backfill marks it after", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const lock = join(b.checkout, ".sova/spec/drafts/.lock");
    const held = `${process.pid} elsewhere 00 2026-11-04T00:00:00.000Z`;
    writeFileSync(lock, held);
    const e = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(e.state, "landed", `${e.state}: ${e.reason}`);
    assert.equal(draftJson(b.checkout, "doc").landed, undefined, "no write under another writer's lock");
    assert.equal(readFileSync(lock, "utf8"), held, "the lock is never taken over");
    await assert.rejects(backfillLandedDrafts({ worktree: b.checkout, commit: fx.head(), target: fx.target, write: true }), /lock/);
    rmSync(lock);
    await backfillLandedDrafts({ worktree: b.checkout, commit: fx.head(), target: fx.target, write: true });
    assert.equal(draftJson(b.checkout, "doc").landed?.commit, fx.head());
    assert.ok(!existsSync(lock), "released");
  });

  test("Sova is killed right after the target moved: the next start finishes the landing and writes the receipt", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    await h.pause("qa: the run happens in the child");
    const e = await h.add({ branch: b.branch });
    const { childExit, childLog } = await h.crashAt("after-ff", { resume: true });
    assert.equal(childExit, "SIGKILL", `the child died at the fault point: ${childLog}`);
    assert.doesNotMatch(childLog, /marked landed/, "the killed process wrote no receipt");
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(draftJson(b.checkout, "doc").landed?.commit, fx.head());
  });

  test("a draft carrying a receipt is still a draft the spec tool reads", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const e = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(e.state, "landed", `${e.state}: ${e.reason}`);
    const cli = join(REPO_ROOT, "pi-config/extensions/spec/core/sova-spec-draft.mjs");
    const st = spawnSync(process.execPath, [cli, "status", "doc", "--root", b.checkout, "--json"], { encoding: "utf8", cwd: b.checkout });
    assert.notEqual(st.status, 2, `${st.stdout}${st.stderr}`);
  });
});

for (const how of ["github-pr", "push-branch"] as const) {
  describe(`drafts of a ${how} landing (the docs commit reaches the branch folder)`, () => {
    test("merged on the host: the folder's drafts read as landed, the row carries no warning, and an edit brings it back", async () => {
      const { fx, h } = await setup({}, () => ({ deps: hostDeps() as never }));
      await fx.withSpec();
      const stateFile = join(fx.root, "gh-state.json");
      process.env.GH_STANDIN_STATE = stateFile;
      process.env.GH_STANDIN_ORIGIN = fx.origin;
      const q = h.queue();
      writeOverride(q.store.dir, how);
      const base = fx.head();
      const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
      draftNoAuthority(fx, b.checkout, "doc");
      const e = await h.add({ branch: b.branch, session: "s-doc" });
      const ready = await h.waitEntry(e.id, (x) => ["request-review", "requested", "pushed", "landed", "needs-fix"].includes(x.state));
      if (ready.state === "request-review") await publishOf(h, e.id);
      const want = how === "github-pr" ? "requested" : "pushed";
      const published = await h.waitEntry(e.id, (x) => (x.state as string) === want || x.state === "needs-fix");
      assert.equal(published.state, want, `${published.state}: ${published.reason}`);
      assert.match(readFileSync(join(b.checkout, ".sova/spec/claims/b/doc.md"), "utf8"), /The doc feature does its one thing/, "q9: the docs commit is in the folder");
      assert.deepEqual(await draftsLeft(b.checkout, ancestor), [], "official in the folder at publish: nothing depends on how, or whether, the host merges it");

      const sha = mergeOnOrigin(fx, b.branch);
      if (how === "github-pr") {
        const st = JSON.parse(readFileSync(stateFile, "utf8")) as { prs: { state: string; mergeCommit?: string; mergedAt?: string }[] };
        Object.assign(st.prs[0]!, { state: "MERGED", mergeCommit: sha, mergedAt: new Date().toISOString() });
        writeFileSync(stateFile, JSON.stringify(st));
        await (q as unknown as { pollHost: () => Promise<void> }).pollHost();
        assert.equal((await h.entry(e.id)).state, "landed");
      }
      await (q as unknown as { updateLocalMain: () => Promise<unknown> }).updateLocalMain();

      const row = await rowOf(b.checkout, b.branch, base, fx.target);
      assert.equal(row?.state, "merged", JSON.stringify(row));
      assert.doesNotMatch(row?.reason ?? "", LOST);
      assert.deepEqual(await draftsLeft(b.checkout, ancestor), []);
      writeFileSync(join(b.checkout, ".sova/spec/drafts/doc/spec/claims/b/doc.md"), "# §b/doc\n\nThe doc feature now does two things.\n");
      assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
    });
  });
}
