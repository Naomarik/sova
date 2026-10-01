// Run: node --test .sova/playbooks/merge-round/discover-names.test.mjs
// The merge round's name discovery: it finds each kind in fixtures under a temporary agent dir and
// HOME (never the real ~/.pi), drops public and generic terms, merges additively at 0600, takes the
// user's own names, flags names origin already has, and never prints a value without --show.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const DISCOVER = fileURLToPath(new URL("./discover-names.mjs", import.meta.url));
const SCAN = fileURLToPath(new URL("./leak-scan.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "discover-names-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const agent = join(dir, "agent");
const home = join(dir, "home");
const repo = join(dir, "repo");
const remote = join(dir, "remote.git");
const settingsFile = join(agent, "sova", "merge-round.json");

// Placeholders only: every value here is made up.
const OWNER = "octo-owner";
const V = {
  tsSelf: "zephyr-box",
  tsPeer: "quokka-node",
  tailnet: "tail0000.ts.net",
  tsIp: "100.64.0.9",
  peerLabel: "wombat-vps",
  peerNode: "nNODE1234CNTRL",
  device: "d_kestrel01",
  email: "someone@acme-private.test",
  domain: "acme-private.test",
  gitEmail: "dev@otter-labs.test",
  orgOperator: "Jordan Placeholder",
  orgId: "o_heron-works",
  meshExt: "lynx-dashboard",
  envHost: "vps-marmot.test",
  envIp: "100.64.0.77",
  hostId: "h_abcd1234",
};

// A word in more tracked files than the threshold (too common to block on), and one in 7 (listed, capped at 5 files).
const COMMON = "zorbaword";
const MANY = "quillword";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "init.defaultBranch=master", ...a], { cwd, stdio: "pipe" });
mkdirSync(home);
mkdirSync(repo);
git(dir, "init", "-q", "--bare", remote);
git(repo, "init", "-q");
git(repo, "config", "user.email", V.gitEmail);
git(repo, "remote", "add", "origin", `https://github.com/${OWNER}/sova.git`);
mkdirSync(join(repo, "scripts", "mesh-vps"), { recursive: true });
writeFileSync(join(repo, "scripts", "mesh-vps", "local.env.example"), "VPS_SSH=user@100.64.0.2\nVPS_LABEL=vps\nPROD_UNITS=\"tailscaled\"\n");
// One name is already public on origin, in a file named after another.
writeFileSync(join(repo, `notes-${V.meshExt}.md`), `we deploy on ${V.peerLabel}\n`);
for (let i = 0; i < 12; i++) writeFileSync(join(repo, `common-${i}.txt`), `a ${COMMON} here\n`);
for (let i = 0; i < 7; i++) writeFileSync(join(repo, `many-${i}.txt`), `a ${MANY} here\n`);
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "base");
git(repo, "push", "-q", remote, "master");
git(repo, "fetch", "-q", remote, "master:refs/remotes/origin/master");
// Untracked site settings: the example's values are skipped, the rest are names.
writeFileSync(join(repo, "scripts", "mesh-vps", "local.env"), `VPS_SSH=opsdeploy@${V.envIp}\nVPS_LABEL=vps\nVPS_DNS="${V.envHost}"\nPROD_UNITS="tailscaled"\nPORT=4801\n`);

const json = (file, value) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
json(join(agent, "sova", "host.json"), { version: 1, id: V.hostId });
json(join(agent, "sova", "peers.json"), {
  self: { id: "self", label: "self" },
  peers: [
    { id: "p1", label: V.peerLabel, nodeId: V.peerNode, dnsName: `${V.peerLabel}.${V.tailnet}`, url: `http://${V.tsIp}:4801` },
    { id: "p2", label: OWNER, nodeId: "nX", dnsName: "abc" },
    { id: "p3", label: COMMON },
    { id: "p4", label: MANY },
  ],
  sync: {},
  frontDoor: null,
});
json(join(agent, "sova", "mesh-extensions.json"), { version: 1, peers: { [V.hostId]: { at: 1, entries: [{ id: V.meshExt, title: "Dashboard" }] } } });
json(join(agent, "sova", "orgs.json"), { version: 1, operator: { name: V.orgOperator }, orgs: [{ id: V.orgId, dir: "/x", attachedAt: "" }] });
json(join(agent, "claude-accounts.json"), {
  version: 1,
  logins: [{ id: "l1", addedAt: 1, enabled: true, device: V.device, identity: { email: V.email } }],
  devices: { [V.device]: { order: ["l1"] }, local: { order: [] } },
});

// A stubbed tailscale on PATH: one that answers, one that fails as a sandbox would.
const fakeBin = (name, body) => {
  const d = join(dir, name);
  mkdirSync(d);
  writeFileSync(join(d, "tailscale"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(d, "tailscale"), 0o755);
  return d;
};
const status = {
  Self: { HostName: V.tsSelf, DNSName: `${V.tsSelf}.${V.tailnet}.`, TailscaleIPs: [V.tsIp, "fd7a:115c:a1e0::9"] },
  Peer: { k: { HostName: V.tsPeer, DNSName: `${V.tsPeer}.${V.tailnet}.`, TailscaleIPs: ["100.64.0.10"] } },
  MagicDNSSuffix: V.tailnet,
  CurrentTailnet: { Name: V.email, MagicDNSSuffix: V.tailnet },
};
writeFileSync(join(dir, "status.json"), JSON.stringify(status));
const tsOk = fakeBin("ts-ok", `cat '${join(dir, "status.json")}'`);
const tsFail = fakeBin("ts-fail", "echo 'failed to connect to local tailscaled' >&2; exit 1");

const discover = (argv = [], bin = tsOk) =>
  spawnSync(process.execPath, [DISCOVER, "--repo", repo, ...argv], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, HOME: home, CLAUDE_CONFIG_DIR: "", PATH: `${bin}${delimiter}${process.env.PATH}` },
    encoding: "utf8",
  });
const settings = () => JSON.parse(readFileSync(settingsFile, "utf8"));
const lower = (names) => names.map((n) => n.toLowerCase());
const assertNoValues = (out) => {
  for (const v of [...Object.values(V), OWNER, COMMON, MANY]) assert.ok(!out.toLowerCase().includes(v.toLowerCase()), `the output never names a value (${Object.keys(V).find((k) => V[k] === v) ?? "owner"})`);
};

test("a dry run writes nothing and prints kinds and counts only", () => {
  const r = discover(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.throws(() => statSync(settingsFile));
  assert.match(r.stdout, /Dry run: nothing written\./);
  for (const kind of ["tailscale-host", "tailnet", "ip", "peer", "device", "email", "email-domain", "org", "mesh-extension", "local-env", "host-id"]) assert.match(r.stdout, new RegExp(`^- ${kind}: \\d+ found`, "m"), kind);
  assert.match(r.stdout, /restartUnit would be sova-runtime\.service/);
  assertNoValues(r.stdout + r.stderr);
});

test("writes the list at 0600, drops public, generic and short terms, and flags what origin already has, masked", () => {
  const r = discover();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(settingsFile).mode & 0o777, 0o600);
  const s = settings();
  const names = lower(s.privateNames);
  for (const v of Object.values(V)) assert.ok(names.includes(v.toLowerCase()), `found ${Object.keys(V).find((k) => V[k] === v)}`);
  assert.ok(names.includes("tail0000") && names.includes("fd7a:115c:a1e0::9") && names.includes("opsdeploy"), "tailnet label, IPv6 and a user@ part");
  for (const gone of [OWNER, "abc", "self", "vps", "tailscaled", "4801", "user@100.64.0.2", "100.64.0.2", "home", "local"]) assert.ok(!names.includes(gone), `dropped: ${gone}`);
  assert.equal(s.restartUnit, "sova-runtime.service");
  assert.equal(s.kinds[V.tsSelf], "tailscale-host");
  assert.equal(s.kinds[V.domain], "email-domain");
  const count = Object.values(s.sources).reduce((a, n) => a + n, 0);
  assert.equal(count, s.privateNames.length);
  assert.match(r.stdout, /Written to <state root>\/merge-round\.json \(0600\)\./);
  assert.ok(!names.includes(COMMON), "a discovered word in more than 10 tracked files is dropped");
  assert.ok(names.includes(MANY));
  assert.match(r.stdout, /^Dropped: .*\b1 common\b/m);
  assert.match(r.stdout, /Already public on origin\/master: 2 names /);
  assert.match(r.stdout, /- peer #\d+: notes-\[mesh-extension #\d+\]\.md \(1 line\)$/m);
  assert.match(r.stdout, /- peer #\d+: (many-\d\.txt \(1 line\), ){5}\+2 more$/m, "at most 5 files per name");
  assert.ok(!/Too common/.test(r.stdout));
  assertNoValues(r.stdout + r.stderr);
});

test("merges additively: keeps names and settings, never duplicates, and takes the user's own names", () => {
  const s = settings();
  s.privateNames.push("Keep-Me-Name");
  s.restartUnit = "custom.service";
  s.other = true;
  writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  const before = s.privateNames.length;
  const file = join(dir, "answers.txt");
  writeFileSync(file, "# the user's answers\nclient: Pelican Holdings\nsecret-box-name\n");
  const r = discover(["--add-kind", "server", "--add", "203.0.114.5", "--add", "keep-me-name", "--add-file", file]);
  assert.equal(r.status, 0, r.stderr);
  const t = settings();
  assert.equal(t.restartUnit, "custom.service");
  assert.equal(t.other, true);
  assert.equal(t.privateNames.length, before + 3);
  assert.equal(t.kinds["Keep-Me-Name"], "listed");
  assert.equal(t.kinds["203.0.114.5"], "server");
  assert.equal(t.kinds["Pelican Holdings"], "client");
  assert.equal(t.kinds["secret-box-name"], "user");
  assert.match(r.stdout, /^- client: 1 found, 1 new$/m);
  assert.match(r.stdout, /^- server: 2 found, 1 new$/m);
  assert.ok(!/pelican|secret-box|keep-me|203\.0\.114/i.test(r.stdout));
  const again = discover();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(settings().privateNames.length, t.privateNames.length, "a second run adds nothing");
  assert.match(again.stdout, / 0 new;/);
});

test("a name of yours that is too common is kept with a masked warning, and warned about again while it stays", () => {
  const r = discover(["--add-kind", "word", "--add", COMMON]);
  assert.equal(r.status, 0, r.stderr);
  const names = settings().privateNames;
  const i = names.indexOf(COMMON);
  assert.ok(i >= 0, "the user's own name is kept");
  assert.match(r.stdout, /^Too common to block on \(in more than 10 tracked files on origin\/master\)/m);
  assert.match(r.stdout, new RegExp(`^- word #${i + 1} \\(yours\\): 12 files$`, "m"));
  assert.ok(!new RegExp(`- word #${i + 1}:`).test(r.stdout.split("Too common")[0]), "not listed under Already public");
  const again = discover();
  assert.equal(again.status, 0, again.stderr);
  assert.ok(settings().privateNames.includes(COMMON), "never removed");
  assert.match(again.stdout, new RegExp(`^- word #${i + 1}: 12 files$`, "m"));
  assertNoValues(r.stdout + again.stdout);
});

test("--show prints the list by kind, for the interview", () => {
  const r = discover(["--show", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /The list \(local chat only, never a commit\):/);
  assert.match(r.stdout, new RegExp(`^- client: Pelican Holdings$`, "m"));
  assert.ok(r.stdout.includes(V.tsSelf));
});

test("a tailscale that can't run is skipped silently", () => {
  const r = discover(["--dry-run"], tsFail);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /tailscale: not available here, skipped/);
  assert.ok(!/^- tailscale-host:/m.test(r.stdout));
});

test("the file it writes is what leak-scan reads", () => {
  writeFileSync(join(repo, "e.txt"), `ssh to ${V.tsPeer}\n`);
  git(repo, "add", "e.txt");
  git(repo, "commit", "-q", "-m", "change");
  const scan = spawnSync(process.execPath, [SCAN, "--range", "HEAD~1..HEAD", "--repo", repo], { env: { ...process.env, PI_CODING_AGENT_DIR: agent }, encoding: "utf8" });
  assert.equal(scan.status, 1, scan.stdout + scan.stderr);
  const i = settings().privateNames.indexOf(V.tsPeer);
  assert.match(scan.stdout, new RegExp(`e\\.txt:1 · private name #${i + 1} \\(merge-round\\.json line ${i + 4}\\)`));
  assert.ok(!scan.stdout.includes(V.tsPeer));
});

test("an unreadable settings file is left alone", () => {
  writeFileSync(settingsFile, "{ not json");
  const r = discover();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /isn't valid JSON\. Nothing written/);
  assert.equal(readFileSync(settingsFile, "utf8"), "{ not json");
});
