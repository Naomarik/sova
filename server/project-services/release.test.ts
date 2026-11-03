import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ProjectDef, ReleaseDecl } from "../../shared/project-contract";
import { planChecks } from "../merge-queue/checks";
import { DEF, makeKit, makeRepo, sh, tryGit, until, type Kit } from "../merge-queue/testing/queue-kit";
import type { Caller } from "./engine";
import { authorizeRelease, FROM_CHAT, REPORTS_FROM_THREAD, ReleaseFailure, Releaser, SESSION_NEVER } from "./release";

const RELEASE: ReleaseDecl = {
  playbook: ".sova/playbooks/release",
  tag: "v${version}",
  scheme: "semver",
  channels: ["stable"],
  commit: true,
  checks: [{ id: "full", label: "Full suite", run: ["true"], timeout: 60, rerun: false, requires: [] }],
  checkIds: ["full"],
  quietMin: 30,
};
const MANIFEST = { v: 1, steps: [{ id: "version", label: "Pick the version", phase: "prepare" }, { id: "notes", label: "Draft the notes", phase: "prepare" }, { id: "commit", label: "Make the release commit", phase: "prepare" }, { id: "page", label: "Release page", phase: "after" }] };

const landedState = (k: Kit, id: string) =>
  until(async () => {
    const e = await k.entry(id);
    return e.state === "landed" && e.landed?.pushed !== "pending";
  }, `${id} landed`);

/** A project with a release section and its playbook's manifest on master (pushed), plus v0.1.0 and stable. */
function releaseKit(o: { settings?: Partial<ReleaseDecl>; manifest?: unknown; origin?: boolean; push?: boolean } = {}) {
  const repo = makeRepo({ prefix: "release-unit-" });
  if (o.origin === false) sh(repo.root, "remote", "remove", "origin");
  mkdirSync(join(repo.root, ".sova", "playbooks", "release"), { recursive: true });
  writeFileSync(join(repo.root, ".sova", "playbooks", "release", "release.json"), JSON.stringify(o.manifest ?? MANIFEST));
  writeFileSync(join(repo.root, "VERSION"), "0.1.0\n");
  sh(repo.root, "add", "-A");
  sh(repo.root, "commit", "-q", "-m", "release playbook");
  sh(repo.root, "tag", "-a", "v0.1.0", "-m", "First");
  sh(repo.root, "tag", "-a", "stable", "-m", "stable: v0.1.0");
  if (o.origin !== false) sh(repo.root, "push", "-q", "origin", "master", "v0.1.0", "stable");
  const settings = { ...RELEASE, ...o.settings };
  const def = { ...DEF, merge: { ...(DEF as { merge: object }).merge, ...(o.push === false ? { push: false } : {}) }, release: settings } as unknown as ProjectDef;
  const k = makeKit({ repo, deps: { definitionAt: async () => ({ def, error: null }), releaseEvent: (ev) => r.onQueueEvent(ev, ev.root) } });
  const wakes: { path: string; text: string }[] = [];
  const starts: { checkout: string; text: string }[] = [];
  let clock = Date.now();
  const r = new Releaser({
    dir: join(repo.state, "release"),
    queue: () => k.q(),
    rootOf: async (p) => (p.startsWith(repo.root) ? repo.root : null),
    definitionAt: async () => ({ def, error: null }),
    thread: {
      async start(i) {
        starts.push(i);
        return { id: "s-release", path: join(repo.state, "s-release.jsonl") };
      },
      async wake(path, text) {
        wakes.push({ path, text });
        return { ok: true };
      },
    },
    now: () => clock,
    log: () => {},
  });
  const op: Caller = { kind: "operator" };
  const chat: Caller = { kind: "session", id: "s-release", root: repo.root, own: [] };
  const call = (verb: string, body: Record<string, unknown>, caller: Caller = op) => r.run(verb, { project: repo.root, ...body }, caller);
  return { repo, k, r, wakes, starts, op, chat, call, def, tick: (ms: number) => (clock += ms), done: () => k.done() };
}

/** Start a release and report its prepare steps; the release commit bumps VERSION in the release worktree. */
async function prepared(t: ReturnType<typeof releaseKit>, version = "0.2.0") {
  const s = await t.call("release.start", {});
  assert.equal(s.ok, true, JSON.stringify(s.error));
  const rec = s.release!.release!;
  const checkout = rec.thread!.checkout!;
  assert.equal((await t.call("release.step", { step: "version", state: "done", summary: `v${version}`, facts: [`version=${version}`] }, t.chat)).ok, true);
  assert.equal((await t.call("release.notes", { text: `## v${version}\n\nThings.` }, t.chat)).ok, true);
  assert.equal((await t.call("release.step", { step: "notes", state: "done", summary: "written" }, t.chat)).ok, true);
  writeFileSync(join(checkout, "VERSION"), `${version}\n`);
  sh(checkout, "add", "-A");
  sh(checkout, "commit", "-q", "-m", `Release v${version}`);
  const sha = sh(checkout, "rev-parse", "HEAD");
  return { rec, checkout, sha };
}

describe("who may call which release verb (t17, q3, q12)", () => {
  const root = "/p";
  const thread = true;
  const cases: [string, Caller, boolean, RegExp | null][] = [
    ["release.status", { kind: "operator" }, false, null],
    ["release.status", { kind: "session", id: "x", root, own: [] }, false, null],
    ["release.step", { kind: "operator" }, false, new RegExp(REPORTS_FROM_THREAD.slice(0, 30))],
    ["release.notes", { kind: "operator", fromChat: true }, false, new RegExp(REPORTS_FROM_THREAD.slice(0, 30))],
    ["release.step", { kind: "session", id: "x", root, own: [] }, false, /only the release's own chat/],
    ["release.step", { kind: "session", id: "t", root, own: [] }, thread, null],
    ["release.start", { kind: "session", id: "x", root, own: [] }, false, new RegExp(SESSION_NEVER.slice(0, 30))],
    ["release.request", { kind: "session", id: "x", root, own: [] }, false, new RegExp(SESSION_NEVER.slice(0, 30))],
    ["release.publish", { kind: "operator", fromChat: true }, false, new RegExp(FROM_CHAT.slice(0, 30))],
    ["release.start", { kind: "operator", fromChat: true }, false, new RegExp(FROM_CHAT.slice(0, 30))],
    ["release.publish", { kind: "operator" }, false, /needs confirm/],
    ["release.withdraw", { kind: "operator" }, false, /needs confirm/],
    ["release.abandon", { kind: "session", id: "t", root, own: [] }, thread, /never abandon itself/],
    ["release.publish", { kind: "session", id: "t", root, own: [] }, thread, /operator's/],
    ["release.publish", { kind: "project-overseer", id: "po", root, act: async () => {} }, false, /needs the release power/],
    ["release.publish", { kind: "project-overseer", id: "po", root, act: async () => {}, releaseAct: true }, false, null],
    ["release.start", { kind: "assistant", id: "pa", root, releaseAct: true }, false, null],
    ["release.withdraw", { kind: "project-overseer", id: "po", root, act: async () => {}, releaseAct: true }, false, /operator's alone/],
    ["release.request", { kind: "project-overseer", id: "po", root, act: async () => {} }, false, null],
    ["release.request", { kind: "overseer", id: "o" }, false, null],
    ["release.request", { kind: "operator" }, false, /release.start/],
    ["release.status", { kind: "project-overseer", id: "po", root: "/other", act: async () => {} }, false, /its own project/],
    ["release.status", { kind: "conform", id: "c" }, false, /never releases/],
  ];
  for (const [verb, caller, isThread, refused] of cases) {
    test(`${verb} by ${caller.kind}${(caller as { fromChat?: true }).fromChat ? " (from a chat's script)" : ""}${(caller as { releaseAct?: true }).releaseAct ? " (release act)" : ""}${isThread ? " (the release chat)" : ""}: ${refused ? "refused" : "allowed"}`, () => {
      const go = () => authorizeRelease(verb as never, caller, root, {}, isThread);
      if (refused) assert.throws(go, (e: unknown) => e instanceof ReleaseFailure && refused.test(e.message));
      else go();
    });
  }
  test("the operator's confirmed publish passes", () => authorizeRelease("release.publish", { kind: "operator" }, root, { confirm: true }, false));
});

describe("a release's gating checks run after the merge set", () => {
  test("required merge checks, then the release's own; one the merge set already runs runs once", () => {
    const list = planChecks(DEF, [], [{ id: "unit", label: "Unit tests", run: ["true"], timeout: 60, rerun: false, requires: [] }, ...RELEASE.checks]);
    assert.deepEqual(list.map((c) => [c.id, c.source]), [["unit", "required"], ["statecharts", "required"], ["full", "release"]]);
  });
  test("a project declaring no merge checks still runs the release's", () => {
    const def = { version: 1, merge: { checks: "none" } } as unknown as ProjectDef;
    assert.deepEqual(planChecks(def, [], RELEASE.checks).map((c) => c.id), ["full"]);
    assert.deepEqual(planChecks(def, []).map((c) => c.id), []);
  });
});

describe("the freeze, the release entry and Publish (q9, a5, a6)", () => {
  test("while a release is open B stays queued and the main checkout stays at the release commit; Publish pushes master, the tag and stable at once with no further landing; then B lands", async () => {
    const t = releaseKit();
    try {
      const base = t.repo.head();
      const pushedBefore = sh(t.repo.origin, "rev-parse", "master");
      const { rec, sha } = await prepared(t);
      const q = await t.k.q();
      assert.equal(q.releaseHold()?.id, rec.id);
      // B is approved while the release is open: it waits.
      const b = t.repo.branch("feat/b", { "b.txt": "b\n" });
      const { entry: eb } = await q.add({ branch: "feat/b", by: "land-button" });
      const c = await t.call("release.step", { step: "commit", state: "done", summary: "release commit", facts: [`commit=${sha}`, `branch=release/${rec.id}`] }, t.chat);
      assert.equal(c.ok, true, JSON.stringify(c.error));
      const recNow = () => t.r.record(t.repo.root, rec.id)!;
      await until(() => recNow().state === "ready", "the release ready");
      await landedState(t.k, recNow().entry!);
      const R = recNow().commit!;
      assert.equal(t.repo.head(), R, "master is on the release commit");
      assert.ok(tryGit(t.repo.root, "merge-base", "--is-ancestor", sha, R).code === 0, "the release commit is in it");
      assert.equal(sh(t.repo.root, "rev-parse", "HEAD"), R, "the main checkout is on R");
      assert.equal(sh(t.repo.origin, "rev-parse", "master"), pushedBefore, "nothing pushed while the release is open");
      const releaseEntry = (await t.k.entry(recNow().entry!));
      assert.equal(releaseEntry.landed?.pushed, "not-pushed");
      assert.match(releaseEntry.landed?.pushWhy ?? "", /held: release 0\.2\.0 is open/);
      assert.deepEqual(t.k.run.inputs.find((i) => i.entry.release === rec.id)?.releaseChecks?.map((c) => c.id), ["full"], "the release entry ran the release's own checks");
      // B waits, named.
      const bNow = await t.k.entry(eb.id);
      assert.equal(bNow.state, "queued");
      assert.equal(bNow.reason, "waiting for release 0.2.0");
      assert.equal(t.k.run.inputs.filter((i) => i.entry.id === eb.id).length, 0, "B never ran");
      const v = await q.view();
      assert.equal(v.release?.id, rec.id);
      assert.equal(v.release?.version, "0.2.0");
      // Publish.
      const before = t.k.run.inputs.length;
      const p = await t.call("release.publish", { confirm: true });
      assert.equal(p.ok, true, JSON.stringify(p.error));
      assert.equal(p.release!.release!.state, "published");
      assert.equal(p.release!.release!.publish!.pushed, "pushed");
      assert.equal(sh(t.repo.origin, "rev-parse", "master"), R, "master pushed at R");
      assert.equal(sh(t.repo.origin, "rev-parse", "v0.2.0^{commit}"), R);
      assert.equal(sh(t.repo.origin, "rev-parse", "stable^{commit}"), R);
      assert.equal(sh(t.repo.origin, "cat-file", "-t", "v0.2.0"), "tag", "annotated");
      assert.match(sh(t.repo.origin, "tag", "-l", "--format=%(contents)", "v0.2.0"), /Things\./, "the tag's message is the notes");
      assert.equal(p.release!.release!.publish!.channelsFrom.stable, base, "stable's old commit kept for Withdraw");
      // No further landing happened between Publish and the push.
      assert.equal(t.k.run.inputs.slice(before).filter((i) => i.entry.id !== eb.id).length, 0);
      assert.equal(q.releaseHold(), null, "the hold is lifted");
      await landedState(t.k, eb.id);
      assert.equal(sh(t.repo.origin, "rev-parse", "master"), (await t.k.entry(eb.id)).landed!.sha, "B landed and pushed after Publish");
      void b;
      assert.ok(t.wakes.some((w) => /Published v0\.2\.0\. Run the after-publish steps now \(page\)/.test(w.text)));
    } finally {
      await t.done();
    }
  });

  test("a run of another branch in flight at Start is voided and waits for the release; master stays at the base", async () => {
    const t = releaseKit();
    try {
      const q = await t.k.q();
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      t.k.run.set(async (input) => (input.entry.release ? {} : (await gate, input.signal.aborted ? { verdict: "void" } : {})));
      t.repo.branch("feat/b", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/b", by: "land-button" });
      await until(async () => (await t.k.entry(entry.id)).state === "checking", "B checking");
      const base = t.repo.head();
      const s = await t.call("release.start", {});
      assert.equal(s.ok, true);
      release();
      await until(async () => (await t.k.entry(entry.id)).state === "queued", "B back in line");
      assert.match((await t.k.entry(entry.id)).reason ?? "", /waiting for release/);
      assert.equal(t.repo.head(), base);
      assert.equal(s.release!.release!.base, base);
    } finally {
      await t.done();
    }
  });

  test("a local-only project (no origin): Publish tags and moves stable on this machine and pushes nothing", async () => {
    const t = releaseKit({ origin: false });
    try {
      const { rec, sha } = await prepared(t, "0.3.0");
      await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sha}`] }, t.chat);
      await until(() => t.r.record(t.repo.root, rec.id)!.state === "ready", "ready");
      const p = await t.call("release.publish", { confirm: true });
      assert.equal(p.ok, true, JSON.stringify(p.error));
      assert.equal(p.release!.release!.publish!.pushed, "no-remote");
      const R = t.repo.head();
      assert.equal(sh(t.repo.root, "rev-parse", "v0.3.0^{commit}"), R);
      assert.equal(sh(t.repo.root, "rev-parse", "stable^{commit}"), R);
      const v = (await t.call("release.status", {})).release!.view!;
      assert.equal(v.remote, false);
      assert.equal(v.latest, "v0.3.0");
      assert.deepEqual(v.history.map((h) => [h.tag, h.channels]), [["v0.3.0", ["stable"]], ["v0.1.0", []]]);
    } finally {
      await t.done();
    }
  });

  test("push: false tags and moves the channel locally, origin untouched", async () => {
    const t = releaseKit({ push: false });
    try {
      const before = sh(t.repo.origin, "rev-parse", "master");
      const { rec, sha } = await prepared(t, "0.4.0");
      await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sha}`] }, t.chat);
      await until(() => t.r.record(t.repo.root, rec.id)!.state === "ready", "ready");
      const p = await t.call("release.publish", { confirm: true });
      assert.equal(p.release!.release!.publish!.pushed, "not-pushed");
      assert.equal(sh(t.repo.origin, "rev-parse", "master"), before);
      assert.equal(tryGit(t.repo.origin, "rev-parse", "v0.4.0").code !== 0, true);
      assert.equal(sh(t.repo.root, "rev-parse", "v0.4.0^{commit}"), t.repo.head());
    } finally {
      await t.done();
    }
  });

  test("Publish refused before the gates pass (no notes), and never past a failed gating check; a failed push leaves every ref as before", async () => {
    const t = releaseKit();
    try {
      const s = await t.call("release.start", {});
      const rec = s.release!.release!;
      const early = await t.call("release.publish", { confirm: true });
      assert.equal(early.error?.code, "release-refused");
      assert.match(early.error!.message, /gating checks haven't passed/);
      await t.call("release.step", { step: "version", state: "done", summary: "v", facts: ["version=0.2.0"] }, t.chat);
      await t.call("release.step", { step: "notes", state: "skipped", summary: "none" }, t.chat);
      const co = rec.thread!.checkout!;
      writeFileSync(join(co, "VERSION"), "0.2.0\n");
      sh(co, "commit", "-qam", "Release v0.2.0");
      t.k.run.set((input) => (input.entry.release ? { verdict: "failed", blame: "branch", why: "full failed" } : {}));
      await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sh(co, "rev-parse", "HEAD")}`] }, t.chat);
      await until(() => t.r.record(t.repo.root, rec.id)!.steps.find((x) => x.id === "checks")!.state === "failed", "checks failed");
      const r1 = await t.call("release.publish", { confirm: true });
      assert.equal(r1.error?.code, "release-refused");
      assert.match(r1.error!.message, /a gating check failed/);
      const act = await t.r.run("release.publish", { project: t.repo.root }, { kind: "project-overseer", id: "po", root: t.repo.root, act: async () => {}, releaseAct: true });
      assert.equal(act.error?.code, "release-refused", "the release power never overrides a failed check");
      // Retry Step runs the checks again; this time they pass.
      t.k.run.set(null);
      assert.equal((await t.call("release.retry", { step: "checks" })).ok, true);
      await until(() => t.r.record(t.repo.root, rec.id)!.steps.find((x) => x.id === "checks")!.state === "done", "checks passed");
      const r2 = await t.call("release.publish", { confirm: true });
      assert.match(r2.error?.message ?? "", /no release notes/);
      await t.call("release.notes", { text: "Notes." }, t.chat);
      // origin moves its stable away under us: the lease refuses; nothing changes locally.
      sh(t.repo.root, "tag", "-f", "-a", "stable", "-m", "moved", "v0.1.0^{commit}");
      const other = sh(t.repo.root, "commit-tree", "HEAD^{tree}", "-m", "elsewhere");
      sh(t.repo.root, "push", "-q", "-f", "origin", `${other}:refs/tags/stable`);
      const stableLocal = sh(t.repo.root, "rev-parse", "stable");
      const r3 = await t.call("release.publish", { confirm: true });
      assert.equal(r3.ok, false);
      assert.match(r3.error!.message, /origin refused the push/);
      assert.equal(tryGit(t.repo.root, "rev-parse", "--verify", "refs/tags/v0.2.0").code !== 0, true, "the numbered tag was taken back");
      assert.equal(sh(t.repo.root, "rev-parse", "stable"), stableLocal, "stable as before");
      assert.equal(t.r.record(t.repo.root, rec.id)!.state, "ready");
      assert.equal((await t.k.q()).releaseHold()?.id, rec.id, "the hold stays");
    } finally {
      await t.done();
    }
  });
});

describe("facts win (q10)", () => {
  test("a commit not cut from the base, a version whose tag exists, an artifact inside the repository: the step reads failed with Sova's why", async () => {
    const t = releaseKit();
    try {
      const s = await t.call("release.start", {});
      const rec = s.release!.release!;
      const v = await t.call("release.step", { step: "version", state: "done", summary: "v0.1.0", facts: ["version=0.1.0"] }, t.chat);
      assert.equal(v.error?.code, "release-refused");
      assert.match(v.error!.message, /v0\.1\.0 already exists/);
      assert.equal(v.release!.release!.steps.find((x) => x.id === "version")!.state, "failed");
      const bad = await t.call("release.step", { step: "version", state: "done", summary: "x", facts: ["version=banana"] }, t.chat);
      assert.match(bad.error!.message, /not a semantic version/);
      assert.equal((await t.call("release.step", { step: "version", state: "done", summary: "ok", facts: ["version=0.2.0"] }, t.chat)).ok, true);
      const elsewhere = t.repo.branch("feat/x", { "x.txt": "x\n" });
      sh(t.repo.root, "commit-tree", "-m", "orphan", sh(t.repo.root, "rev-parse", "HEAD^{tree}"));
      const c = await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${elsewhere.head}`] }, t.chat);
      assert.match(c.error!.message, /isn't on release\//);
      const unknown = await t.call("release.step", { step: "nope", state: "done", summary: "x" }, t.chat);
      assert.match(unknown.error!.message, /isn't a step of this release's plan/);
      const own = await t.call("release.step", { step: "checks", state: "done", summary: "x" }, t.chat);
      assert.match(own.error!.message, /Sova's own step/);
      const after = await t.call("release.step", { step: "page", state: "done", summary: "x" }, t.chat);
      assert.match(after.error!.message, /once the release is published/);
      void rec;
    } finally {
      await t.done();
    }
  });

  test("an artifact step: a path inside the repository and not ignored is refused; outside it, its sha256 and size are checked", async () => {
    const manifest = { v: 1, steps: [{ id: "version", label: "V", phase: "prepare" }, { id: "build", label: "Build", phase: "prepare", artifact: true }] };
    const t = releaseKit({ manifest, settings: { commit: false } });
    try {
      await t.call("release.start", {});
      await t.call("release.step", { step: "version", state: "done", summary: "v", facts: ["version=0.2.0"] }, t.chat);
      writeFileSync(join(t.repo.root, "app.jar"), "x");
      const inside = await t.call("release.step", { step: "build", state: "done", summary: "built", facts: [`artifact=${join(t.repo.root, "app.jar")}`] }, t.chat);
      assert.match(inside.error!.message, /inside the repository and not ignored/);
      const out = join(t.repo.scratch, "out.jar");
      writeFileSync(out, "abc");
      const wrong = await t.call("release.step", { step: "build", state: "done", summary: "built", facts: [`artifact=${out}`, "size=4"] }, t.chat);
      assert.match(wrong.error!.message, /is 3 bytes, not 4/);
      const ok = await t.call("release.step", { step: "build", state: "done", summary: "built", facts: [`artifact=${out}`, "size=3", "sha256=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"] }, t.chat);
      assert.equal(ok.ok, true, JSON.stringify(ok.error));
      assert.deepEqual(ok.release!.release!.artifacts.map((a) => a.path), [out]);
      // Tag-only: the last prepare step done starts the checks on the frozen tip.
      await until(() => t.r.openRecord(t.repo.root)?.state === "checking" || t.r.openRecord(t.repo.root)?.steps.find((x) => x.id === "checks")!.state === "done", "checks started");
    } finally {
      await t.done();
    }
  });
});

describe("abandon and withdraw (t23, a8)", () => {
  test("abandoning after the release commit landed reverts it as a queue landing, lifts the hold, and B lands after", async () => {
    const t = releaseKit();
    try {
      const base = t.repo.head();
      const baseTree = sh(t.repo.root, "rev-parse", "HEAD^{tree}");
      const { rec, sha } = await prepared(t);
      await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sha}`] }, t.chat);
      await until(() => t.r.record(t.repo.root, rec.id)!.state === "ready", "ready");
      const q = await t.k.q();
      t.repo.branch("feat/b", { "b.txt": "b\n" });
      const { entry: eb } = await q.add({ branch: "feat/b", by: "land-button" });
      const a = await t.call("release.abandon", { why: "wrong notes", confirm: true });
      assert.equal(a.ok, true, JSON.stringify(a.error));
      const revert = a.release!.release!.abandoned!.revert!;
      assert.ok(revert, "a revert entry");
      await landedState(t.k, revert);
      const rv = await t.k.entry(revert);
      assert.equal(rv.releaseKind, "revert");
      await landedState(t.k, eb.id);
      const tip = t.repo.head();
      assert.equal(sh(t.repo.root, "rev-parse", `${rv.landed!.sha}^{tree}`), baseTree, "the revert puts the tree back to the base's");
      assert.ok(tryGit(t.repo.root, "merge-base", "--is-ancestor", base, tip).code === 0, "history only grows (never a reset)");
      assert.equal(q.releaseHold(), null);
      assert.equal(sh(t.repo.origin, "rev-parse", "master"), tip, "pushes resume");
      assert.equal(tryGit(t.repo.root, "rev-parse", "--verify", "refs/tags/v0.2.0").code !== 0, true, "no tag");
      assert.ok(t.wakes.some((w) => /abandoned/.test(w.text)));
    } finally {
      await t.done();
    }
  });

  test("abandoning before anything landed lifts the hold at once", async () => {
    const t = releaseKit();
    try {
      const s = await t.call("release.start", {});
      const a = await t.call("release.abandon", { confirm: true });
      assert.equal(a.ok, true);
      assert.equal(a.release!.release!.abandoned!.revert, null);
      assert.equal((await t.k.q()).releaseHold(), null);
      assert.equal(t.r.openRecord(t.repo.root), null);
      void s;
    } finally {
      await t.done();
    }
  });

  test("withdraw moves stable back to the previous release (lease, pushed), marks it withdrawn with the reason, never moves the numbered tag", async () => {
    const t = releaseKit();
    try {
      const { rec, sha } = await prepared(t);
      await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sha}`] }, t.chat);
      await until(() => t.r.record(t.repo.root, rec.id)!.state === "ready", "ready");
      assert.equal((await t.call("release.publish", { confirm: true })).ok, true);
      const v010 = sh(t.repo.root, "rev-parse", "v0.1.0^{commit}");
      const v020 = sh(t.repo.root, "rev-parse", "v0.2.0");
      const w = await t.call("release.withdraw", { release: rec.id, why: "breaks settings", confirm: true });
      assert.equal(w.ok, true, JSON.stringify(w.error));
      assert.equal(w.release!.release!.state, "withdrawn");
      assert.match(w.release!.release!.notes!, /Withdrawn .*: breaks settings/);
      assert.equal(sh(t.repo.root, "rev-parse", "stable^{commit}"), v010);
      assert.equal(sh(t.repo.origin, "rev-parse", "stable^{commit}"), v010, "pushed");
      assert.equal(sh(t.repo.root, "rev-parse", "v0.2.0"), v020, "the numbered tag never moves");
      assert.equal(sh(t.repo.origin, "rev-parse", "v0.2.0"), v020);
      assert.match(sh(t.repo.origin, "tag", "-l", "--format=%(contents)", "withdrawn/v0.2.0"), /breaks settings/, "the marker other copies read");
      const view = w.release!.view!;
      assert.equal(view.latest, "v0.1.0");
      assert.equal(view.history.find((h) => h.tag === "v0.2.0")!.withdrawn?.why, "breaks settings");
      const again = await t.call("release.withdraw", { tag: "v0.2.0", why: "x", confirm: true });
      assert.equal(again.ok, false);
    } finally {
      await t.done();
    }
  });
});

describe("the quiet release chat (t23) and Needs you", () => {
  test("no report for quietMin while frozen: release-quiet; a report clears it; held and ready releases are never quiet", async () => {
    const t = releaseKit();
    try {
      const s = await t.call("release.start", {});
      const rec = s.release!.release!;
      assert.equal(t.r.quietOf(t.r.openRecord(t.repo.root)!), null);
      t.tick(31 * 60_000);
      assert.deepEqual(t.r.quietOf(t.r.openRecord(t.repo.root)!), { minutes: 31 });
      assert.ok(t.r.attentionFacts().some((f) => f.kind === "release-quiet" && f.release === rec.id));
      await t.call("release.step", { step: "version", state: "running", summary: "picking" }, t.chat);
      assert.equal(t.r.quietOf(t.r.openRecord(t.repo.root)!), null);
      // A held step waits on the operator.
      await t.call("release.step", { step: "version", state: "held", summary: "which number?" }, t.chat);
      t.tick(60 * 60_000);
      assert.equal(t.r.quietOf(t.r.openRecord(t.repo.root)!), null);
      assert.ok(t.r.attentionFacts().some((f) => f.kind === "release-held"));
      const c = await t.call("release.continue", { step: "version" });
      assert.equal(c.ok, true);
      assert.ok(t.wakes.some((w) => /continued version/.test(w.text)));
    } finally {
      await t.done();
    }
  });

  test("release.request: an overseer asks (Needs you), the operator dismisses it; a coding session never asks", async () => {
    const t = releaseKit();
    try {
      const po: Caller = { kind: "project-overseer", id: "po", root: t.repo.root, act: async () => {} };
      const r = await t.r.run("release.request", { why: "lots landed" }, po);
      assert.equal(r.ok, true, JSON.stringify(r.error));
      assert.ok(t.r.attentionFacts().some((f) => f.kind === "release-request" && /lots landed/.test(f.detail)));
      const s = await t.r.run("release.request", { why: "x" }, { kind: "session", id: "c", root: t.repo.root, own: [] });
      assert.equal(s.error?.code, "forbidden");
      assert.equal((await t.call("release.request", { dismiss: true })).ok, true);
      assert.equal(t.r.attentionFacts().filter((f) => f.kind === "release-request").length, 0);
    } finally {
      await t.done();
    }
  });

  test("not initialized: start refused with the set-up words; status says initialized false; one release at a time", async () => {
    const repo = makeRepo({ prefix: "release-unit-" });
    const k = makeKit({ repo });
    const r = new Releaser({ dir: join(repo.state, "release"), queue: () => k.q(), rootOf: async () => repo.root, definitionAt: async () => ({ def: DEF, error: null }), thread: { start: async () => ({ id: "x", path: "/x" }), wake: async () => ({ ok: true }) }, log: () => {} });
    try {
      const s = await r.run("release.start", { project: repo.root }, { kind: "operator" });
      assert.equal(s.error?.code, "release-refused");
      assert.match(s.error!.message, /Set Up Releases/);
      const v = await r.run("release.status", { project: repo.root }, { kind: "operator" });
      assert.equal(v.release!.view!.initialized, false);
    } finally {
      await k.done();
    }
    const t = releaseKit();
    try {
      assert.equal((await t.call("release.start", {})).ok, true);
      const second = await t.call("release.start", {});
      assert.match(second.error!.message, /already open/);
    } finally {
      await t.done();
    }
  });
});

describe("the release chat's own tool (project_verbs)", () => {
  test("release.step reaches the releaser with step, state, summary, facts and text; no confirm key on the tool", async () => {
    const { projectVerbsTool } = await import("./tools");
    const { stateView } = await import("../harness/state-view");
    const seen: { verb: string; body: Record<string, unknown> }[] = [];
    const engine = { run: async (verb: string, body: Record<string, unknown>) => (seen.push({ verb, body }), { v: 1, verb, project: "/p", instance: null, slot: null, generation: null, checkout: null, branch: null, ok: true, changed: false, state: "absent", steps: [], services: [], data: [], links: [], defHash: null, at: "" }) } as never;
    const tool = projectVerbsTool({ name: "project_verbs", label: "", description: "", promptSnippet: "", engine: () => engine, deploy: "session", merge: true, caller: async () => ({ kind: "session", id: "s", root: "/p", own: [] }), defaultProject: async () => "/p" });
    const ctx = { sessionId: "s", cwd: "/", leafId: () => null, state: () => stateView([]) } as never;
    await tool.execute("t", { verb: "release.step", release: "rl_abcdef12", step: "version", state: "done", summary: "v0.3.0", facts: ["version=0.3.0"], detail: "d" }, undefined, undefined, ctx);
    await tool.execute("t", { verb: "release.notes", text: "Notes" }, undefined, undefined, ctx);
    await tool.execute("t", { verb: "release.abandon", why: "no" }, undefined, undefined, ctx);
    assert.deepEqual(seen[0], { verb: "release.step", body: { project: "/p", release: "rl_abcdef12", step: "version", state: "done", summary: "v0.3.0", facts: ["version=0.3.0"], detail: "d" } });
    assert.equal(seen[1]!.body.text, "Notes");
    assert.equal(seen[2]!.body.why, "no");
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    assert.ok(props.state && props.summary && props.facts && props.step, "the release rows are on the tool");
    assert.equal("confirm" in props, false, "a chat's tool never carries the operator's confirm");
  });
});
