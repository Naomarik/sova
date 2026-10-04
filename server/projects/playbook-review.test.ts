// Run: tsx --test server/projects/playbook-review.test.ts. A verb playbook run that ends proposed
// (§app.project-runtime/review) and its one-gesture finish, Approve & Merge (§app.project-runtime/approve-merge):
// a real repository and worktree, the run's build started through `verbs/onboard` with its setup seeded (no model,
// no session runtime), its turn ended by hand, and a real Merge Branch. A throwaway PI_CODING_AGENT_DIR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { ProjectRuntimeView } from "../../shared/project-runtime";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-playbook-review-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const { registerProjectRoutes } = await import("./routes");
const { closeAllOrgHosts, hostOf } = await import("../org-engine");
const { buildSetupEnded, seedBuildEffectsForTest } = await import("../build-loadout");
const { engineOf, operatorEnvelopeOf, projectSid, buildSid } = await import("./spaces");
const { playbookReviewOf, playbookReviews } = await import("./playbook-review");
const { sessionItems } = await import("../attention");
after(() => closeAllOrgHosts());

const app = new Hono();
registerProjectRoutes(app);
const json = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim();
const commit = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};
const definition = JSON.stringify({
  version: 1,
  sources: ["index.html"],
  services: { site: { static: ".", ports: { http: { base: 18931, stride: 1 } }, isolation: { method: "ports", why: "Each copy serves its own files on its own port." } } },
});

const root = join(tmp, "site");
mkdirSync(root);
git(root, "init", "-q", "-b", "main");
commit(root, { "index.html": "<p>hi</p>\n" }, "init");
const res = await app.request("/api/projects", json("POST", { root }));
assert.equal(res.status, 201);
const pid = ((await res.json()) as { project: { id: string } }).project.id;

const read = async (): Promise<ProjectRuntimeView> => {
  const r = await app.request(`/api/projects/${pid}/runtime`);
  assert.equal(r.status, 200);
  return (await r.json()) as ProjectRuntimeView;
};
async function until(ok: (v: ProjectRuntimeView) => boolean, ms = 5000): Promise<ProjectRuntimeView> {
  const t0 = Date.now();
  let v = await read();
  while (!ok(v) && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
    v = await read();
  }
  assert.ok(ok(v), JSON.stringify({ playbookState: v.playbookState, playbook: v.playbook }));
  return v;
}

// The run: its worktree on its own branch, its session file, its build started by verbs/onboard with setup seeded.
const sessionId = "0199a000-0000-7000-8000-00000000pb01";
const branch = "sova/project-verbs-1a2b3c";
const wt = join(tmp, ".worktrees", "site-project-verbs");
const base = git(root, "rev-parse", "HEAD");
git(root, "worktree", "add", "-q", "-b", branch, wt, "main");
const sessionPath = join(tmp, "run.jsonl");
writeFileSync(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: wt })}\n`);
seedBuildEffectsForTest(sessionId, { path: sessionPath, worktreePath: wt, made: { branch, base, target: "main" } });

const host = hostOf(engineOf(pid)!);
const bsid = buildSid(pid, sessionId);
const SYSTEM = { by: "system" } as never;

test("a run that ends with commits is proposed: a playbook-review item on its session, worded by what waits", async () => {
  const out = await host.act(projectSid(pid), "verbs/onboard", { sessionId, title: "Project verbs: site", prompt: "Run it", mode: { mode: "normal", minorModes: [] } }, operatorEnvelopeOf(pid), { settle: true });
  assert.equal(out.taken, true, JSON.stringify(out.refusal));
  await buildSetupEnded(pid, bsid);
  assert.equal((await read()).playbookState, "running");
  await host.act(bsid, "turn/started", {}, SYSTEM);
  commit(wt, { ".sova/project.json": definition }, "Project verbs");
  await read(); // the registry's read probes the run's branch: it has commits now
  assert.equal(playbookReviewOf(pid), null, "nothing waits while it works");
  await host.act(bsid, "turn/ended", {}, SYSTEM);
  const v = await until((x) => x.playbookState === "proposed" && !!x.playbook?.branchHash);
  const fact = playbookReviewOf(pid)!;
  assert.deepEqual({ ...fact, since: 0 }, { projectId: pid, sessionId, path: sessionPath, label: "Project verbs", branch, target: "main", hash: v.playbook!.branchHash, approved: false, since: 0 });
  assert.ok(fact.since > 0, "dated by its last turn's end");
  assert.equal(playbookReviews().get(sessionPath)?.sessionId, sessionId, "keyed by its session file for the digest");
  const summary = { id: sessionId, path: sessionPath, cwd: wt, title: "Project verbs: site", createdAt: "", lastActiveAt: new Date().toISOString(), model: "a/b", live: null, busy: false, origin: "web", archived: false } as never;
  const items = sessionItems({ summary, dialogs: [], queued: 0, failedWorkers: 0, activitySince: 0, playbook: fact }, Date.now());
  const it = items.find((i) => i.kind === "playbook-review");
  assert.equal(it?.tier, "act");
  assert.equal(it?.detail, `Project verbs: approve ${v.playbook!.branchHash!.replace(/^sha256:/, "").slice(0, 12)} and merge into main`);
});

test("Approve & Merge refuses a hash that is not the one proposed, approving nothing", async () => {
  const r = await app.request(`/api/projects/${pid}/runtime/approve-merge`, json("POST", { hash: "sha256:00000000" }));
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, "The definition changed since it was shown: look again.");
  const v = await read();
  assert.equal(v.playbook?.branchApproved, false);
  assert.equal(v.playbookState, "proposed");
});

test("a refused merge keeps the approval and says why; the item stays, now asking only for the merge", async () => {
  const v = await read();
  const hash = v.playbook!.branchHash!;
  writeFileSync(join(root, "index.html"), "<p>edited by hand</p>\n"); // main's checkout has tracked changes
  const r = await app.request(`/api/projects/${pid}/runtime/approve-merge`, json("POST", { hash }));
  assert.equal(r.status, 409);
  const body = (await r.json()) as { error: string; approved: string };
  assert.match(body.error, new RegExp(`^Approved ${hash.replace(/^sha256:/, "").slice(0, 12)}, but the merge was refused: `));
  assert.equal(body.approved, hash);
  const after = await until((x) => x.playbook?.branchApproved === true);
  assert.equal(after.playbookState, "proposed", "still waits: nothing was merged");
  assert.equal(playbookReviewOf(pid)?.approved, true);
  git(root, "checkout", "--", "index.html");
});

test("Approve & Merge with the approval in place merges: the run is idle, merged, and nothing waits", async () => {
  const hash = (await read()).playbook!.branchHash!;
  const r = await app.request(`/api/projects/${pid}/runtime/approve-merge`, json("POST", { hash }));
  assert.equal(r.status, 200, await r.clone().text());
  const v = await until((x) => x.playbookState === "idle");
  assert.equal(v.playbook?.result, "merged");
  assert.equal(git(root, "show", "HEAD:.sova/project.json"), definition, "main has the branch's definition");
  assert.equal(playbookReviewOf(pid), null);
  const again = await app.request(`/api/projects/${pid}/runtime/approve-merge`, json("POST", { hash }));
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { error: string }).error, "No playbook run is waiting for approval.");
});
