// The release power end to end in-process (E2E-PLAN.md S29, S30, S31; al_1 q3, q12, a12): the project overseer's own
// unattended sova_project_verbs through the project statechart's held release/run act, a real Releaser behind it
// (setReleaserForTest + the engine's releaser hook, as release-run calls projectEngine().run), and a real merge queue
// on a real repository with a bare origin (merge-queue/testing/queue-kit: real git merges, the gating checks' verdict
// scripted). The hold is the project's holdMin; it ends by moving the org clock past it and firing what is due, as
// server/project-overseer-tools-statecharts.integration.test.ts does. No model is called. A full server has no clean
// trigger for an unattended overseer turn (Run Now is attended), so this is the in-process form the lead allowed;
// the release chat's own reporting is proven on a full server in release-publish.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { ProjectDef, ReleaseDecl } from "../../shared/project-contract";
import type { Caller } from "./engine";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-rel-power-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("../orgs");
const po = await import("../project-overseer");
const { registerProjectRoutes } = await import("../projects/routes");
const { disposeAllChats } = await import("../chat-manager");
const { settled } = await import("../workspace-git");
const { holdRef, hostOf, setOrgClockForTest } = await import("../org-engine");
const { fakeLooks } = await import("../org-test-fixtures");
const { DEF, makeKit, makeRepo, sh, tryGit, until } = await import("../merge-queue/testing/queue-kit");
const { Releaser } = await import("./release");
const { setReleaserForTest } = await import("./release-wire");
const { projectEngine } = await import("./routes");

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
const MANIFEST = { v: 1, steps: [{ id: "version", label: "Pick the version", phase: "prepare" }, { id: "notes", label: "Draft the notes", phase: "prepare" }, { id: "commit", label: "Make the release commit", phase: "prepare" }] };

// The project: a real repository with a bare origin, its release playbook's manifest, v0.1.0 and stable, pushed.
const repo = makeRepo({ prefix: "rel-power-" });
mkdirSync(join(repo.root, ".sova", "playbooks", "release"), { recursive: true });
writeFileSync(join(repo.root, ".sova", "playbooks", "release", "release.json"), JSON.stringify(MANIFEST));
writeFileSync(join(repo.root, "VERSION"), "0.1.0\n");
sh(repo.root, "add", "-A");
sh(repo.root, "commit", "-q", "-m", "release playbook");
sh(repo.root, "tag", "-a", "v0.1.0", "-m", "First");
sh(repo.root, "tag", "-a", "stable", "-m", "stable: v0.1.0");
sh(repo.root, "push", "-q", "origin", "master", "v0.1.0", "stable");
const def = { ...DEF, release: RELEASE } as unknown as ProjectDef;
/** Each release chat's first message, in start order. */
const firstMessages: string[] = [];
const k = makeKit({ repo, deps: { definitionAt: async () => ({ def, error: null }), releaseEvent: (ev) => r.onQueueEvent(ev, ev.root) } });
const r = new Releaser({
  dir: join(repo.state, "release"),
  queue: () => k.q(),
  rootOf: async (p) => (p.startsWith(repo.root) ? repo.root : null),
  definitionAt: async () => ({ def, error: null }),
  thread: {
    async start(i) {
      firstMessages.push(i.text);
      return { id: "s-release", path: join(repo.state, "s-release.jsonl") };
    },
    async wake() {
      return { ok: true };
    },
  },
  log: () => {},
});
setReleaserForTest(r);
const engine = projectEngine() as unknown as { releaser?: (v: string, b: unknown, c: Caller) => unknown };
engine.releaser = (v, b, c) => r.run(v, b as Record<string, unknown>, c);

const org = await orgs.createOrg({ name: "Rel", dir: join(root, "ws") });
const project = await orgs.addProject(org.id, { name: "Pub", root: repo.root });
// The org's brake holds every unattended act until the roster has someone active.
await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT", decides: ["hosting"] });
await po.ensureProjectOverseer(project.id);
fakeLooks(org.id);
const app = new Hono();
registerProjectRoutes(app);

after(async () => {
  setReleaserForTest(null);
  await k.done();
  await disposeAllChats();
  await settled(join(root, "ws"));
  repo.done();
});

const op: Caller = { kind: "operator" };
const chat: Caller = { kind: "session", id: "s-release", root: repo.root, own: [] };
const call = (verb: string, body: Record<string, unknown>, caller: Caller = op) => r.run(verb, { project: repo.root, ...body }, caller);
const settings = (patch: Record<string, unknown>) => po.patchProjectOverseer(project.id, patch);
/** The overseer's own tool, unattended (its look, not a turn the operator started). */
const overseer = async (params: Record<string, unknown>): Promise<string> => {
  const t = po.toolsForTest(project.id, { attended: false }).find((x) => x.name === "sova_project_verbs");
  assert.ok(t, "the overseer has sova_project_verbs");
  const out = (await t.execute("call-1", params as never, undefined, undefined, undefined as never)) as { content: { text: string }[] };
  return out.content.map((c) => c.text).join("\n");
};
const holds = () => hostOf(org.id).holds().filter((h) => h.projectId === project.id);
/** Let every hold of the project end: the org clock past its end, then what is due fires. */
async function holdEnds(): Promise<void> {
  const end = Math.max(...holds().map((h) => h.until));
  setOrgClockForTest(() => end + 1);
  try {
    await hostOf(org.id).fireDue();
    await hostOf(org.id).idle();
  } finally {
    setOrgClockForTest(null);
  }
}
const open = async () => (await call("release.status", {})).release?.view?.open ?? null;
const recOf = (id: string) => r.record(repo.root, id)!;
const tagAt = (t: string) => {
  const g = tryGit(repo.root, "rev-parse", "--verify", "-q", `refs/tags/${t}^{commit}`);
  return g.code === 0 ? g.out : null;
};
const originTag = (t: string) => {
  const g = tryGit(repo.origin, "rev-parse", "--verify", "-q", `refs/tags/${t}^{commit}`);
  return g.code === 0 ? g.out : null;
};

/** The release chat's prepare steps (as its own session caller) and its commit in the release worktree. */
async function prepare(id: string, version: string): Promise<void> {
  const rec = recOf(id);
  const co = rec.thread!.checkout!;
  for (const [step, extra] of [["version", { facts: [`version=${version}`] }], ["notes", {}]] as const) {
    if (step === "notes") assert.equal((await call("release.notes", { release: id, text: `## v${version}\n\nThings.` }, chat)).ok, true);
    const s = await call("release.step", { release: id, step, state: "done", summary: step, ...extra }, chat);
    assert.equal(s.ok, true, JSON.stringify(s.error));
  }
  writeFileSync(join(co, "VERSION"), `${version}\n`);
  sh(co, "add", "-A");
  sh(co, "commit", "-q", "-m", `Release v${version}`);
  const c = await call("release.step", { release: id, step: "commit", state: "done", summary: "made", facts: [`commit=${sh(co, "rev-parse", "HEAD")}`, `branch=${rec.thread!.branch}`] }, chat);
  assert.equal(c.ok, true, JSON.stringify(c.error));
}
const checksEnd = (id: string) => until(() => ["done", "failed"].includes(recOf(id).steps.find((s) => s.id === "checks")!.state), `${id} checks to end`, 60_000);

describe("the release power (q12): start and publish after the waiting period, cancellable, never past a failed check", () => {
  test("S31a: with the power Off the overseer's start is refused and nothing is held", async () => {
    await settings({ powers: { overseer: { release: false } }, holdMin: 1 });
    await assert.rejects(() => overseer({ verb: "release.start", why: "lots landed" }), /is off for the overseer on its own/);
    assert.equal(holds().length, 0);
    assert.equal(await open(), null);
  });

  test("S29: On, unattended: start waits its hold, then opens; publish of a ready release waits its hold, then publishes in one push", async () => {
    await settings({ powers: { overseer: { release: true } }, holdMin: 1 });
    // The operator's Release Note, saved through the engine as the tab's route does; the power's start sends it.
    const saved = (await projectEngine().run("release.note", { project: repo.root, text: "release as 0.2.0" }, op)) as { ok: boolean; release?: { view?: { note: { text: string } | null } } };
    assert.equal(saved.ok, true);
    assert.equal(saved.release?.view?.note?.text, "release as 0.2.0");
    const said = await overseer({ verb: "release.start", why: "lots landed" });
    assert.match(said, /held|waits|cancel/i, said);
    assert.equal(holds().length, 1, "the start waits in a hold");
    assert.equal(await open(), null, "nothing opened during the hold");
    const h = holds()[0]!;
    assert.ok(h.until - Date.now() > 50_000 && h.until - Date.now() <= 61_000, `the waiting period is the project's holdMin (1 min): ${h.until - Date.now()} ms`);
    await holdEnds();
    const rec = await until(() => open(), "the power's release to open", 30_000);
    assert.equal(rec.startedBy, "power");
    assert.equal(holds().length, 0);
    assert.ok(firstMessages.at(-1)!.endsWith("\n\n---\nrelease as 0.2.0"), "the power's start sends the operator's note last, after ---");
    assert.equal(recOf(rec.id).note, "release as 0.2.0");
    assert.equal((await call("release.status", {})).release!.view!.note, null, "the note is consumed by the start that sent it");
    assert.equal((await r.run("release.note", { project: repo.root, text: "x" }, { kind: "project-overseer", id: "po", root: repo.root, act: async () => {}, releaseAct: true } as Caller)).error?.code, "forbidden", "never the overseer's");

    await prepare(rec.id, "0.2.0");
    await checksEnd(rec.id);
    await until(() => recOf(rec.id).state === "ready", "ready", 30_000);
    const releaseTip = repo.head("master");

    const pub = await overseer({ verb: "release.publish", release: rec.id });
    assert.match(pub, /held|waits|cancel/i, pub);
    assert.equal(holds().length, 1, "Publish waits in a hold");
    const power = recOf(rec.id).power;
    assert.ok(power?.heldUntil && power.act, `record.power during the wait: ${JSON.stringify(power)}`);
    assert.equal(power.act, holdRef(holds()[0]!), "record.power.act names the held act");
    assert.equal(tagAt("v0.2.0"), null, "no tag during the wait");
    assert.equal(originTag("v0.2.0"), null);
    await holdEnds();
    await until(() => recOf(rec.id).state === "published", "published by the power", 30_000);
    const done = recOf(rec.id);
    assert.equal(done.publish?.by, "power");
    assert.equal(tagAt("v0.2.0"), releaseTip);
    assert.equal(tagAt("stable"), releaseTip);
    assert.equal(originTag("v0.2.0"), releaseTip, "pushed: the numbered tag");
    assert.equal(originTag("stable"), releaseTip, "pushed: the channel");
    assert.equal(sh(repo.origin, "rev-parse", "refs/heads/master"), releaseTip, "pushed: master");
  });

  test("S30: Cancel in Needs you during Publish's wait stops it; the release stays ready and the operator can still publish", async () => {
    const s = await call("release.start", {});
    assert.equal(s.ok, true, JSON.stringify(s.error));
    const id = s.release!.release!.id;
    await prepare(id, "0.3.0");
    await checksEnd(id);
    await until(() => recOf(id).state === "ready", "ready", 30_000);
    await overseer({ verb: "release.publish", release: id });
    const held = holds();
    assert.equal(held.length, 1);
    const cancel = await app.request(`/api/projects/${project.id}/held/${encodeURIComponent(holdRef(held[0]!))}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(cancel.status, 200, await cancel.text());
    assert.equal(holds().length, 0);
    // Past the cancelled hold's end, with what is due fired: nothing publishes.
    setOrgClockForTest(() => held[0]!.until + 1);
    try {
      await hostOf(org.id).fireDue();
      await hostOf(org.id).idle();
    } finally {
      setOrgClockForTest(null);
    }
    assert.equal(recOf(id).state, "ready");
    assert.equal(tagAt("v0.3.0"), null);
    assert.equal(originTag("v0.3.0"), null);
    const p = await call("release.publish", { release: id, confirm: true });
    assert.equal(p.ok, true, JSON.stringify(p.error));
    await until(() => recOf(id).state === "published", "published by the operator", 30_000);
    assert.equal(recOf(id).publish?.by, "operator");
  });

  test("S31: never past a failed gating check: the power's Publish is refused before any hold, and at the act itself", async () => {
    const s = await call("release.start", {});
    const id = s.release!.release!.id;
    k.run.set((input) => (input.entry.release ? { verdict: "failed", blame: "branch", why: "full failed" } : {}));
    try {
      await prepare(id, "0.4.0");
      await checksEnd(id);
      assert.equal(recOf(id).steps.find((x) => x.id === "checks")!.state, "failed");
      await assert.rejects(() => overseer({ verb: "release.publish", release: id }), /Not ready to publish|gating check failed/i);
      assert.equal(holds().length, 0, "nothing held");
      // The act itself (as the effect calls it after a hold) refuses too: the power never overrides.
      const act = await call("release.publish", { release: id }, { kind: "project-overseer", id: "po", root: repo.root, act: async () => {}, releaseAct: true } as Caller);
      assert.equal(act.error?.code, "release-refused", JSON.stringify(act));
      assert.equal(tagAt("v0.4.0"), null);
      assert.equal(originTag("v0.4.0"), null);
    } finally {
      k.run.set(null);
      await call("release.abandon", { release: id, why: "test over", confirm: true });
    }
  });
});
