// The chain al_1 a7 promises, in-process (E2E-PLAN.md S35): a project overseer with both the release power and the
// deploy power, on its own (unattended), starts a release, which its chat prepares to ready; the release act publishes
// after its hold; then the deploy act, after its hold, ships the published release's commit to a stand-in target that
// takes releases only. Behind the overseer's tool: the project statechart's real held acts, a real Releaser and merge
// queue on a real repository with a bare origin (merge-queue/testing/queue-kit), and the server's real Deployer
// (projectEngine's), which reads the project's own .sova/project.json and runs the recipe as a real process. Holds end
// by moving the org clock past them and firing what is due. No model is called. Why in-process: see
// release-power.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import type { Caller } from "./engine";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-rel-chain-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("../orgs");
const po = await import("../project-overseer");
const { disposeAllChats } = await import("../chat-manager");
const { settled } = await import("../workspace-git");
const { hostOf, setOrgClockForTest } = await import("../org-engine");
const { fakeLooks } = await import("../org-test-fixtures");
const { makeKit, makeRepo, sh, tryGit, until } = await import("../merge-queue/testing/queue-kit");
const { Releaser } = await import("./release");
const { setReleaserForTest } = await import("./release-wire");
const { projectEngine } = await import("./routes");
const { deployedAt } = await import("./deploy");

const TARGET = join(root, "deploy-target");
const SHIP = `import { cpSync, mkdirSync, writeFileSync } from "node:fs";
const [dir, commit] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
cpSync("site", dir, { recursive: true });
writeFileSync(dir + "/version", commit + "\\n");
console.log("shipped " + commit);
`;
const DEFINITION = {
  version: 1,
  services: { site: { static: "site", ports: { http: { base: 47_860 } } } },
  merge: {
    checks: [
      { id: "unit", label: "Unit tests", run: ["true"], timeout: 60 },
      { id: "statecharts", label: "Statecharts", run: ["true"], timeout: 60 },
    ],
  },
  release: { playbook: ".sova/playbooks/release", tag: "v${version}", channels: ["stable"], checks: [{ id: "full", label: "Full suite", run: ["true"], timeout: 60 }] },
  deploy: {
    targets: {
      site: {
        about: "Stand-in target: a local folder, releases only.",
        requires: { tests: "none" },
        steps: [{ id: "ship", run: ["node", "ship.mjs", TARGET, "${commit}"] }],
        rollback: "redeploy-previous",
        releases: "only",
      },
    },
  },
};
const MANIFEST = { v: 1, steps: [{ id: "version", label: "Pick the version", phase: "prepare" }, { id: "notes", label: "Draft the notes", phase: "prepare" }, { id: "commit", label: "Make the release commit", phase: "prepare" }] };

const repo = makeRepo({ prefix: "rel-chain-" });
mkdirSync(join(repo.root, ".sova", "playbooks", "release"), { recursive: true });
mkdirSync(join(repo.root, "site"), { recursive: true });
writeFileSync(join(repo.root, ".sova", "project.json"), JSON.stringify(DEFINITION, null, 2) + "\n");
writeFileSync(join(repo.root, ".sova", "playbooks", "release", "release.json"), JSON.stringify(MANIFEST));
writeFileSync(join(repo.root, "site", "index.html"), "<h1>chain</h1>\n");
writeFileSync(join(repo.root, "ship.mjs"), SHIP);
writeFileSync(join(repo.root, "VERSION"), "0.1.0\n");
sh(repo.root, "add", "-A");
sh(repo.root, "commit", "-q", "-m", "release playbook and deploy target");
sh(repo.root, "tag", "-a", "v0.1.0", "-m", "First");
sh(repo.root, "tag", "-a", "stable", "-m", "stable: v0.1.0");
sh(repo.root, "push", "-q", "origin", "master", "v0.1.0", "stable");
sh(repo.root, "fetch", "-q", "origin");
sh(repo.root, "branch", "-q", "--set-upstream-to", "origin/master", "master");
const def = parseDefinition(JSON.stringify(DEFINITION));
const k = makeKit({ repo, deps: { definitionAt: async () => ({ def, error: null }), releaseEvent: (ev) => r.onQueueEvent(ev, ev.root) } });
const r = new Releaser({
  dir: join(repo.state, "release"),
  queue: () => k.q(),
  rootOf: async (p) => (p.startsWith(repo.root) ? repo.root : null),
  definitionAt: async () => ({ def, error: null }),
  // As the server wires it (release-wire.ts): the history's "deployed to" reads the real Deployer's records.
  deployedTo: (root, sha) => deployedAt(root, sha),
  thread: {
    async start() {
      return { id: "s-release", path: join(repo.state, "s-release.jsonl") };
    },
    async wake() {
      return { ok: true };
    },
  },
  log: () => {},
});
setReleaserForTest(r);
const engine = projectEngine();
(engine as unknown as { releaser?: (v: string, b: unknown, c: Caller) => unknown }).releaser = (v, b, c) => r.run(v, b as Record<string, unknown>, c);

const org = await orgs.createOrg({ name: "Chain", dir: join(root, "ws") });
const project = await orgs.addProject(org.id, { name: "Chain", root: repo.root });
await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT", decides: ["hosting"] }); // the brake wants someone active
await po.ensureProjectOverseer(project.id);
fakeLooks(org.id);

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
const overseer = async (params: Record<string, unknown>): Promise<string> => {
  const t = po.toolsForTest(project.id, { attended: false }).find((x) => x.name === "sova_project_verbs");
  assert.ok(t);
  const out = (await t.execute("call-1", params as never, undefined, undefined, undefined as never)) as { content: { text: string }[] };
  return out.content.map((c) => c.text).join("\n");
};
const holds = () => hostOf(org.id).holds().filter((h) => h.projectId === project.id);
/** One hold waits; it ends (the org clock past it, what is due fired). */
async function oneHoldEnds(what: string): Promise<void> {
  const hs = holds();
  assert.equal(hs.length, 1, `${what} waits in one hold: ${JSON.stringify(hs.map((h) => h.what))}`);
  const left = hs[0]!.until - Date.now();
  assert.ok(left > 50_000 && left <= 61_000, `${what}: the waiting period is holdMin (1 min): ${left} ms`);
  setOrgClockForTest(() => hs[0]!.until + 1);
  try {
    await hostOf(org.id).fireDue();
    await hostOf(org.id).idle();
  } finally {
    setOrgClockForTest(null);
  }
  assert.equal(holds().length, 0, `${what}'s hold ended`);
}
const recOf = (id: string) => r.record(repo.root, id)!;
const tagAt = (where: string, t: string) => {
  const g = tryGit(where, "rev-parse", "--verify", "-q", `refs/tags/${t}^{commit}`);
  return g.code === 0 ? g.out : null;
};
const lastDeploy = async () => {
  const st = await engine.run("deploy.status", { project: repo.root, target: "site" }, op);
  return st.deploy?.targets?.[0]?.last ?? null;
};

test("S35: the overseer, on its own with both powers: release, publish after its hold, deploy the release after its hold", { timeout: 240_000 }, async () => {
  await po.patchProjectOverseer(project.id, { powers: { overseer: { release: true, deploy: true } }, holdMin: 1 });

  // Start: held, then the release opens as the power's.
  assert.match(await overseer({ verb: "release.start", why: "landings since v0.1.0" }), /held|waits|cancel/i);
  assert.equal((await call("release.status", {})).release?.view?.open ?? null, null, "nothing opens during the hold");
  await oneHoldEnds("release.start");
  const rec = await until(async () => (await call("release.status", {})).release?.view?.open ?? null, "the release to open", 30_000);
  assert.equal(rec.startedBy, "power");

  // The release chat prepares it (its own session caller), the queue checks it: ready.
  const co = rec.thread!.checkout!;
  assert.equal((await call("release.step", { release: rec.id, step: "version", state: "done", summary: "v0.2.0", facts: ["version=0.2.0"] }, chat)).ok, true);
  assert.equal((await call("release.notes", { release: rec.id, text: "## v0.2.0\n\nThings." }, chat)).ok, true);
  assert.equal((await call("release.step", { release: rec.id, step: "notes", state: "done", summary: "notes" }, chat)).ok, true);
  writeFileSync(join(co, "VERSION"), "0.2.0\n");
  sh(co, "add", "-A");
  sh(co, "commit", "-q", "-m", "Release v0.2.0");
  const c = await call("release.step", { release: rec.id, step: "commit", state: "done", summary: "made", facts: [`commit=${sh(co, "rev-parse", "HEAD")}`, `branch=${rec.thread!.branch}`] }, chat);
  assert.equal(c.ok, true, JSON.stringify(c.error));
  await until(() => recOf(rec.id).state === "ready", "ready", 60_000);

  // Publish: the release act after its hold; one push.
  assert.match(await overseer({ verb: "release.publish", release: rec.id }), /held|waits|cancel/i);
  assert.equal(tagAt(repo.root, "v0.2.0"), null, "no tag during the hold");
  await oneHoldEnds("release.publish");
  await until(() => recOf(rec.id).state === "published", "published", 30_000);
  assert.equal(recOf(rec.id).publish?.by, "power");
  const tagSha = tagAt(repo.root, "v0.2.0")!;
  assert.ok(tagSha);
  assert.equal(tagAt(repo.origin, "v0.2.0"), tagSha, "the numbered tag is on origin");
  assert.equal(sh(repo.origin, "rev-parse", "refs/heads/master"), tagSha);

  // Deploy: the deploy act after its hold ships the release's commit to the releases-only target.
  assert.equal(existsSync(join(TARGET, "version")), false);
  assert.match(await overseer({ verb: "deploy.run", target: "site", commit: tagSha, why: "ship v0.2.0" }), /held|waits|cancel/i);
  assert.equal(await lastDeploy(), null, "nothing deployed during the hold");
  await oneHoldEnds("deploy.run");
  const done = await until(async () => {
    const l = await lastDeploy();
    return l && l.state !== "running" ? l : null;
  }, "the deploy to end", 60_000);
  assert.equal(done.state, "succeeded", JSON.stringify(done));
  assert.equal(done.commit, tagSha, "the deploy record names the published tag's commit");
  assert.match(done.by, /overseer|project/i, `deployed by the overseer's act: ${done.by}`);
  assert.equal(readFileSync(join(TARGET, "version"), "utf8").trim(), tagSha, "the target runs the release");
  const v = (await call("release.status", {})).release!.view!;
  assert.ok(v.history.find((h) => h.tag === "v0.2.0")?.deployedTo.includes("site"), "the Releases history shows where it runs");
});
