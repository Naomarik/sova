// Run: node scripts/run-tests.mjs server/targets.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written. In
// process only: what runs real commands (the docker shim, sh, sleep) is targets.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const T = await import("./targets");

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
  assert.equal(T.parseTargetCwd("/home/user/webapps/sova"), null);
  assert.equal(T.parseTargetCwd(join(agentDir, "sova", "targets")), null);
  assert.equal(T.parseTargetCwd(join(agentDir, "sova", "targets-other", "x", "y")), null);
  assert.equal(T.parseTargetCwd(`${join(agentDir, "sova", "targets")}/`), null);
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

// ---------------------------------------------------------------------------

const mthost = { name: "mthost", label: "mt host", kind: "ssh", ssh: { user: "u", host: "example.invalid" }, cwd: "/srv/app" } as const;
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });

test("POST /api/sessions: a placeholder request creates the placeholder; { cwd } stats a plain local folder", async () => {
  const post = (body: unknown) =>
    app.request("/api/sessions", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  T.writeTargets([mthost as never, local as never]);
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

