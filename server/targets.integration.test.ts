// Run: node scripts/run-tests.mjs server/targets.integration.test.ts
// targets.ts against real commands (the in-process cases are targets.test.ts). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written. No network: the remote
// shell is stood in for by a local `sh -c` (a docker target whose `docker` is a PATH shim that runs
// the exec'd argv here, and the far command of an ssh argv run through sh exactly as the remote
// login shell would).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-targets-test-")));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sova-targets-scratch-")));
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

// `docker exec -i <container> sh -c <script>` → run `sh -c <script>` on this machine.
mkdirSync(join(scratch, "bin"));
writeFileSync(join(scratch, "bin", "docker"), '#!/bin/sh\n[ "$1 $2" = "exec -i" ] || exit 99\nshift 3\nexec "$@"\n');
chmodSync(join(scratch, "bin", "docker"), 0o755);
process.env.PATH = `${join(scratch, "bin")}:${process.env.PATH}`;

const T = await import("./targets");
const { buildListDirsArgv, buildTargetArgv } = await import("../pi-config/extensions/remote/argv.ts");

const ssh = { name: "acme-prod", label: "acme prod", kind: "ssh", ssh: { user: "deploy", host: "192.0.2.10", key: "~/.ssh/id_rsa" }, cwd: "/home/deploy/acme-site" } as const;
const local = { name: "here", kind: "docker", docker: { container: "box" } } as const;
// The registry the cases below read: "here" is the local target the docker shim runs.
T.writeTargets([ssh as never, local as never]);

// A folder name built to break out of any unquoted interpolation.
const hostile = `it's $(touch PWNED) \`touch PWNED\` ; touch PWNED "q"`;

test("quoting: a hostile folder path reaches the far shell as data (ssh argv's far command run through sh)", async () => {
  const dir = join(scratch, hostile);
  mkdirSync(join(dir, "child"), { recursive: true });
  const argv = buildListDirsArgv(ssh as never, dir);
  assert.equal(argv[0], "ssh");
  assert.ok(argv.includes("BatchMode=yes"));
  assert.ok(argv.some((a) => a.startsWith("ConnectTimeout=")));
  // ssh hands its last word to the remote login shell: do exactly that, locally, in scratch.
  const r = await T.runArgv(["sh", "-c", `cd ${JSON.stringify(scratch)} && ${argv[argv.length - 1]}`]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("child"));
  assert.equal(existsSync(join(scratch, "PWNED")), false);
  assert.equal(existsSync(join(dir, "PWNED")), false);
  // the probe/command builder quotes a hostile cwd the same way
  const run = buildTargetArgv(ssh as never, { command: "pwd", cwd: dir });
  const r2 = await T.runArgv(["sh", "-c", run.at(-1)!]);
  assert.equal(r2.stdout.trim(), dir);
  assert.equal(existsSync(join(scratch, "PWNED")), false);
});

test("listRemoteFolders on a local target: hidden filtering, sorting, parent, and a hostile path", async () => {
  for (const d of ["beta", "Alpha", ".dot", hostile]) mkdirSync(join(scratch, "tree", d), { recursive: true });
  writeFileSync(join(scratch, "tree", "file.txt"), "x");
  const r = await T.listRemoteFolders("here", join(scratch, "tree"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(
    r.listing.entries.map((e) => e.name),
    ["Alpha", "beta", hostile],
  );
  assert.equal(r.listing.entries[0]?.path, join(scratch, "tree", "Alpha"));
  assert.equal(r.listing.parent, scratch);
  assert.equal(r.listing.truncated, false);
  const h = await T.listRemoteFolders("here", join(scratch, "tree"), { hidden: true });
  assert.ok(h.ok && h.listing.entries.some((e) => e.name === ".dot"));
  const inner = await T.listRemoteFolders("here", join(scratch, "tree", hostile));
  assert.ok(inner.ok, JSON.stringify(inner));
  assert.equal(existsSync(join(scratch, "tree", "PWNED")), false);
});

test("listRemoteFolders errors: unknown target 404, relative path 400, missing folder 502 with a reason", async () => {
  assert.deepEqual(await T.listRemoteFolders("nope", "/"), { ok: false, status: 404, error: "Unknown target: nope" });
  const rel = await T.listRemoteFolders("here", "relative");
  assert.ok(!rel.ok && rel.status === 400);
  const missing = await T.listRemoteFolders("here", join(scratch, "does-not-exist"));
  assert.ok(!missing.ok && missing.status === 502 && missing.error.includes("no such folder"), JSON.stringify(missing));
});

test("runArgv is bounded: a hung command is killed and classified offline; ssh's 255 is offline", async () => {
  // Cut off by its 200 ms bound, not finished: timedOut says which, with no clock to read.
  const r = await T.runArgv(["sleep", "10"], 200);
  assert.equal(r.timedOut, true);
  assert.equal(T.classifyFailure(r)?.status, "offline");
  assert.equal(T.classifyFailure({ code: 255, stdout: "", stderr: "ssh: connect to host x port 22: Connection refused\n", timedOut: false })?.status, "offline");
  assert.deepEqual(T.classifyFailure({ code: 1, stdout: "", stderr: "a\nnope\n", timedOut: false }), { status: "error", error: "nope" });
  assert.equal(T.classifyFailure({ code: 0, stdout: "", stderr: "", timedOut: false }), null);
  const missing = await T.runArgv(["/nonexistent/binary"]);
  assert.equal(T.classifyFailure(missing)?.status, "error");
});

test("probeTarget caches and shares one run; listTargets reports status", async () => {
  const registry = T.loadTargets().targets;
  const here = registry.find((t) => t.name === "here")!;
  const [a, b] = await Promise.all([T.probeTarget(here, registry), T.probeTarget(here, registry)]);
  assert.equal(a, b);
  assert.equal(a.status, "ok");
  assert.equal(await T.probeTarget(here, registry), a); // cached
  const bad = { name: "via-missing", kind: "docker", docker: { container: "x" }, via: "ghost" } as never;
  assert.equal((await T.probeTarget(bad, registry)).status, "error");
  T.writeTargets([local as never]);
  assert.deepEqual(await T.listTargets(), [{ name: "here", label: "here", kind: "docker", status: "ok", host: "box" }]);
});

test("listTargets never waits past its cap: a slow probe reports unknown now and its result later", async () => {
  writeFileSync(join(scratch, "bin", "docker"), '#!/bin/sh\nsleep 1\nshift 3\nexec "$@"\n');
  T.writeTargets([{ name: "slow", kind: "docker", docker: { container: "box" } } as never]);
  // "unknown" is the answer before the 1 s probe finished: it did not wait for it.
  assert.equal((await T.listTargets(100))[0]?.status, "unknown");
  assert.equal((await T.listTargets(5000))[0]?.status, "ok"); // the same run finishes and is cached
});

test("TargetInfo carries no mount field", async () => {
  const infos = await T.listTargets(0); // don't wait on probes
  for (const info of infos) assert.equal("mounted" in info, false, info.name);
});
