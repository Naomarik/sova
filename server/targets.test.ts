// Run: npx tsx --test server/targets.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written. No network:
// the remote shell is stood in for by a local `sh -c` (a docker target whose `docker` is a PATH shim
// that runs the exec'd argv here, and the far command of an ssh argv run through sh exactly as the
// remote login shell would).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-targets-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const scratch = mkdtempSync(join(tmpdir(), "pi-web-targets-scratch-"));
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

test("missing targets.json is no targets and no error", () => {
  assert.deepEqual(T.loadTargets(), { targets: [], invalid: [] });
});

test("parseTargets: bad JSON or envelope is a file error; bad entries are skipped with reasons", () => {
  assert.match(T.parseTargets("{").error ?? "", /JSON/);
  assert.ok(T.parseTargets(JSON.stringify({ version: 2, targets: [] })).error);
  const r = T.parseTargets(
    JSON.stringify({
      version: 1,
      targets: [ssh, { name: "..", kind: "docker", docker: { container: "box" } }, { name: "x y", kind: "ssh" }, { name: "nohost", kind: "ssh", ssh: {} }, { ...ssh }],
    }),
  );
  assert.equal(r.error, undefined);
  assert.deepEqual(
    r.targets.map((t) => t.name),
    ["acme-prod"],
  );
  assert.deepEqual(r.invalid.map((i) => i.name).sort(), ["..", "acme-prod", "nohost", "x y"]);
  assert.ok(r.invalid.every((i) => i.errors.length > 0));
});

test("writeTargets writes atomically and round-trips; refuses an invalid entry and leaves the file alone", () => {
  T.writeTargets([ssh as never, local as never]);
  const file = join(agentDir, "targets.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, targets: [ssh, local] });
  assert.deepEqual(
    readdirSync(agentDir).filter((f) => f.endsWith(".tmp")),
    [],
  );
  assert.deepEqual(
    T.loadTargets().targets.map((t) => t.name),
    ["acme-prod", "here"],
  );
  assert.throws(() => T.writeTargets([{ name: "bad name", kind: "ssh" } as never]), /Refusing/);
  assert.equal(T.loadTargets().targets.length, 2);
  assert.equal(T.findTarget("here")?.kind, "docker");
  assert.equal(T.findTarget(".."), undefined);
});

test("placeholder layout mirrors the remote path and round-trips", () => {
  const root = join(agentDir, "sova", "targets");
  assert.equal(T.targetsRoot(), root);
  const dir = T.targetDir("acme-prod", "/home/deploy/acme-site");
  assert.equal(dir, join(root, "acme-prod", "home", "deploy", "acme-site"));
  assert.deepEqual(T.parseTargetCwd(dir), { target: "acme-prod", remoteCwd: "/home/deploy/acme-site" });
  assert.equal(T.targetOfCwd(dir), "acme-prod");
  assert.equal(T.remoteCwdOfCwd(dir), "/home/deploy/acme-site");
  // remote root, trailing slash, dot-dot clamps at "/" (never escapes the target dir)
  assert.equal(T.targetDir("acme-prod", "/"), join(root, "acme-prod"));
  assert.equal(T.remoteCwdOfCwd(join(root, "acme-prod")), "/");
  assert.equal(T.targetDir("acme-prod", "/srv/app/"), join(root, "acme-prod", "srv", "app"));
  assert.equal(T.targetDir("acme-prod", "/../../../etc"), join(root, "acme-prod", "etc"));
  assert.throws(() => T.targetDir("acme-prod", "relative/path"), /absolute/);
  assert.throws(() => T.targetDir("..", "/x"), /Invalid target name/);
  assert.throws(() => T.targetDir("a/b", "/x"), /Invalid target name/);
});

test("local cwds are not remote: outside the root, the bare root, sibling prefixes", () => {
  assert.equal(T.parseTargetCwd("/home/user/webapps/pi-web"), null);
  assert.equal(T.parseTargetCwd(join(agentDir, "sova", "targets")), null);
  assert.equal(T.parseTargetCwd(join(agentDir, "sova", "targets-other", "x", "y")), null);
  assert.equal(T.parseTargetCwd(`${join(agentDir, "sova", "targets")}/`), null);
});

test("RENAME BRIDGE: a placeholder cwd written under the legacy root is still remote, never local", () => {
  // Session headers created before the state move name `<agent dir>/pi-web/targets/…` and are
  // never rewritten. Misreading one as an ordinary local folder would run the session's tools on
  // THIS machine against a path that only mirrors the target's — the failure this bridge exists
  // to prevent. parseTargetCwd re-anchors through unlegacyStatePath before it classifies.
  const legacyRoot = join(agentDir, "pi-web", "targets");
  const legacyDir = join(legacyRoot, "acme-prod", "home", "deploy", "acme-site");
  assert.deepEqual(T.parseTargetCwd(legacyDir), { target: "acme-prod", remoteCwd: "/home/deploy/acme-site" });
  assert.equal(T.targetOfCwd(legacyDir), "acme-prod");
  assert.equal(T.remoteCwdOfCwd(legacyDir), "/home/deploy/acme-site");
  // The target's own root maps to remote "/", exactly as the new spelling does.
  assert.equal(T.remoteCwdOfCwd(join(legacyRoot, "acme-prod")), "/");
  // The bare legacy root is not itself a placeholder, and neither is a sibling that merely
  // shares its prefix: the legacy spelling gets the same boundaries as the new one, not looser.
  assert.equal(T.parseTargetCwd(legacyRoot), null);
  assert.equal(T.parseTargetCwd(join(agentDir, "pi-web", "targets-other", "x", "y")), null);
});

test("targetInfo: label defaults to the name; kind shows the environment layer; host is credential-free", () => {
  assert.deepEqual(T.targetInfo(ssh as never), {
    name: "acme-prod",
    label: "acme prod",
    kind: "ssh",
    status: "unknown",
    cwd: "/home/deploy/acme-site",
    host: "deploy@192.0.2.10",
  });
  assert.equal(T.targetInfo(local as never).label, "here");
  assert.equal(T.targetInfo({ name: "c", kind: "docker", via: "acme-prod", docker: { container: "web" } } as never).host, "web via acme-prod");
  assert.equal(T.targetInfo(local as never).host, "box");
  const info = T.targetInfo({ name: "i", kind: "incus-cell", incus: { cell: "cell-a", sandbox: "sb" } } as never, { status: "offline", error: "boom", at: 0 });
  assert.equal(info.kind, "incus-cell");
  assert.equal(info.status, "offline");
  assert.equal(info.error, "boom");
});

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
  const t0 = Date.now();
  const r = await T.runArgv(["sleep", "10"], 200);
  assert.ok(Date.now() - t0 < 3000);
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
  const t0 = Date.now();
  assert.equal((await T.listTargets(100))[0]?.status, "unknown");
  assert.ok(Date.now() - t0 < 900);
  assert.equal((await T.listTargets(5000))[0]?.status, "ok"); // the same run finishes and is cached
});

// ---------------------------------------------------------------------------
// Legacy sshfs mount cwds. pi-web once mounted targets under <agentDir>/mounts/<name>; a session
// stored there has its files on the target, not here, so opening it is refused (chat-manager).
// The check is lexical: no fs, no schema, no targets.json.

const mthost = { name: "mthost", label: "mt host", kind: "ssh", ssh: { user: "u", host: "example.invalid" }, cwd: "/srv/app" } as const;

test("parseLegacyMountCwd: a cwd under the legacy mounts root names its target; anything else is null", () => {
  T.writeTargets([mthost as never, local as never]);
  const root = T.legacyMountsRoot();
  assert.equal(root, join(agentDir, "mounts"));
  assert.deepEqual(T.parseLegacyMountCwd(join(root, "acme-prod", "x")), { target: "acme-prod" });
  assert.deepEqual(T.parseLegacyMountCwd(join(root, "acme-prod")), { target: "acme-prod" });
  assert.equal(T.parseLegacyMountCwd(`${root}-other/x`), null); // a sibling prefix is never a match
  assert.equal(T.parseLegacyMountCwd(root), null); // the root itself names no target
  assert.equal(T.parseLegacyMountCwd(T.targetDir("mthost", "/srv/app")), null); // a placeholder is a remote session
  assert.equal(T.parseLegacyMountCwd("/home/user/webapps/pi-web"), null);
  // parseTargetCwd knows placeholders only: a legacy mount cwd is not a remote session
  assert.deepEqual(T.parseTargetCwd(T.targetDir("mthost", "/srv/app")), { target: "mthost", remoteCwd: "/srv/app" });
  assert.equal(T.targetOfCwd(T.targetDir("mthost", "/srv/app")), "mthost");
  assert.equal(T.parseTargetCwd(join(root, "mthost", "x")), null);
  assert.equal(T.parseTargetCwd("/home/user/webapps/pi-web"), null);
});

test("TargetInfo carries no mount field", async () => {
  const infos = await T.listTargets(0); // don't wait on probes
  for (const info of infos) assert.equal("mounted" in info, false, info.name);
});

process.env.PORT = "0"; // an ephemeral port: this file never touches 4800/5173
const { app, server } = await import("./index");
after(() => server.close());

test("POST /api/sessions: a placeholder request creates the placeholder; { cwd } stats a plain local folder", async () => {
  const post = (body: unknown) =>
    app.request("/api/sessions", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const r = await post({ target: "here", remoteCwd: "/srv/app" });
  assert.equal(r.status, 201);
  const s = (await r.json()) as { cwd: string; target?: string; remoteCwd?: string; mounted?: boolean };
  assert.equal(s.cwd, T.targetDir("here", "/srv/app")); // the placeholder path
  assert.ok(existsSync(s.cwd)); // created
  assert.equal(s.target, "here");
  assert.equal(s.remoteCwd, "/srv/app");
  assert.equal("mounted" in s, false);
  const plain = await post({ target: "mthost", remoteCwd: "/home/deploy" });
  assert.equal(plain.status, 201);
  assert.equal(((await plain.json()) as { cwd: string }).cwd, T.targetDir("mthost", "/home/deploy"));
  // a plain local cwd: stat, then create
  const localCwd = await post({ cwd: scratch });
  assert.equal(localCwd.status, 201);
  assert.equal(((await localCwd.json()) as { cwd: string }).cwd, scratch);
  const missing = await post({ cwd: join(scratch, "nope") });
  assert.equal(missing.status, 400);
});

test("a session stored inside a legacy sshfs mount cwd is refused, never opened as a local session", async () => {
  const legacy = join(T.legacyMountsRoot(), "mthost", "work");
  mkdirSync(legacy, { recursive: true }); // exists and is empty: exactly the silent-local-session trap
  const r = await app.request("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: legacy }), headers: { "content-type": "application/json" } });
  assert.equal(r.status, 400); // new sessions must not be created in removed mounts either
  assert.match((await r.json() as { error: string }).error, /removed sshfs mount/);
  // Simulate a historical file directly: the create endpoint now prevents this trap.
  const dir = join(agentDir, "sessions", "--legacy--");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "2026-09-22T00-00-00-000Z_legacy-mount.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "legacy-mount", timestamp: "2026-09-22T00:00:00.000Z", cwd: legacy }) + "\n");
  const { acquireChat, activeConfigFailure, ConfigError } = await import("./chat-manager");
  await assert.rejects(acquireChat(path), (e: Error) => e instanceof ConfigError && /a feature Sova no longer has/.test(e.message) && /mthost/.test(e.message));
  assert.ok(activeConfigFailure(path), "memoized for good: the empty directory existing does not clear it");
  await assert.rejects(acquireChat(path), (e: Error) => e instanceof ConfigError); // the memo answers, no runtime is built
});
