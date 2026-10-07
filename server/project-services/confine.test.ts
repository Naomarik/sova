import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { whyExited } from "./confine";
import { ProjectEngine } from "./engine";
import { FakeHost } from "./fake-host";
import { mutateRegistry, readRegistry } from "./store";

/**
 * Confined conformance (§app.project-services/confined) without a sandbox: a run that ended with the
 * server is never started again, on a host in memory (fake-host.ts), and a dead anchor's error line.
 * The real namespaces are in confine.integration.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-confine-agent-"));
after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));

test("after a server start, a unit of a confined run that ended is stopped and marked stopped, never started", async () => {
  const id = "demo-c0ffee00";
  const checkout = mkdtempSync(join(tmpdir(), "sova-confine-ended-"));
  const host = new FakeHost();
  const eng = new ProjectEngine(host.deps());
  mutateRegistry((r) => {
    r.instances.push({ id, project: checkout, checkout, branch: null, slot: 5, generation: 1, createdBy: "conform:x", createdAt: new Date().toISOString(), cutWorktree: false, confined: "0ended0", desired: { web: "running", idle: "running" }, prints: {}, data: {}, ports: {} });
  });
  const unit = eng.unitOf(id, "web");
  await eng.driver.start({ unit, argv: ["sleep", "30"], cwd: checkout, env: { PATH: process.env.PATH! } });
  assert.equal((await eng.driver.status(unit)).state, "active");
  const did = await eng.reconcile();
  assert.ok(did.includes(`${id}: stopped web (its confined conformance run ended)`), did.join("\n"));
  assert.notEqual((await eng.driver.status(unit)).state, "active");
  assert.deepEqual(readRegistry().instances.find((i) => i.id === id)?.desired, { web: "stopped", idle: "stopped" });
  assert.equal((await eng.driver.status(eng.unitOf(id, "idle"))).state, "missing", "nothing was started");
  assert.deepEqual(host.driver.running(), []);
  mutateRegistry((r) => {
    r.instances = r.instances.filter((i) => i.id !== id);
  });
  rmSync(checkout, { recursive: true, force: true });
});

test("a dead anchor is named by its first error line, not Node's stack or version banner", () => {
  const stderr = [
    "node:net:1937",
    "      throw new ErrnoException(err, 'listen');",
    "      ^",
    "",
    "Error: listen EINVAL: invalid argument /very/long/net.sock",
    "    at Server.setupListenHandle [as _listen2] (node:net:1937:21)",
    "    at listenInCluster (node:net:2016:12) {",
    "  errno: -22,",
    "}",
    "",
    "Node.js v25.2.1",
  ].join("\n");
  assert.equal(whyExited(stderr).split("; ")[0], "Error: listen EINVAL: invalid argument /very/long/net.sock");
  assert.doesNotMatch(whyExited(stderr), /Node\.js v|^\s*at /);
  assert.equal(whyExited("bwrap: Can't chdir to /x: No such file or directory\n"), "bwrap: Can't chdir to /x: No such file or directory");
});
