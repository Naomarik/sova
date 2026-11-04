import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ProjectDef, ReleaseDecl } from "../../shared/project-contract";
import { settingsWaitingClause, settingsWaitingWords, SETTINGS_WAITING_WORDS } from "../../shared/merge-queue-settings";
import { planChecks } from "../merge-queue/checks";
import { MergeFailure } from "../merge-queue/queue";
import { projectKey } from "../merge-queue/store";
import { readOverride, writeOverride } from "../merge-queue/strategy";
import { DEF, makeKit, makeRepo, sh, tryGit, until, untilAborted, type Kit } from "../merge-queue/testing/queue-kit";
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
function releaseKit(o: { settings?: Partial<ReleaseDecl>; manifest?: unknown; origin?: boolean; push?: boolean; land?: string } = {}) {
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
  const def = { ...DEF, merge: { ...(DEF as { merge: object }).merge, ...(o.push === false ? { push: false } : {}), ...(o.land ? { land: o.land } : {}) }, release: settings } as unknown as ProjectDef;
  const k = makeKit({ repo, deps: { definitionAt: async () => ({ def, error: null }), releaseEvent: (ev) => r.onQueueEvent(ev, ev.root) } });
  const wakes: { path: string; text: string }[] = [];
  const titles: string[] = [];
  const starts: { checkout: string; text: string }[] = [];
  let clock = Date.now();
  let failNext: string | null = null;
  const r = new Releaser({
    dir: join(repo.state, "release"),
    queue: () => k.q(),
    rootOf: async (p) => (p.startsWith(repo.root) ? repo.root : null),
    definitionAt: async () => ({ def, error: null }),
    thread: {
      async start(i) {
        starts.push(i);
        if (failNext) {
          const error = failNext;
          failNext = null;
          return { error };
        }
        return { id: "s-release", path: join(repo.state, "s-release.jsonl") };
      },
      async wake(path, text) {
        wakes.push({ path, text });
        return { ok: true };
      },
      retitle: (_s, t) => void titles.push(t),
    },
    now: () => clock,
    log: () => {},
  });
  const op: Caller = { kind: "operator" };
  const chat: Caller = { kind: "session", id: "s-release", root: repo.root, own: [] };
  const call = (verb: string, body: Record<string, unknown>, caller: Caller = op) => r.run(verb, { project: repo.root, ...body }, caller);
  return { repo, k, r, wakes, titles, starts, op, chat, call, def, tick: (ms: number) => (clock += ms), failNextStart: (why: string) => void (failNext = why), done: () => k.done() };
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

/** A release ready to publish, its commit on master (nothing pushed yet). */
async function ready(t: ReturnType<typeof releaseKit>) {
  const { rec, sha } = await prepared(t);
  await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sha}`] }, t.chat);
  await until(() => t.r.record(t.repo.root, rec.id)!.state === "ready", "ready");
  await landedState(t.k, t.r.record(t.repo.root, rec.id)!.entry!);
  return t.r.record(t.repo.root, rec.id)!;
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
    ["release.request", { kind: "assistant", id: "pa", root }, false, null],
    ["release.start", { kind: "assistant", id: "pa", root }, false, /needs the release power/],
    ["release.request", { kind: "operator" }, false, /release.start/],
    ["release.status", { kind: "project-overseer", id: "po", root: "/other", act: async () => {} }, false, /its own project/],
    ["release.status", { kind: "conform", id: "c" }, false, /never releases/],
    ["release.note", { kind: "operator" }, false, null],
    ["release.note", { kind: "operator", fromChat: true }, false, new RegExp(FROM_CHAT.slice(0, 30))],
    ["release.note", { kind: "session", id: "x", root, own: [] }, false, new RegExp(SESSION_NEVER.slice(0, 30))],
    ["release.note", { kind: "session", id: "t", root, own: [] }, thread, /operator's/],
    ["release.note", { kind: "project-overseer", id: "po", root, act: async () => {}, releaseAct: true }, false, /operator's alone; ask for it instead/],
    ["release.note", { kind: "assistant", id: "pa", root, releaseAct: true }, false, /operator's alone/],
    ["release.note", { kind: "overseer", id: "o" }, false, /operator's alone/],
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
      assert.match(releaseEntry.landed?.pushWhy ?? "", /held: release v0\.2\.0 is open/);
      assert.deepEqual(t.k.run.inputs.find((i) => i.entry.release === rec.id)?.releaseChecks?.map((c) => c.id), ["full"], "the release entry ran the release's own checks");
      // B waits, named.
      const bNow = await t.k.entry(eb.id);
      assert.equal(bNow.state, "queued");
      assert.equal(bNow.reason, "waits for v0.2.0 to be published or abandoned");
      assert.equal((await q.view()).waiting.find((w) => w.id === eb.id)?.eta, undefined, "no start time while the release holds it");
      assert.equal(t.k.run.inputs.filter((i) => i.entry.id === eb.id).length, 0, "B never ran");
      const v = await q.view();
      assert.equal(v.release?.id, rec.id);
      assert.equal(v.release?.version, "0.2.0");
      assert.equal(v.release?.tag, "v0.2.0");
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
      assert.match((await t.k.entry(entry.id)).reason ?? "", /^waits for the open release to be published or abandoned$/);
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

describe("the screen pass (D1 D2 D6 D8)", () => {
  test("a pushing project with no private names: the gates say so and the release isn't ready; Publish's failure reads once; steps by label; the chat's title gains the tag", async () => {
    const { rmSync } = await import("node:fs");
    const t = releaseKit();
    try {
      rmSync(join(t.repo.state, "merge-round.json"));
      const { rec, sha } = await prepared(t);
      assert.deepEqual(t.titles, ["Release (version not picked yet) of proj", "Release v0.2.0 of proj"]);
      await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sha}`] }, t.chat);
      await until(() => t.r.record(t.repo.root, rec.id)!.steps.find((s) => s.id === "checks")!.state === "done", "checks passed");
      const v = (await t.call("release.status", {})).release!.view!;
      assert.equal(v.open!.state, "checking", "never ready while Publish would be held");
      assert.ok(v.gates!.why.some((w) => /private names are set up/.test(w)), JSON.stringify(v.gates));
      assert.equal(t.r.attentionFacts().some((f) => f.kind === "release-ready"), false);
      assert.match(v.open!.steps.find((s) => s.id === "publish")!.summary ?? "", /private names are set up/, "the Publish step says the same");
      const p = await t.call("release.publish", { confirm: true });
      assert.match(p.error!.message, /private names are set up/);
      // Names written: ready again on the next read.
      writeFileSync(join(t.repo.state, "merge-round.json"), JSON.stringify({ v: 1, privateNames: [] }));
      const after = (await t.call("release.status", {})).release!.view!.open!;
      assert.equal(after.state, "ready");
      assert.equal(after.steps.find((s) => s.id === "publish")!.summary, undefined);
    } finally {
      await t.done();
    }
  });

  test("gates name pending steps by their labels; a failed Publish's Needs-you line says Publish failed once", async () => {
    const t = releaseKit();
    try {
      await t.call("release.start", {});
      const v = (await t.call("release.status", {})).release!.view!;
      assert.match(v.gates!.why.join("; "), /steps not done: Pick the version \(waiting\), Draft the notes \(waiting\), Make the release commit \(waiting\)/);
      const rec = t.r.openRecord(t.repo.root)!;
      const pub = rec.steps.find((s) => s.id === "publish")!;
      Object.assign(pub, { state: "failed", summary: "origin refused the push: x" });
      rec.tag = "v0.2.0";
      (t.r as unknown as { save(r: unknown): void }).save(rec);
      const f = t.r.attentionFacts().find((x) => x.kind === "release-failed")!;
      assert.equal(f.detail, "v0.2.0: Publish failed: origin refused the push: x");
    } finally {
      await t.done();
    }
  });
});

describe("a failed Publish in Needs you", () => {
  /** origin's stable moved elsewhere: the lease refuses the whole push, a real failure through the queue. */
  const breakOrigin = (t: ReturnType<typeof releaseKit>) => sh(t.repo.root, "push", "-q", "-f", "origin", `${sh(t.repo.root, "commit-tree", "HEAD^{tree}", "-m", "elsewhere")}:refs/tags/stable`);
  const mendOrigin = (t: ReturnType<typeof releaseKit>) => sh(t.repo.root, "push", "-q", "-f", "origin", "refs/tags/stable:refs/tags/stable");
  const count = (text: string, what: string) => text.split(what).length - 1;

  test("one item, release-failed, with the real error and Publish failed said once; a failed retry stays one; Publish stays offered, to the operator and the power; a successful retry leaves none", async () => {
    const t = releaseKit();
    try {
      const rec = await ready(t);
      const items = () => t.r.attentionFacts().filter((f) => f.release === rec.id);
      assert.deepEqual(items().map((f) => f.kind), ["release-ready"]);
      breakOrigin(t);
      const first = await t.call("release.publish", { confirm: true });
      assert.equal(first.ok, false);
      assert.equal(count(first.error!.message, "Publish failed"), 1, first.error!.message);
      assert.match(first.error!.message, /^Publish failed, nothing changed: origin refused the push: /);

      // Read back through release.status, as a screen reads it.
      const v = (await t.call("release.status", {})).release!.view!;
      const step = v.open!.steps.find((s) => s.id === "publish")!;
      assert.equal(step.state, "failed");
      assert.match(step.summary ?? "", /^origin refused the push: /, "the step holds the cause alone");
      assert.equal(count(step.summary!, "Publish failed"), 0);
      assert.equal(v.open!.state, "ready");
      assert.deepEqual(v.gates!.why, [], "gates decide Publish: it stays offered");
      assert.deepEqual(items().map((f) => [f.kind, f.detail]), [["release-failed", `v0.2.0: Publish failed: ${step.summary}`]]);
      assert.equal(count(items()[0]!.detail, "Publish failed"), 1);

      // The power's path is the gates too: its retry reaches the push, and fails on it, not on a refusal.
      const again = await t.r.run("release.publish", { project: t.repo.root }, { kind: "project-overseer", id: "po", root: t.repo.root, act: async () => {}, releaseAct: true });
      assert.match(again.error?.message ?? "", /^Publish failed, nothing changed: origin refused the push: /);
      assert.deepEqual(items().map((f) => f.kind), ["release-failed"], "a retry that fails still gives one");
      assert.equal(count(items()[0]!.detail, "Publish failed"), 1);

      mendOrigin(t);
      const done = await t.call("release.publish", { confirm: true });
      assert.equal(done.ok, true, JSON.stringify(done.error));
      assert.deepEqual(items(), [], "published: nothing left to act on");
      assert.equal(sh(t.repo.origin, "rev-parse", "v0.2.0^{commit}"), rec.commit ?? t.repo.head());
    } finally {
      await t.done();
    }
  });

  test("Retry Step on Publish clears the failure: ready again, one release-ready item; every other failed or held step still shows beside ready", async () => {
    const t = releaseKit();
    try {
      const rec = await ready(t);
      const items = () => t.r.attentionFacts().filter((f) => f.release === rec.id).map((f) => f.kind);
      breakOrigin(t);
      await t.call("release.publish", { confirm: true });
      assert.deepEqual(items(), ["release-failed"]);
      assert.equal((await t.call("release.retry", { step: "publish" })).ok, true);
      assert.deepEqual(items(), ["release-ready"]);
      const open = t.r.openRecord(t.repo.root)!;
      open.steps.find((s) => s.id === "page")!.state = "failed";
      (t.r as unknown as { save(r: unknown): void }).save(open);
      assert.deepEqual(items().sort(), ["release-failed", "release-ready"], "only a failed Publish replaces ready");
    } finally {
      await t.done();
    }
  });
});

describe("a tag-only release (q4, commit: false)", () => {
  test("the queue still holds; the gating checks run on the frozen tip itself (nothing merged, master never moves), then ready; Publish tags that commit", async () => {
    const manifest = { v: 1, steps: [{ id: "version", label: "V", phase: "prepare" }, { id: "notes", label: "N", phase: "prepare" }] };
    const t = releaseKit({ manifest, settings: { commit: false } });
    try {
      const base = t.repo.head();
      const s = await t.call("release.start", {});
      const rec = s.release!.release!;
      assert.equal(rec.commit, base, "a tag-only release is of the tip at start");
      assert.equal((await t.k.q()).releaseHold()?.id, rec.id, "the queue holds for it too");
      await t.call("release.step", { step: "version", state: "done", summary: "v", facts: ["version=0.2.0"] }, t.chat);
      await t.call("release.notes", { text: "Notes." }, t.chat);
      await t.call("release.step", { step: "notes", state: "done", summary: "n" }, t.chat);
      await until(() => t.r.record(t.repo.root, rec.id)!.state === "ready", "ready");
      const input = t.k.run.inputs.find((i) => i.entry.release === rec.id)!;
      assert.equal(input.tryOnly, true, "a check-only run on the frozen tip");
      assert.deepEqual(input.releaseChecks?.map((c) => c.id), ["full"]);
      assert.equal(t.repo.head(), base, "master never moved");
      assert.equal(t.r.record(t.repo.root, rec.id)!.commit, base);
      const p = await t.call("release.publish", { confirm: true });
      assert.equal(p.ok, true, JSON.stringify(p.error));
      assert.equal(sh(t.repo.origin, "rev-parse", "v0.2.0^{commit}"), base);
      assert.equal(sh(t.repo.origin, "rev-parse", "master"), base);
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
      // The notes step still waits: the commit report is refused, and nothing is queued.
      const co = rec.thread!.checkout!;
      writeFileSync(join(co, "VERSION"), "0.2.0\n");
      sh(co, "commit", "-qam", "Release v0.2.0");
      const early = await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sh(co, "rev-parse", "HEAD")}`] }, t.chat);
      assert.equal(early.error?.code, "release-refused");
      assert.match(early.error!.message, /^report notes \(Draft the notes\) done or skipped before the release commit/);
      assert.equal(t.r.openRecord(t.repo.root)!.entry, null, "no release entry");
      assert.equal(t.r.openRecord(t.repo.root)!.steps.find((x) => x.id === "commit")!.state, "waiting", "the commit step is untouched");
      await t.call("release.step", { step: "notes", state: "skipped", summary: "none" }, t.chat);
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
      const pa = await t.r.run("release.request", { why: "the owner wants the new version out" }, { kind: "assistant", id: "project-assistant", root: t.repo.root });
      assert.equal(pa.ok, true, JSON.stringify(pa.error));
      assert.ok(t.r.attentionFacts().some((f) => f.kind === "release-request" && /^The Project Assistant asks you to release: the owner wants/.test(f.detail)));
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

describe("the operator's Release Note and an agent's ask reach the release chat", () => {
  const sections = (text: string) => text.split("\n\n");

  test("release.note saves, trims, replaces and clears the project's note, with or without a release open; past 4000 characters is refused", async () => {
    const t = releaseKit();
    try {
      assert.equal((await t.call("release.status", {})).release!.view!.note, null);
      const a = await t.call("release.note", { text: "  skip docs  " });
      assert.equal(a.ok, true, JSON.stringify(a.error));
      assert.equal(a.changed, true);
      assert.equal(a.release!.view!.note!.text, "skip docs");
      assert.ok(Date.parse(a.release!.view!.note!.at) > 0);
      assert.equal((await t.call("release.note", { text: "skip docs" })).changed, false);
      const long = await t.call("release.note", { text: "x".repeat(4001) });
      assert.equal(long.error?.code, "invalid-request");
      assert.equal((await t.call("release.status", {})).release!.view!.note!.text, "skip docs", "a refused note leaves the saved one");
      assert.equal((await t.call("release.note", {})).error?.code, "invalid-request");
      // A fresh Releaser on the same state reads it (persisted, not in memory).
      const again = new Releaser({ dir: join(t.repo.state, "release"), queue: () => t.k.q(), rootOf: async () => t.repo.root, definitionAt: async () => ({ def: t.def, error: null }), thread: { start: async () => ({ error: "unused" }), wake: async () => ({ ok: true }) }, log: () => {} });
      assert.equal(again.savedNote(t.repo.root)!.text, "skip docs");
      assert.equal((await t.call("release.note", { text: "   " })).release!.view!.note, null);
      // The release chat and the agents never write it.
      assert.equal((await t.call("release.note", { text: "x" }, t.chat)).error?.code, "forbidden");
      assert.equal((await t.r.run("release.note", { text: "x" }, { kind: "assistant", id: "project-assistant", root: t.repo.root })).error?.code, "forbidden");
      // With a release open, it is kept for the next start.
      assert.equal((await t.call("release.start", {})).ok, true);
      assert.equal((await t.call("release.note", { text: "release as 0.10.1" })).ok, true);
      assert.equal((await t.r.view(t.repo.root)).note!.text, "release as 0.10.1");
    } finally {
      await t.done();
    }
  });

  test("a release-power start (not the operator's) sends the saved note as the first message's final --- section, keeps a copy on the record and clears it", async () => {
    const t = releaseKit();
    try {
      assert.equal((await t.call("release.note", { text: "release as 0.10.1\nonly the install page" })).ok, true);
      const s = await t.r.run("release.start", { project: t.repo.root }, { kind: "assistant", id: "pa", root: t.repo.root, releaseAct: true } as Caller);
      assert.equal(s.ok, true, JSON.stringify(s.error));
      const first = t.starts.at(-1)!.text;
      assert.ok(first.endsWith("\n\n---\nrelease as 0.10.1\nonly the install page"), first.slice(-200));
      assert.equal(s.release!.release!.note, "release as 0.10.1\nonly the install page");
      assert.equal(s.release!.release!.startedBy, "power");
      assert.equal(t.r.record(t.repo.root, s.release!.release!.id)!.note, "release as 0.10.1\nonly the install page");
      assert.equal(s.release!.view!.note, null);
      assert.equal((await t.r.view(t.repo.root)).note, null);
    } finally {
      await t.done();
    }
  });

  test("a start whose chat fails to start keeps the note and the pending ask for the next start", async () => {
    const t = releaseKit();
    try {
      assert.equal((await t.call("release.note", { text: "skip docs" })).ok, true);
      const po: Caller = { kind: "project-overseer", id: "po", root: t.repo.root, act: async () => {} };
      assert.equal((await t.r.run("release.request", { why: "lots landed" }, po)).ok, true);
      t.failNextStart("no model");
      const s = await t.call("release.start", {});
      assert.equal(s.error?.code, "start-failed");
      assert.equal((await t.r.view(t.repo.root)).note!.text, "skip docs");
      assert.equal(t.r.requests().filter((q) => q.project === t.repo.root).length, 1);
      const again = await t.call("release.start", {});
      assert.equal(again.ok, true, JSON.stringify(again.error));
      assert.ok(t.starts.at(-1)!.text.endsWith("---\nskip docs"));
      assert.equal((await t.r.view(t.repo.root)).note, null);
      assert.equal(t.r.requests().length, 0);
    } finally {
      await t.done();
    }
  });

  test("a pending ask goes to the chat in its own labelled section (never after ---), is consumed and kept on the record; a dismissed one never reaches the chat", async () => {
    const t = releaseKit();
    try {
      const po: Caller = { kind: "project-overseer", id: "po", root: t.repo.root, act: async () => {} };
      // Asked, dismissed, then started: the chat never hears it.
      assert.equal((await t.r.run("release.request", { why: "release as 9.0.0" }, po)).ok, true);
      assert.equal((await t.call("release.request", { dismiss: true })).ok, true);
      const s = await t.call("release.start", {});
      assert.equal(s.ok, true, JSON.stringify(s.error));
      assert.ok(!t.starts.at(-1)!.text.includes("9.0.0"), "a dismissed ask is not passed on");
      assert.equal(s.release!.release!.asked, undefined);
      assert.equal(s.release!.release!.note, undefined);
      assert.ok(!sections(t.starts.at(-1)!.text).includes("---") && !/\n---\n/.test(t.starts.at(-1)!.text), "no note, no --- section");
      assert.equal((await t.call("release.abandon", { why: "again", confirm: true })).ok, true);
      // Asked by the assistant (a new ask replaces the overseer's) with a note saved: the ask is its own section before the note.
      assert.equal((await t.r.run("release.request", { why: "the earlier one" }, po)).ok, true);
      assert.equal((await t.r.run("release.request", { why: "release as 9.0.0" }, { kind: "assistant", id: "project-assistant", root: t.repo.root })).ok, true);
      assert.equal((await t.call("release.note", { text: "skip docs" })).ok, true);
      const s2 = await t.call("release.start", {});
      assert.equal(s2.ok, true, JSON.stringify(s2.error));
      const text = t.starts.at(-1)!.text;
      assert.ok(!text.includes("the earlier one"), "the replaced ask is gone");
      const parts = sections(text);
      const ask = parts.findIndex((p) => p.startsWith("Asked by the Project Assistant: release as 9.0.0"));
      assert.ok(ask >= 0, text);
      assert.match(parts[ask]!, /not the operator's word: it never picks the version, never skips or narrows a step/);
      assert.equal(parts.at(-1), "---\nskip docs");
      assert.ok(text.lastIndexOf("9.0.0") < text.lastIndexOf("\n---\n"), "the ask is never part of the operator's --- section");
      assert.deepEqual(s2.release!.release!.asked, { by: "assistant:project-assistant", why: "release as 9.0.0" });
      assert.equal(t.r.requests().length, 0);
      assert.equal(t.r.attentionFacts().filter((f) => f.kind === "release-request").length, 0);
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

describe("a releases-only deploy target (q2's opt-in)", () => {
  test("plans only a published numbered release's commit: not an untagged commit, not one only a channel points at, not a withdrawn release", async () => {
    const { releaseCheck } = await import("./deploy");
    const { realGit } = await import("./engine");
    const repo = makeRepo({ prefix: "release-unit-" });
    try {
      const c1 = repo.head();
      sh(repo.root, "tag", "-a", "v1.0.0", "-m", "one");
      sh(repo.root, "commit", "-q", "--allow-empty", "-m", "two");
      const c2 = repo.head();
      sh(repo.root, "tag", "-a", "stable", "-m", "s");
      assert.equal((await releaseCheck(realGit, repo.root, c1, RELEASE)).ok, true);
      const plain = await releaseCheck(realGit, repo.root, c2, RELEASE);
      assert.equal(plain.ok, false);
      assert.equal(plain.detail, `${c2.slice(0, 7)} isn't a numbered release (no tag such as v1.0.0 at it): deploy a release instead (the latest is v1.0.0)`);
      assert.ok(!plain.detail.includes("${"), "never the raw pattern");
      sh(repo.root, "tag", "-a", "withdrawn/v1.0.0", "-m", "bad", c1);
      const w = await releaseCheck(realGit, repo.root, c1, RELEASE);
      assert.equal(w.ok, false);
      assert.equal(w.detail, `v1.0.0 at ${c1.slice(0, 7)} was withdrawn: deploy a release instead`);
      assert.equal((await releaseCheck(realGit, repo.root, c1, { ...RELEASE, tag: "release-${version}" })).ok, false, "the section's pattern decides");
    } finally {
      repo.done();
    }
  });
});

describe("a queue event lost to a stop", () => {
  test("release.status applies the release entry's landing from the queue itself", async () => {
    const t = releaseKit();
    try {
      const { rec, sha } = await prepared(t);
      // The releaser is deaf while the entry lands (as when the queue recovers a landing before the releaser is wired).
      const onQueueEvent = t.r.onQueueEvent.bind(t.r);
      t.r.onQueueEvent = () => {};
      await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sha}`] }, t.chat);
      const entry = t.r.record(t.repo.root, rec.id)!.entry!;
      await landedState(t.k, entry);
      assert.notEqual(t.r.record(t.repo.root, rec.id)!.steps.find((s) => s.id === "checks")!.state, "done");
      t.r.onQueueEvent = onQueueEvent;
      const s = await t.call("release.status", {});
      assert.equal(s.changed, true);
      assert.equal(s.release!.view!.open!.state, "ready");
      assert.equal(s.release!.view!.open!.commit, t.repo.head());
    } finally {
      await t.done();
    }
  });
});

describe("master's how-it-lands, settings saves and local-main updates against the freeze", () => {
  test("Save Checks (merge.setup) never moves the frozen target: refused while a release is open", async () => {
    const t = releaseKit();
    try {
      const base = t.repo.head();
      await t.call("release.start", {});
      const q = await t.k.q();
      await assert.rejects(q.setup({ command: "true" }), (e: unknown) => e instanceof MergeFailure && e.code === "invalid-request" && /^master stays on the release commit while a release is open: save the checks after Publish or Abandon$/.test(e.message));
      assert.equal(t.repo.head(), base);
    } finally {
      await t.done();
    }
  });

  test("this computer's how-it-lands can't be cleared while a release is open: the override stays; after Abandon it can", async () => {
    const t = releaseKit();
    try {
      const q = await t.k.q();
      await q.setLandHow("local", "computer");
      const dir = join(t.repo.state, "merge-queue", projectKey(t.repo.root));
      await t.call("release.start", {});
      await assert.rejects(q.clearLandHowOverride(), (e: unknown) => e instanceof MergeFailure && e.code === "invalid-request" && /^how it lands can't change while a release is open: change it after Publish or Abandon$/.test(e.message));
      assert.equal(readOverride(dir)?.how, "local", "the override stays");
      assert.equal((await t.call("release.abandon", { confirm: true, why: "not now" })).ok, true);
      await q.clearLandHowOverride();
      assert.equal(readOverride(dir), null);
    } finally {
      await t.done();
    }
  });

  test("a waiting save names the release holding it, in the result and the settings; one already waiting on a branch reads as the release too; it drops when the hold lifts", async () => {
    assert.equal(settingsWaitingWords("release v0.4.0"), "Saves once release v0.4.0 is published or abandoned");
    assert.equal(settingsWaitingWords(), SETTINGS_WAITING_WORDS);
    assert.equal(settingsWaitingClause("release v0.4.0"), "once release v0.4.0 is published or abandoned");
    assert.equal(settingsWaitingClause(), "when the current branch finishes");
    const t = releaseKit();
    try {
      const q = await t.k.q();
      // A branch's run holds the target: the save waits on it, with no release to name.
      t.k.run.set((input) => (input.entry.branch === "feat/b" ? untilAborted(input) : {}));
      t.repo.branch("feat/b", { "b.txt": "b\n" });
      await q.add({ branch: "feat/b", by: "land-button" });
      await until(() => q.currentRun(), "B checking");
      const first = await q.saveSettings({ push: false });
      assert.deepEqual(first, { state: "waiting" });
      assert.equal((await q.settings()).pendingSave?.release, undefined);
      // The release opens: the same save now reads as the release, at once (no stale cached settings).
      const { rec } = await prepared(t);
      await until(() => !q.currentRun(), "B voided");
      assert.equal((await q.settings()).pendingSave?.release, "release v0.2.0");
      const second = await q.saveSettings({ push: false });
      assert.deepEqual(second, { state: "waiting", release: "release v0.2.0" });
      assert.equal((await t.call("release.abandon", { release: rec.id, confirm: true, why: "not now" })).ok, true);
      await until(async () => !(await q.settings()).pendingSave, "the save made");
    } finally {
      await t.done();
    }
  });

  test("no id reaches a screen: before a version is picked a release reads as the open release, then by its tag", async () => {
    const t = releaseKit();
    try {
      const q = await t.k.q();
      await t.call("release.start", {});
      assert.deepEqual(await q.saveSettings({ push: false }), { state: "waiting", release: "the open release" });
      assert.equal((await q.settings()).pendingSave?.release, "the open release");
      assert.equal(settingsWaitingWords("the open release"), "Saves once the open release is published or abandoned");
      // Every sentence the hold says before a version is picked, with no rl_ id in any.
      t.repo.branch("feat/b", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/b", by: "land-button" });
      const said: string[] = [await until(async () => (await t.k.entry(entry.id)).reason, "B's waiting words")];
      for (const go of [() => q.updateLocalMain(), () => q.setLandHow("local", "computer"), () => q.setup({ command: "true" })]) await go().then(() => assert.fail("refused"), (e: Error) => said.push(e.message));
      said.push(((await t.call("release.start", {})).error?.message) ?? "");
      said.push(readFileSync(join(t.repo.state, "merge-queue", projectKey(t.repo.root), "push-hold"), "utf8").trim());
      const open = t.r.openRecord(t.repo.root)!;
      open.steps[0]!.state = "failed";
      (t.r as unknown as { save(r: unknown): void }).save(open);
      said.push(...t.r.attentionFacts().map((f) => f.detail));
      await q.publishRelease({ release: "rl_someother1", tag: "v9.9.9", channels: [], commit: t.repo.head(), notes: "n" }).then(() => assert.fail("refused"), (e: Error) => said.push(e.message));
      assert.equal(said.pop(), "that release doesn't hold this queue");
      assert.equal(said.length, 7, JSON.stringify(said));
      for (const line of said) assert.doesNotMatch(line, /rl_/, line);
      assert.equal(said[0], "waits for the open release to be published or abandoned");
      assert.equal(said[1], "master stays on the release commit while a release is open: update it after Publish or Abandon");
      assert.match(said[6]!, /^The open release: Pick the version failed/);
      assert.equal(said[4], "a release is already open (preparing)");
      assert.equal(said[5], "a release is open: nothing is pushed until it is published or abandoned");
      await t.call("release.step", { step: "version", state: "done", summary: "v", facts: ["version=0.2.0"] }, t.chat);
      assert.equal((await q.settings()).pendingSave?.release, "release v0.2.0");
    } finally {
      await t.done();
    }
  });

  test("abandoning names the release by its tag, in the revert commit and to its chat, and an unnamed one with no id", async () => {
    const t = releaseKit();
    try {
      const rec = await ready(t);
      assert.equal((await t.call("release.abandon", { release: rec.id, confirm: true, why: "not now" })).ok, true);
      assert.equal(sh(t.repo.root, "log", "-1", "--format=%s", (await t.k.entry(t.r.record(t.repo.root, rec.id)!.abandoned!.revert!)).commit), "Revert release v0.2.0 (abandoned)");
      assert.ok(t.wakes.some((w) => /^The operator abandoned release v0\.2\.0: not now\./.test(w.text)), JSON.stringify(t.wakes.map((w) => w.text)));
    } finally {
      await t.done();
    }
    const u = releaseKit();
    try {
      await u.call("release.start", {});
      await u.call("release.abandon", { confirm: true, why: "no" });
      const w = u.wakes.find((x) => /abandoned/.test(x.text))!;
      assert.equal(w.text, "The operator abandoned this release: no. Stop; do nothing more for it.");
    } finally {
      await u.done();
    }
  });

  test("Publish is refused for a project that lands by request or by pushing a branch: nothing tagged, nothing pushed, the hold kept", async () => {
    for (const how of ["github-pr", "push-branch"] as const) {
      const t = releaseKit();
      try {
        const rec = await ready(t);
        const before = sh(t.repo.origin, "rev-parse", "master");
        // The verbs can't change it now: the state a hand edit, or an older server's override, leaves.
        writeOverride(join(t.repo.state, "merge-queue", projectKey(t.repo.root)), how);
        const p = await t.call("release.publish", { confirm: true });
        assert.equal(p.ok, false, how);
        assert.match(p.error!.message, how === "push-branch" ? /this project lands by pushing a branch, and a release lands its commit on master and pushes it itself: set how it lands to local/ : /this project lands by request, and a release lands its commit on master and pushes it itself: set how it lands to local/);
        assert.equal(tryGit(t.repo.root, "rev-parse", "--verify", "--quiet", "refs/tags/v0.2.0").code === 0, false, "no tag here");
        assert.equal(tryGit(t.repo.origin, "rev-parse", "--verify", "--quiet", "refs/tags/v0.2.0").code === 0, false, "no tag on origin");
        assert.equal(sh(t.repo.origin, "rev-parse", "master"), before, "nothing pushed");
        assert.equal(sh(t.repo.root, "rev-parse", "stable^{commit}"), sh(t.repo.root, "rev-parse", "v0.1.0^{commit}"), "the channel didn't move");
        assert.equal((await t.k.q()).releaseHold()?.id, rec.id, "the hold is kept");
      } finally {
        await t.done();
      }
    }
  });

  test("a project-file how-it-lands change waits while a release is open, and is made after Publish", async () => {
    const t = releaseKit();
    try {
      const rec = await ready(t);
      const q = await t.k.q();
      const R = t.repo.head();
      assert.deepEqual(await q.setLandHow("push-branch", "project"), { state: "waiting", release: "release v0.2.0" });
      assert.equal(t.repo.head(), R, "the frozen target didn't move");
      const p = await t.call("release.publish", { release: rec.id, confirm: true });
      assert.equal(p.ok, true, JSON.stringify(p.error));
      await until(() => t.repo.head() !== R, "the save made after Publish");
      assert.match(sh(t.repo.root, "show", "master:.sova/project.json"), /"land": "push-branch"/);
      assert.equal(sh(t.repo.root, "rev-parse", "v0.2.0^{commit}"), R, "the tag stays on the release commit");
      assert.equal(sh(t.repo.origin, "rev-parse", "master"), R);
    } finally {
      await t.done();
    }
  });

  test("a settings save made while a release is open goes on master after Publish, past the tag", async () => {
    const t = releaseKit();
    try {
      const rec = await ready(t);
      const q = await t.k.q();
      const R = t.repo.head();
      assert.equal((await q.saveSettings({ push: false })).state, "waiting");
      assert.equal((await t.call("release.publish", { release: rec.id, confirm: true })).ok, true);
      await until(() => t.repo.head() !== R, "the save made after Publish");
      assert.match(sh(t.repo.root, "log", "-1", "--format=%s"), /^Merge queue settings/);
      assert.equal(sh(t.repo.root, "rev-parse", "master~1"), R);
      assert.equal((await q.settings()).pendingSave, undefined);
    } finally {
      await t.done();
    }
  });

  test("a settings save waits while a release holds the queue (the target stays at the base) and is made once the hold lifts; Update Local Main and a computer's how-it-lands are refused meanwhile", async () => {
    const t = releaseKit();
    try {
      const base = t.repo.head();
      await t.call("release.start", {});
      const q = await t.k.q();
      const r = await q.saveSettings({ push: false });
      assert.equal(r.state, "waiting");
      assert.equal(t.repo.head(), base, "the save never moves the frozen target");
      await assert.rejects(q.updateLocalMain(), /stays on the release commit while a release is open/);
      await assert.rejects(q.setLandHow("push-branch", "computer"), /can't change while a release is open/);
      // Nothing landed: Abandon lifts the hold at once, and the waiting save is made then.
      assert.equal((await t.call("release.abandon", { confirm: true, why: "not now" })).ok, true);
      await until(() => t.repo.head() !== base, "the save made after the hold lifted");
      assert.match(sh(t.repo.root, "log", "-1", "--format=%s"), /^Merge queue settings/);
    } finally {
      await t.done();
    }
  });

  test("a project that lands by request or by pushing a branch can't start a release: refused with how to change it, nothing frozen", async () => {
    for (const land of ["push-branch", "github-pr"]) {
      const t = releaseKit({ land });
      try {
        const r = await t.call("release.start", {});
        assert.equal(r.ok, false, land);
        assert.match(r.error!.message, /set how it lands to local/);
        assert.equal((await t.k.q()).releaseHold(), null, "no hold");
        assert.equal(t.r.openRecord(t.repo.root), null, "no record");
      } finally {
        await t.done();
      }
    }
  });

  test("the release entry still lands locally under a request-free project, and only it runs while held", async () => {
    const t = releaseKit();
    try {
      const { rec, sha } = await prepared(t);
      const b = t.repo.branch("feat/b", { "b.txt": "b\n" });
      const q = await t.k.q();
      const { entry: eb } = await q.add({ branch: "feat/b", by: "land-button" });
      await t.call("release.step", { step: "commit", state: "done", summary: "c", facts: [`commit=${sha}`] }, t.chat);
      await until(() => t.r.record(t.repo.root, rec.id)!.state === "ready", "ready");
      const e = q.entry(t.r.record(t.repo.root, rec.id)!.entry!)!;
      assert.equal(e.approval.by, "release");
      assert.equal(e.landed?.via, undefined, "landed here, not on a host");
      assert.equal((await t.k.entry(eb.id)).state, "queued");
      assert.ok(!t.k.run.inputs.some((i) => i.commit === b.head), "B never ran while held");
    } finally {
      await t.done();
    }
  });
});
