// Run: tsx --test server/projects/playbook-review.integration.test.ts. One story over a real repository: the merge starts the copy's static service on its real port, so the whole file is integration. A verb playbook run that ends proposed
// (§app.project-runtime/review) and its finish, Merge Branch (§app.project-runtime/merge):
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
  assert.equal(playbookReviewOf(pid), null, "nothing waits while it works");
  // Its turn ends as the server hears it (agent_settled), with no read of the page since its commit: the branch is
  // probed then, so the commits count.
  const { noteBuildSettled } = await import("../build-loadout");
  await noteBuildSettled(sessionPath, false);
  const v = await until((x) => x.playbookState === "proposed" && !!x.playbook?.branchHash);
  // The review, read by Sova from the branch's tip (§app.project-runtime/run-report), and the run's strip.
  const r = v.playbook!.review!;
  assert.deepEqual(r.def, { state: "present", hash: v.playbook!.branchHash });
  assert.deepEqual(r.services.map((x) => [x.name, x.kind, x.scope, x.isolation?.method, x.ports]), [["site", "static", "checkout", "ports", [{ name: "http", port: 18931 }]]]);
  assert.deepEqual([r.share, r.open, r.proof], [null, null, null], "no share, no entry point, no conformance yet");
  assert.equal(v.playbook!.live?.working, false);
  const fact = playbookReviewOf(pid)!;
  assert.deepEqual({ ...fact, since: 0 }, { projectId: pid, sessionId, path: sessionPath, label: "Project verbs", branch, target: "main", hash: v.playbook!.branchHash, proposes: "definition", since: 0 });
  assert.ok(fact.since > 0, "dated by its last turn's end");
  assert.equal(playbookReviews().get(sessionPath)?.sessionId, sessionId, "keyed by its session file for the digest");
  const summary = { id: sessionId, path: sessionPath, cwd: wt, title: "Project verbs: site", createdAt: "", lastActiveAt: new Date().toISOString(), model: "a/b", live: null, busy: false, origin: "web", archived: false } as never;
  const items = sessionItems({ summary, dialogs: [], queued: 0, failedWorkers: 0, activitySince: 0, playbook: fact }, Date.now());
  const it = items.find((i) => i.kind === "playbook-review");
  assert.equal(it?.tier, "act");
  assert.equal(it?.detail, `Project verbs: merge ${v.playbook!.branchHash!.replace(/^sha256:/, "").slice(0, 12)} into main`);
});

test("Merge Branch refuses a hash that is not the one proposed, merging nothing", async () => {
  const r = await app.request(`/api/projects/${pid}/runtime/merge`, json("POST", { hash: "sha256:00000000" }));
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, "The definition changed since it was shown: look again.");
  assert.equal((await read()).playbookState, "proposed");
});

test("a refused merge says why; the item stays", async () => {
  const v = await read();
  const hash = v.playbook!.branchHash!;
  writeFileSync(join(root, "index.html"), "<p>edited by hand</p>\n"); // main's checkout has tracked changes
  const r = await app.request(`/api/projects/${pid}/runtime/merge`, json("POST", { hash }));
  assert.equal(r.status, 409);
  const body = (await r.json()) as { error: string };
  assert.match(body.error, /^The merge was refused: /);
  assert.equal((await read()).playbookState, "proposed", "still waits: nothing was merged");
  assert.equal(playbookReviewOf(pid)?.hash, hash);
  git(root, "checkout", "--", "index.html");
});

test("Merge Branch merges: the run is idle, merged, and nothing waits", async () => {
  const hash = (await read()).playbook!.branchHash!;
  const r = await app.request(`/api/projects/${pid}/runtime/merge`, json("POST", { hash }));
  assert.equal(r.status, 200, await r.clone().text());
  const v = await until((x) => x.playbookState === "idle");
  assert.equal(v.playbook?.result, "merged");
  assert.equal(git(root, "show", "HEAD:.sova/project.json"), definition, "main has the branch's definition");
  assert.equal(playbookReviewOf(pid), null);
  const again = await app.request(`/api/projects/${pid}/runtime/merge`, json("POST", { hash }));
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { error: string }).error, "No playbook run is proposed.");
});

test("a run whose turn ends on open alignment questions waits, never proposed, and its answer resumes it (§app.project-runtime/onboard)", async () => {
  const { applyAlignCall } = await import("../../pi-config/extensions/mode/align.ts");
  const { noteBuildSettled } = await import("../build-loadout");
  const sid2 = "0199a000-0000-7000-8000-00000000pb02";
  const branch2 = "sova/project-verbs-4d5e6f";
  const wt2 = join(tmp, ".worktrees", "site-project-verbs-2");
  git(root, "worktree", "add", "-q", "-b", branch2, wt2, "main");
  const path2 = join(tmp, "run2.jsonl");
  const header = { type: "session", version: 3, id: sid2, timestamp: new Date().toISOString(), cwd: wt2 };
  writeFileSync(path2, `${JSON.stringify(header)}\n${JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "Run it" } })}\n`);
  seedBuildEffectsForTest(sid2, { path: path2, worktreePath: wt2, made: { branch: branch2, base: git(root, "rev-parse", "HEAD"), target: "main" } });
  const out = await host.act(projectSid(pid), "verbs/onboard", { sessionId: sid2, title: "Project verbs: site", prompt: "Run it", mode: { mode: "normal", minorModes: ["align"] } }, operatorEnvelopeOf(pid), { settle: true });
  assert.equal(out.taken, true, JSON.stringify(out.refusal));
  const b2 = buildSid(pid, sid2);
  await buildSetupEnded(pid, b2);
  await host.act(b2, "turn/started", {}, SYSTEM);
  commit(wt2, { "index.html": "<p>hi, again</p>\n" }, "Project verbs: a source");
  await read();
  // The run asks which port to keep: an align result with 2 open questions, after the user's last prompt.
  const Q = (topic: string) => ({ topic, ask: `${topic}?`, recommendation: { choice: "a", why: "free" } });
  const { details } = applyAlignCall([], { ops: [{ op: "create", title: "Ports", summary: "Which held port to use.", questions: [Q("Web port"), Q("REPL port")] }] }, { now: new Date().toISOString(), readFile: () => "" });
  const align = { type: "message", id: "r1", parentId: "u1", message: { role: "toolResult", toolCallId: "c1", toolName: "align", content: [{ type: "text", text: "ok" }], details, isError: false } };
  writeFileSync(path2, `${JSON.stringify(header)}\n${JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "Run it" } })}\n${JSON.stringify(align)}\n`);
  await noteBuildSettled(path2, false);
  const v = await until((x) => x.playbookState === "waiting");
  assert.equal(v.playbook?.questions, 2);
  assert.equal(playbookReviewOf(pid), null, "waiting is not proposed: no playbook-review item");
  assert.ok(v.feed.some((f) => f.line === "The Project verbs playbook waits on your answers in its session."), JSON.stringify(v.feed));
  const again = await app.request(`/api/projects/${pid}/verbs/onboard`, json("POST", {}));
  assert.equal(again.status, 409, "a waiting run is live: no second run");
  await host.act(b2, "turn/started", {}, SYSTEM);
  assert.equal((await until((x) => x.playbookState === "running")).playbookState, "running", "the answer resumes it");
  await host.act(b2, "turn/ended", {}, SYSTEM);
  assert.equal((await until((x) => x.playbookState === "proposed")).playbook?.sessionId, sid2, "no questions left: proposed");
});

test("a deploy-setup run proposes its deploy recipe: its own hash and its rendering, then Merge Branch (§app.project-runtime/merge)", async () => {
  // The waiting run above ended proposed: finish it first.
  const prev = await read();
  const done = await app.request(`/api/projects/${pid}/runtime/merge`, json("POST", { hash: prev.playbook!.branchHash }));
  assert.equal(done.status, 200, await done.clone().text());
  await until((x) => x.playbookState === "idle");

  const sid3 = "0199a000-0000-7000-8000-00000000pb03";
  const branch3 = "sova/project-deploy-7a8b9c";
  const wt3 = join(tmp, ".worktrees", "site-project-deploy");
  git(root, "worktree", "add", "-q", "-b", branch3, wt3, "main");
  const path3 = join(tmp, "run3.jsonl");
  writeFileSync(path3, `${JSON.stringify({ type: "session", version: 3, id: sid3, timestamp: new Date().toISOString(), cwd: wt3 })}\n`);
  seedBuildEffectsForTest(sid3, { path: path3, worktreePath: wt3, made: { branch: branch3, base: git(root, "rev-parse", "HEAD"), target: "main" } });
  const out = await host.act(
    projectSid(pid),
    "verbs/onboard",
    { sessionId: sid3, title: "Project deploy: site", prompt: "Run it", mode: { mode: "normal", minorModes: ["align"] }, playbookId: "project-deploy", label: "Project deploy", proposes: "deploy" },
    operatorEnvelopeOf(pid),
    { settle: true },
  );
  assert.equal(out.taken, true, JSON.stringify(out.refusal));
  const b3 = buildSid(pid, sid3);
  await buildSetupEnded(pid, b3);
  await host.act(b3, "turn/started", {}, SYSTEM);
  const withDeploy = JSON.parse(definition);
  withDeploy.deploy = { targets: { staging: { about: "The staging copy.", requires: { tests: "none" }, steps: [{ id: "push", run: ["./bin/push", "${commit}"] }], rollback: { none: "Staging is rebuilt every night." } } } };
  commit(wt3, { ".sova/project.json": JSON.stringify(withDeploy) }, "Project deploy: staging");
  const { noteBuildSettled } = await import("../build-loadout");
  await noteBuildSettled(path3, false);
  const v = await until((x) => x.playbookState === "proposed" && !!x.playbook?.branchHash && !!x.playbook?.review?.deploy);
  const r = v.playbook!.review!.deploy!;
  assert.equal(v.playbook!.proposes, "deploy");
  assert.equal(v.playbook!.branchHash, r.deployHash, "the review's hash is the recipe's, not the definition's");
  assert.deepEqual(r.targets.map((t) => [t.name, t.steps.map((x) => x.key)]), [["staging", ["steps.push"]]], "every step as Sova renders it");
  const fact = playbookReviewOf(pid)!;
  assert.deepEqual([fact.label, fact.proposes, fact.hash], ["Project deploy", "deploy", r.deployHash]);

  const stale = await app.request(`/api/projects/${pid}/runtime/merge`, json("POST", { hash: "sha256:00" }));
  assert.equal(((await stale.json()) as { error: string }).error, "The deploy recipe changed since it was shown: look again.");
  assert.equal((await read()).playbookState, "proposed", "nothing merged");

  const ok = await app.request(`/api/projects/${pid}/runtime/merge`, json("POST", { hash: r.deployHash }));
  assert.equal(ok.status, 200, await ok.clone().text());
  const after = await until((x) => x.playbookState === "idle");
  assert.equal(after.playbook?.result, "merged");
});
