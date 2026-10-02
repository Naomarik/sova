// Run: pnpm exec tsx --test server/projects/runtime.test.ts. The software registry through its routes
// (§app/project-runtime): a standalone project's runtime/<p>, read from main's HEAD; approval (the operator's
// only, a stale hash refused); the automatic conformance (the engine's conform stubbed: its own suite is the
// engine's tests); registration and drift. A throwaway PI_CODING_AGENT_DIR and repos in the OS temp dir.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { ProjectRuntimeView } from "../../shared/project-runtime";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-project-runtime-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const { registerProjectRoutes } = await import("./routes");
const { closeAllOrgHosts, hostOf } = await import("../org-engine");
const { projectEngine } = await import("../project-services/routes");
const { engineOf, operatorEnvelopeOf, runtimeSid } = await import("./spaces");
after(() => closeAllOrgHosts());

// The automatic conformance: the engine's own run is its tests' (conform.ts); here it answers a pass or a failure.
let conformAnswer: { pass: boolean; failed?: { id: string; detail: string } } = { pass: true };
const conformCalls: unknown[] = [];
const engine = projectEngine();
const realRun = engine.run.bind(engine);
engine.run = (async (verb: string, body: unknown, caller: never, opts?: never) => {
  if (verb !== "conform") return realRun(verb, body, caller, opts);
  conformCalls.push(body);
  const { observeRuntime } = await import("../project-services/observe");
  const facts = await observeRuntime((body as { project: string }).project);
  const hash = facts.def.state === "present" ? facts.def.hash : "";
  return {
    v: 1,
    verb: "conform",
    ok: conformAnswer.pass,
    conform: {
      suiteVersion: facts.suite,
      defHash: hash,
      ref: "HEAD",
      pass: conformAnswer.pass,
      checks: conformAnswer.failed ? [{ id: conformAnswer.failed.id, ok: false, detail: conformAnswer.failed.detail }] : [{ id: "ready", ok: true, detail: "" }],
      leaks: [],
      confined: false,
      memory: { instances: [{ label: "A", peakBytes: 2_000_000, steadyBytes: 1_000_000, services: [{ name: "site", peakBytes: 2_000_000, steadyBytes: 1_000_000 }] }] },
    },
  } as never;
}) as typeof engine.run;

const app = new Hono();
registerProjectRoutes(app);
const json = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
const commit = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
};

const definition = (port: number) =>
  JSON.stringify({
    version: 1,
    sources: ["index.html"],
    services: { site: { static: ".", ports: { http: { base: port, stride: 1 } }, isolation: { method: "ports", why: "Each copy serves its own files on its own port." } } },
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
/** Effects run after the step: wait until the registry stands where the test expects it. */
async function until(standing: ProjectRuntimeView["standing"], ms = 5000): Promise<ProjectRuntimeView> {
  const t0 = Date.now();
  let v = await read();
  while (v.standing !== standing && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
    v = await read();
  }
  assert.equal(v.standing, standing);
  return v;
}

test("a new project is born with its registry: unregistered while main declares nothing", async () => {
  const host = hostOf(engineOf(pid)!);
  assert.ok(host.configuration(runtimeSid(pid)), "runtime/<p> exists");
  assert.equal(host.data(runtimeSid(pid))?.orgId, undefined, "no organization in it");
  const v = await read();
  assert.equal(v.standing, "unregistered");
  assert.equal(v.playbookState, "idle");
  assert.equal(v.can.approve, null);
  assert.equal(v.can.onboard, true);
});

test("a definition on main waits for the operator's approval; only the operator approves, and only the hash shown", async () => {
  // A definition only in the working tree is not main's.
  writeFileSync(join(root, "dirty.txt"), "x");
  commit(root, { ".sova/project.json": definition(18731) }, "define the site");
  const v = await read();
  assert.equal(v.standing, "awaiting-approval");
  assert.equal(v.def?.state, "present");
  assert.equal(v.can.approve, v.def?.hash);
  assert.deepEqual(v.services.map((s) => [s.name, s.kind, s.scope, s.isolation?.method, s.ports]), [["site", "static", "checkout", "ports", [{ name: "http", port: 18731 }]]]);
  assert.ok(v.feed.some((f) => f.line === `The definition on main (${v.def!.hash!.replace(/^sha256:/, "").slice(0, 12)}) runs here once you approve it.`), JSON.stringify(v.feed));

  const host = hostOf(engineOf(pid)!);
  const overseer = await host.act(runtimeSid(pid), "runtime/approve", { hash: v.def!.hash }, { ...operatorEnvelopeOf(pid), by: "overseer", attended: true } as never);
  assert.equal(overseer.taken, false);
  assert.equal(overseer.refusal?.sentence, "Only the operator approves a definition.");
  assert.equal(overseer.refusal?.status, 403);

  const stale = await app.request(`/api/projects/${pid}/runtime/approve`, json("POST", { hash: "sha256:0000" }));
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { error: string }).error, "The definition changed since it was shown: look again.");
  assert.equal(conformCalls.length, 0, "nothing conforms before approval");
});

test("approval conforms main by itself, and a pass registers it with its memory", async () => {
  const before = await read();
  const ok = await app.request(`/api/projects/${pid}/runtime/approve`, json("POST", { hash: before.def!.hash }));
  assert.equal(ok.status, 200);
  const v = await until("registered");
  assert.equal(conformCalls.length, 1, "one unconfined conformance on main");
  assert.deepEqual(conformCalls[0], { project: root });
  assert.equal(v.registered?.hash, before.def!.hash);
  assert.equal(v.proof?.pass, true);
  assert.deepEqual(v.services[0]!.memory, { peakBytes: 2_000_000, steadyBytes: 1_000_000 });
  assert.equal(v.can.approve, null, "nothing waits");
  const lines = v.feed.map((f) => f.line);
  assert.ok(lines.includes(`You approved the definition ${before.def!.hash!.replace(/^sha256:/, "").slice(0, 12)} on this host.`), JSON.stringify(lines));
  assert.ok(lines.includes("Conformance is running on main."));
  assert.ok(lines[0]!.startsWith("The project's software is registered: 1 service, proven at "), "newest first");
});

test("a source changing on main is drift: stale, naming the path", async () => {
  commit(root, { "index.html": "<p>changed</p>\n" }, "change a source");
  const v = await read();
  assert.equal(v.standing, "stale");
  assert.deepEqual(v.drift, ["index.html"]);
  assert.equal(v.feed[0]!.line, "The project's stack changed since its software was registered (index.html). Run the Project verbs playbook to bring it up to date.");
  assert.equal(conformCalls.length, 1, "drift conforms nothing by itself");
});

test("a new definition is approved and conformed afresh; a failure is failed, and approving again retries", async () => {
  conformAnswer = { pass: false, failed: { id: "ready", detail: "site never listened" } };
  commit(root, { ".sova/project.json": definition(18741) }, "move the port");
  const v = await read();
  assert.equal(v.standing, "awaiting-approval");
  await app.request(`/api/projects/${pid}/runtime/approve`, json("POST", { hash: v.def!.hash }));
  const f = await until("failed");
  assert.equal(f.feed[0]!.line, "Conformance failed on main at ready: site never listened.");
  assert.equal(f.can.approve, f.def!.hash, "approving again is offered");
  conformAnswer = { pass: true };
  await app.request(`/api/projects/${pid}/runtime/approve`, json("POST", { hash: f.def!.hash }));
  const r = await until("registered");
  assert.equal(r.registered?.hash, f.def!.hash);
  assert.equal(conformCalls.length, 3);
});

test("an invalid definition on main is failed with the parser's error", async () => {
  commit(root, { ".sova/project.json": "{\"version\": 1, \"services\": {\"site\": {}}}" }, "break it");
  const v = await read();
  assert.equal(v.standing, "failed");
  assert.equal(v.def?.state, "invalid");
  assert.ok(v.feed[0]!.line.startsWith("The definition on main is invalid: "), v.feed[0]!.line);
  assert.equal(v.can.approve, null, "an invalid definition can't be approved");
});

test("Run Playbook is refused for an archived project, and not offered", async () => {
  const a = await app.request(`/api/projects/${pid}/archive`, json("POST", {}));
  assert.equal(a.status, 200);
  const v = await read();
  assert.equal(v.can.onboard, false);
  const r = await app.request(`/api/projects/${pid}/verbs/onboard`, json("POST", { why: "first time" }));
  assert.equal(r.status, 409);
  assert.match(((await r.json()) as { error: string }).error, /is archived\. Unarchive it first\.$/);
  assert.equal((await read()).playbookState, "idle", "nothing started");
  await app.request(`/api/projects/${pid}/unarchive`, json("POST", {}));
});
