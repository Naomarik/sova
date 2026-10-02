import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import { SUITE_VERSION } from "./conform";
import { approveAtRef, branchFacts, observeRuntime } from "./observe";
import { conformDir } from "./store";
import { defHashOf, isApproved } from "./trust";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-observe-agent-"));

let root = "";
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
const DEF = {
  version: 1,
  services: {
    web: { cmd: ["node", "web.mjs"], ports: { http: { base: 4100, stride: 10 } }, requires: ["redis"], isolation: { method: "ports", why: "Its port is per slot." } },
    redis: { cmd: ["redis-server"], scope: "shared", ports: { main: { fixed: 6375 } }, isolation: { method: "shared", why: "One per project; each instance its own db index." } },
  },
  sources: ["bb.edn", "package.json", ".mise.toml"],
};
const write = (f: string, body: string) => writeFileSync(join(root, f), body);
const commit = (m: string) => {
  git("add", "-A");
  git("commit", "-qm", m);
};

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sova-observe-proj-")));
  git("init", "-q", "-b", "main");
});
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

test("no commit, then no definition: absent; an invalid one names its problem", async () => {
  assert.deepEqual((await observeRuntime(root)).def, { state: "absent" });
  write("README", "x");
  commit("first");
  const f = await observeRuntime(root);
  assert.deepEqual(f.def, { state: "absent" });
  assert.deepEqual(f.software, []);
  assert.equal(f.sources.fingerprint, null);
  mkdirSync(join(root, ".sova"));
  write(".sova/project.json", JSON.stringify({ version: 1, services: {}, sources: ["bb.edn"] }));
  commit("invalid");
  const bad = await observeRuntime(root);
  assert.equal(bad.def.state, "invalid");
  assert.match((bad.def as { error: string }).error, /\$\.services/);
});

test("present: main's HEAD is read, never the working tree; software, sources and their fingerprint", async () => {
  write(".sova/project.json", JSON.stringify(DEF, null, 2));
  write("bb.edn", "{:tasks {}}");
  write("package.json", "{}");
  commit("definition");
  const hash = defHashOf(parseDefinition(JSON.stringify(DEF)));
  // A dirty working tree changes nothing.
  write(".sova/project.json", JSON.stringify({ ...DEF, slots: { cap: 9 } }));
  write("bb.edn", "{:tasks {:dirty 1}}");
  const f = await observeRuntime(root);
  assert.deepEqual(f.def, { state: "present", hash });
  assert.equal(f.commit, git("rev-parse", "HEAD").trim());
  assert.deepEqual(f.software, [
    { name: "web", kind: "process", scope: "checkout", ports: [{ name: "http", port: 4100 }], requires: ["redis"], start: "up", isolation: DEF.services.web.isolation },
    { name: "redis", kind: "process", scope: "shared", ports: [{ name: "main", port: 6375 }], requires: [], start: "up", isolation: DEF.services.redis.isolation },
  ]);
  assert.deepEqual(f.sources.paths, ["bb.edn", "package.json", ".mise.toml"]);
  assert.equal(f.sources.files[".mise.toml"], null, "missing at HEAD");
  assert.match(f.sources.files["bb.edn"]!, /^[0-9a-f]{40}$/);
  assert.match(f.sources.fingerprint!, /^sha256:/);
  assert.equal(f.approved, null);
  assert.equal(f.proof, null);
  assert.equal(f.suite, SUITE_VERSION);
  git("checkout", "--", ".");
  // A source committed changes its blob and the fingerprint, not the hash; a reworded why changes neither.
  write("bb.edn", "{:tasks {:new 1}}");
  write(".sova/project.json", JSON.stringify({ ...DEF, services: { ...DEF.services, web: { ...DEF.services.web, isolation: { method: "ports", why: "Reworded." } } } }, null, 2));
  commit("deps");
  const g = await observeRuntime(root);
  assert.deepEqual(g.def, { state: "present", hash }, "isolation and sources stay outside the hash");
  assert.notEqual(g.sources.fingerprint, f.sources.fingerprint);
  assert.notEqual(g.sources.files["bb.edn"], f.sources.files["bb.edn"]);
  assert.equal(g.sources.files["package.json"], f.sources.files["package.json"]);
});

test("approval at HEAD: a stale hash is refused, the shown one approved; stamps split unconfined from confined", async () => {
  const f = await observeRuntime(root);
  const hash = (f.def as { hash: string }).hash;
  await assert.rejects(() => approveAtRef(root, "sha256:other"), /changed since it was shown/);
  const ok = await approveAtRef(root, hash);
  assert.equal(ok.hash, hash);
  assert.ok(isApproved(root, hash));
  mkdirSync(conformDir(), { recursive: true });
  const stamp = (pass: boolean, suiteVersion = SUITE_VERSION) => ({ suiteVersion, pass, at: "2026-10-03T00:00:00.000Z", report: "/r.json", ...(pass ? {} : { failed: { check: "up-a", detail: "x" } }) });
  writeFileSync(join(conformDir(), "stamps.json"), JSON.stringify({ version: 1, stamps: { [root]: { [hash]: stamp(false) } }, confined: { [root]: { [hash]: stamp(true) } } }));
  const g = await observeRuntime(root);
  assert.deepEqual(g.approved?.hash, hash);
  assert.equal(g.proof?.pass, false);
  assert.equal(g.proof?.confined, false);
  assert.deepEqual(g.proof?.failed, { check: "up-a", detail: "x" });
  assert.equal(g.confinedProof?.pass, true);
  assert.equal(g.confinedProof?.confined, true);
  // A stamp of an older suite proves nothing now.
  writeFileSync(join(conformDir(), "stamps.json"), JSON.stringify({ version: 1, stamps: { [root]: { [hash]: stamp(true, SUITE_VERSION - 1) } } }));
  assert.equal((await observeRuntime(root)).proof, null);
});

test("a branch's tip: its own hash, approval and confined proof", async () => {
  git("checkout", "-qb", "sova/onboard");
  const next = { ...DEF, slots: { cap: 3 } };
  write(".sova/project.json", JSON.stringify(next, null, 2));
  commit("proposal");
  git("checkout", "-q", "main");
  const b = await branchFacts(root, "sova/onboard");
  assert.deepEqual(b.def, { state: "present", hash: defHashOf(parseDefinition(JSON.stringify(next))) });
  assert.equal(b.approved, false);
  assert.equal(b.proof, null);
  assert.equal(b.commit, git("rev-parse", "sova/onboard").trim());
  assert.deepEqual((await branchFacts(root, "no-such-branch")).def, { state: "absent" });
});
