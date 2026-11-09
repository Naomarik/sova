import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-design-verbs-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { ProjectEngine } = await import("./engine");
const { FakeHost } = await import("./fake-host");
after(() => rmSync(agentDir, { recursive: true, force: true }));

function project(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)));
  mkdirSync(join(root, ".sova"), { recursive: true });
  writeFileSync(join(root, ".sova", "project.json"), JSON.stringify({ version: 1, services: { web: { cmd: ["node", "-e", "0"], ports: { http: {} } } } }));
  after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const coord = (granted?: true) => ({ kind: "design-coordinator" as const, id: "chat-1", ...(granted ? { granted } : {}) });
const code = (r: { error?: { code: string } | null }) => r.error?.code ?? null;

function engine() {
  const host = new FakeHost();
  return new ProjectEngine(host.deps());
}

test("a coordinator reads any project's status", async () => {
  const e = engine();
  const r = await e.run("status", { project: project("other") }, coord());
  assert.notEqual(code(r), "forbidden");
});

test("up and down without the user's click are refused, on any project", async () => {
  const e = engine();
  const root = project("other2");
  assert.equal(code(await e.run("up", { project: root, branch: "x" }, coord())), "needs-confirm");
  // A down that names no copy never gets as far as stopping anything.
  assert.notEqual(code(await e.run("down", { project: root }, coord())), null);
});

test("even granted, the main checkout is never started", async () => {
  const e = engine();
  const r = await e.run("up", { project: project("other3") }, coord(true));
  assert.equal(code(r), "forbidden");
});

test("every other verb is refused, deploy, merge and release included", async () => {
  const e = engine();
  const root = project("other4");
  for (const verb of ["teardown", "reset", "apply", "test", "logs", "doctor", "share", "conform", "create", "deploy.run", "deploy.plan", "merge.add", "release.start"]) {
    assert.equal(code(await e.run(verb, { project: root }, coord(true))), "forbidden", verb);
  }
});
