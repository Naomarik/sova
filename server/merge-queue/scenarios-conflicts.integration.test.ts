import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reversedResolution, reviewer, settled, setup, testedHead } from "./testing/scenario-kit";
import { Fixture, git, until } from "./testing/repo";
import type { HarnessOptions } from "./testing/harness";
import type { MergeEntry } from "../../shared/merge-queue";
import type { ThreadEvent } from "./contract";
import { resolveRef, scratchCopyPath, scratchMarkOf } from "./scratch";

/**
 * The merge queue's use cases (team brief, TESTING): conflicts the merge thread judges. Each on a real git repository in a temp dir with a bare
 * origin: the real queue on the real run, driven through the queue's verb methods (testing/harness.ts); only the
 * branch's chat, the merge thread and the reviewer chat are stood in for. Waits are on conditions.
 */
void [APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead, Fixture, git, until, existsSync, writeFileSync, join, assert];
export type _H = HarnessOptions | MergeEntry;

describe("conflicts", () => {
  async function twoAppenders(ho: HarnessOptions, fo: ConstructorParameters<typeof Fixture>[0] = {}) {
    const { fx, h } = await setup(fo, ho);
    const a = fx.branch("a", { "src/list.txt": LIST_PLUS("delta") });
    const b = fx.branch("b", { "src/list.txt": LIST_PLUS("echo") });
    const la = await h.waitEntry((await h.add({ branch: a.branch })).id, settled);
    assert.equal(la.state, "landed");
    return { fx, h, a, b };
  }

  test("S2: no behaviour change (both sides extend a list): the thread resolves, the approval carries, full checks run on it, it lands with a note saying what and why", async () => {
    let called = 0;
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, e, ev) => {
          called++;
          assert.deepEqual(ev.files, ["src/list.txt"]);
          const c = resolution(h.fx, e.commit, "src/list.txt", LIST_PLUS("delta\necho"));
          await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "master adds delta", theirs: "the branch adds echo", proposal: "keep both: delta then echo", commit: c, note: "resolved src/list.txt: both sides append; kept both" });
        },
      },
    });
    const mark = fx.calls().length;
    const eb = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(eb.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(called, 1);
    assert.equal(fx.fileAt(fx.head(), "src/list.txt"), LIST_PLUS("delta\necho"));
    assert.equal(testedHead(fx, mark), fx.head(), "full checks ran on the resolved tip that landed");
    assert.ok(landed.notes.some((n) => n.kind === "resolved" || /resolv/i.test(n.text)), `a note says it resolved: ${JSON.stringify(landed.notes)}`);
  });

  test("S2b: a 'safe' resolution that changes lines outside the conflict is treated as behaviour differs (mechanical sanity)", async () => {
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, e) => {
          const c = resolution(h.fx, e.commit, "src/list.txt", "ALPHA\nbravo\ncharlie\ndelta\necho\n");
          await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "delta", theirs: "echo", proposal: "keep both", commit: c });
        },
      },
    });
    const before = fx.head();
    const eb = await h.add({ branch: b.branch });
    const s = await h.waitEntry(eb.id, settled);
    assert.equal(s.state, "behaviour-differs", `${s.state}: ${s.reason}`);
    assert.equal(s.conflict?.sanity?.ok, false);
    assert.equal(fx.head(), before, "nothing landed without the user");
  });

  async function differing(ho: HarnessOptions) {
    const { fx, h } = await setup({}, ho);
    const a = fx.branch("a", { "src/app.txt": APP("THREE-A") });
    const b = fx.branch("b", { "src/app.txt": APP("THREE-B") });
    assert.equal((await h.waitEntry((await h.add({ branch: a.branch })).id, settled)).state, "landed");
    return { fx, h, b };
  }
  const differs: HarnessOptions = {
    thread: {
      conflict: async (h, e) => {
        const c = resolution(h.fx, e.commit, "src/app.txt", APP("THREE-B"));
        await h.resolve(e.id, { verdict: "behaviour-differs", files: ["src/app.txt"], ours: "line 3 reads THREE-A", theirs: "line 3 reads THREE-B", proposal: "take the branch's THREE-B", commit: c });
      },
    },
  };

  test("S3: behaviour differs: waits for the user with both sides; Accept runs the proposed resolution and lands it", async () => {
    const { fx, h, b } = await differing(differs);
    const before = fx.head();
    const eb = await h.add({ branch: b.branch });
    const w = await h.waitEntry(eb.id, settled);
    assert.equal(w.state, "behaviour-differs", `${w.state}: ${w.reason}`);
    assert.match(w.conflict?.ours ?? "", /THREE-A/);
    assert.match(w.conflict?.theirs ?? "", /THREE-B/);
    assert.equal(fx.head(), before);
    const v = await h.view();
    assert.ok(v.needsYou.some((x) => x.id === eb.id), "in the needs-you list");
    await h.answer(eb.id, "accept");
    const l = await h.waitEntry(eb.id, (x) => x.state === "landed" || x.state === "needs-fix");
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.match(fx.fileAt(fx.head(), "src/app.txt") ?? "", /THREE-B/);
  });

  test("S3b: behaviour differs, Send Back: the entry goes back to its chat; master unmoved", async () => {
    const { fx, h, b } = await differing(differs);
    const before = fx.head();
    const eb = await h.add({ branch: b.branch });
    assert.equal((await h.waitEntry(eb.id, settled)).state, "behaviour-differs");
    await h.answer(eb.id, "send-back");
    const s = await h.waitEntry(eb.id, ["needs-fix"]);
    assert.equal(s.state, "needs-fix");
    assert.equal(fx.head(), before);
    assert.ok(h.notices.some((n) => n.branch === b.branch && n.kind === "sent-back"), "its chat is told");
  });

  test("S2c: a resolution judged safe that then fails a test comes back to the user; the branch is not blamed", async () => {
    const { fx, h, b } = await twoAppenders(
      {
        thread: {
          conflict: async (h, e) => {
            const c = resolution(h.fx, e.commit, "src/list.txt", LIST_PLUS("delta\necho"));
            await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "delta", theirs: "echo", proposal: "keep both", commit: c });
          },
        },
      },
      // tests/combo.txt fails when the list holds both delta and echo: each side alone passes, the resolution fails.
      { files: { "tests/combo.txt": "forbid delta echo\n" } },
    );
    const before = fx.head();
    const eb = await h.add({ branch: b.branch });
    const s = await h.waitEntry(eb.id, (x) => settled(x) && x.state !== "landed" || x.state === "landed");
    assert.notEqual(s.state, "landed");
    assert.equal(fx.head(), before);
    assert.equal(h.run(s.run!).blame, "resolution", `blamed on the resolution (${h.run(s.run!).blame})`);
    assert.ok((["behaviour-differs", "conflict"] as string[]).includes(s.state) || s.state === "needs-fix", `back to the user: ${s.state}`);
    assert.equal(h.notices.filter((n) => n.kind === "needs-fix").length, 0, "the branch's chat isn't told to fix it");
  });

  test("S2d: no thread (down): a conflict is handed back to its chat after the wait, nothing else held up", async () => {
    const { fx, h, b } = await twoAppenders({ conflictWaitMs: 500 });
    const c = fx.branch("c", { "c.txt": "c\n" });
    const eb = await h.add({ branch: b.branch });
    const ec = await h.add({ branch: c.branch });
    const lc = await h.waitEntry(ec.id, settled);
    assert.equal(lc.state, "landed", "the line moved on past the conflict");
    const s = await h.waitEntry(eb.id, ["needs-fix", "behaviour-differs"]);
    assert.equal(s.state, "needs-fix", `${s.state}: ${s.reason}`);
    assert.match(s.reason ?? "", /conflict/i);
  });

  test("S2e: a resolution with its parents reversed ([pinned, target]) is never landed: it waits for the user with a clear why", async () => {
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, e) => {
          const c = reversedResolution(h.fx, e.commit, "src/list.txt", LIST_PLUS("delta\necho"));
          await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "delta", theirs: "echo", proposal: "keep both", commit: c });
        },
      },
    });
    const before = fx.head();
    const s = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(s.state, "behaviour-differs", `${s.state}: ${s.reason}`);
    assert.match(s.reason ?? JSON.stringify(s.conflict?.sanity), /second parent|approved commit/);
    assert.equal(fx.head(), before);
  });

  test("S2f: git rerere on (the user's global config has it) and the conflict resolved by hand before: still a conflict the thread judges, never a machine pause", async () => {
    let called = 0;
    const { fx, h, b } = await twoAppenders({
      conflictWaitMs: 500,
      thread: {
        conflict: async () => {
          called++;
        },
      },
    });
    // rerere.enabled + autoupdate, as in the user's ~/.config/git/config; the merge copy is a worktree of this repo,
    // so it shares the config and rr-cache. One earlier hand resolution of the same conflict is recorded.
    git(fx.project, ["config", "rerere.enabled", "true"]);
    git(fx.project, ["config", "rerere.autoupdate", "true"]);
    const tmp = join(fx.parent, "rerere-tmp");
    git(fx.project, ["worktree", "add", "-q", "--detach", tmp, fx.target]);
    git(tmp, ["merge", "--no-ff", "--no-edit", b.commit], { allowFail: true });
    writeFileSync(join(tmp, "src/list.txt"), LIST_PLUS("delta\necho"));
    git(tmp, ["add", "src/list.txt"]);
    git(tmp, ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-edit"]);
    git(fx.project, ["worktree", "remove", "--force", tmp]);
    const before = fx.head();
    const eb = await h.add({ branch: b.branch });
    const v = await h.waitView((v) => v.state === "paused" || [...v.needsYou, ...v.needsFix, ...v.recent.map((r) => r.entry)].some((x) => x.id === eb.id), "the conflict judged, or a pause", 60_000);
    assert.notEqual(v.state, "paused", `the queue paused: ${JSON.stringify(v.paused)}`);
    const s = await h.entry(eb.id);
    assert.ok(["conflict", "needs-fix"].includes(s.state), `${s.state}: ${s.reason}`);
    assert.equal(called, 1, "the thread was asked to judge it");
    assert.equal(fx.head(), before);
    assert.match(`${s.reason ?? ""} ${JSON.stringify(s.conflict ?? {})}`, /src\/list\.txt|conflict/i, `${s.state}: ${s.reason} ${JSON.stringify(s.conflict)}`);
    assert.ok(!/machine|git merge failed/i.test(s.reason ?? ""), `not a machine failure: ${s.reason}`);
  });

  // ---- the scratch copy Sova makes for the thread (scratch.ts) --------------------------------------------------

  /** The thread's resolution made where the Conflict message says: in Sova's scratch copy, never a worktree of its own. */
  function resolveInScratch(h: { fx: Fixture }, ev: ThreadEvent, pinned: string, file: string, content: string): string {
    assert.ok(ev.scratch, `the Conflict message names a scratch copy (${ev.scratchError ?? "no error"})`);
    git(ev.scratch!, ["merge", "-q", "--no-ff", "--no-commit", pinned], { allowFail: true });
    writeFileSync(join(ev.scratch!, file), content);
    git(ev.scratch!, ["add", file]);
    git(ev.scratch!, ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-edit", "-m", "merge queue: resolve"]);
    void h;
    return git(ev.scratch!, ["rev-parse", "HEAD"]);
  }
  const refOf = (fx: Fixture, entry: string) => git(fx.project, ["for-each-ref", "--format=%(objectname)", resolveRef(entry)]);
  const worktreeList = (fx: Fixture) => git(fx.project, ["worktree", "list", "--porcelain"]);
  /** The copy and the pinned resolution of `entry` are gone (removed after the save that made the entry final). */
  async function scratchGone(fx: Fixture, entry: string): Promise<void> {
    const path = scratchCopyPath(fx.project, entry);
    await until(`${entry}'s scratch copy and ref removed`, () => !existsSync(path) && !refOf(fx, entry) && !worktreeList(fx).includes(path));
  }
  /** What the copy looked like when the thread was told: there, detached at the target's head, marked, never Ready. */
  type Seen = { path: string; detached: boolean; atHead: boolean; marked: boolean; readyBranches: string[]; readyTrees: string[] };
  /** The Ready rows read from git now (the list is otherwise kept 15 s while the target stands still). */
  const freshReady = (h: { queue(): unknown }) => {
    const q = h.queue() as { readyCache: unknown; readyRows(): Promise<{ branch: string; worktree: string }[]> };
    q.readyCache = null;
    return q.readyRows();
  };
  async function look(h: { fx: Fixture; queue(): unknown }, ev: ThreadEvent): Promise<Seen> {
    const path = ev.scratch!;
    const rows = await freshReady(h);
    return {
      path,
      detached: git(path, ["symbolic-ref", "-q", "HEAD"], { allowFail: true }) === "",
      atHead: git(path, ["rev-parse", "HEAD"]) === h.fx.head(),
      marked: scratchMarkOf(path)?.entry === ev.entry.id,
      readyBranches: rows.map((r) => r.branch),
      readyTrees: rows.map((r) => r.worktree),
    };
  }
  const assertSeen = (s: Seen | null, entry: string, fx: Fixture) => {
    assert.ok(s, "the thread was told of the conflict");
    assert.equal(s.path, scratchCopyPath(fx.project, entry));
    assert.ok(s.detached, "the copy is on no branch");
    assert.ok(s.atHead, "the copy stands at the target's head");
    assert.ok(s.marked, "the copy carries the queue's mark");
    assert.ok(!s.readyTrees.includes(s.path), `never a Ready row: ${JSON.stringify(s.readyTrees)}`);
  };

  test("S2g: Sova makes the scratch copy, the thread resolves in it, it lands: the copy and its pinned resolution go", async () => {
    let seen: Seen | null = null;
    let pinned = "";
    let res = "";
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, e, ev) => {
          seen = await look(h, ev);
          res = resolveInScratch(h, ev, e.commit, "src/list.txt", LIST_PLUS("delta\necho"));
          await h.resolve(e.id, { verdict: "no-behaviour-change", files: ["src/list.txt"], ours: "master adds delta", theirs: "the branch adds echo", proposal: "keep both", commit: res });
          pinned = refOf(h.fx, e.id);
          // A branch made in the copy still never makes it Ready.
          git(ev.scratch!, ["switch", "-q", "-c", `stray-${e.id}`]);
          const rows = await freshReady(h);
          assert.ok(!rows.some((r) => r.worktree === ev.scratch || r.branch === `stray-${e.id}`), `a branch switched to in the copy isn't Ready either: ${JSON.stringify(rows)}`);
          git(ev.scratch!, ["switch", "-q", "--detach", res]);
          git(h.fx.project, ["branch", "-D", `stray-${e.id}`]);
        },
      },
    });
    const eb = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(eb.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assertSeen(seen, eb.id, fx);
    assert.equal(pinned, res, "merge.resolve pinned the resolution under the hidden ref");
    assert.equal(fx.head(), res);
    await scratchGone(fx, eb.id);
  });

  test("S3c: behaviour differs, Send Back: the scratch copy and the proposal's pin go", async () => {
    let seen: Seen | null = null;
    const { fx, h, b } = await differing({
      thread: {
        conflict: async (h, e, ev) => {
          seen = await look(h, ev);
          const c = resolveInScratch(h, ev, e.commit, "src/app.txt", APP("THREE-B"));
          await h.resolve(e.id, { verdict: "behaviour-differs", files: ["src/app.txt"], ours: "line 3 reads THREE-A", theirs: "line 3 reads THREE-B", proposal: "take THREE-B", commit: c });
        },
      },
    });
    const eb = await h.add({ branch: b.branch });
    assert.equal((await h.waitEntry(eb.id, settled)).state, "behaviour-differs");
    assertSeen(seen, eb.id, fx);
    assert.ok(refOf(fx, eb.id), "the proposal is pinned while it waits for the user");
    assert.ok(existsSync(scratchCopyPath(fx.project, eb.id)), "the copy stays while the attempt is open");
    await h.answer(eb.id, "send-back");
    assert.equal((await h.waitEntry(eb.id, ["needs-fix"])).state, "needs-fix");
    await scratchGone(fx, eb.id);
  });

  test("S2h: a conflict cancelled while the thread works: the scratch copy goes", async () => {
    let seen: Seen | null = null;
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, _e, ev) => {
          seen = await look(h, ev);
        },
      },
    });
    const eb = await h.add({ branch: b.branch });
    await h.waitEntry(eb.id, (x) => x.state === "conflict");
    await until("the thread was told", () => seen);
    assertSeen(seen, eb.id, fx);
    await h.cancel(eb.id);
    await scratchGone(fx, eb.id);
  });

  test("S2i: approved again at a newer commit while in conflict (superseded): the old attempt's copy goes", async () => {
    const seen: Seen[] = [];
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, _e, ev) => {
          seen.push(await look(h, ev));
        },
      },
    });
    const eb = await h.add({ branch: b.branch });
    await h.waitEntry(eb.id, (x) => x.state === "conflict");
    await until("the thread was told", () => seen.length > 0 || null);
    assertSeen(seen[0]!, eb.id, fx);
    fx.commitIn(b.checkout, { "src/more.txt": "more\n" }, "more on b");
    const newer = await h.add({ branch: b.branch });
    assert.notEqual(newer.id, eb.id);
    assert.equal((await h.entry(eb.id)).state, "cancelled");
    await scratchGone(fx, eb.id);
  });

  test("S2j: Sova restarts while a conflict waits: the open attempt keeps its copy; once it ends, it goes", async () => {
    let seen: Seen | null = null;
    const { fx, h, b } = await twoAppenders({
      thread: {
        conflict: async (h, _e, ev) => {
          seen = await look(h, ev);
        },
      },
    });
    const eb = await h.add({ branch: b.branch });
    await h.waitEntry(eb.id, (x) => x.state === "conflict");
    await until("the thread was told", () => seen);
    await h.restart();
    assert.equal((await h.entry(eb.id)).state, "conflict");
    assert.ok(existsSync(scratchCopyPath(fx.project, eb.id)), "the start's sweep keeps an open entry's copy");
    await h.cancel(eb.id);
    await scratchGone(fx, eb.id);
  });
});
