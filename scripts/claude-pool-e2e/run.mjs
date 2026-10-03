#!/usr/bin/env node
// Multi-host end to end for the pool of Claude logins (§app.claude-logins/pool … /stuck).
//
// Three Sova hosts in Docker containers ("desk", the keeper; "vps"; "phone"), each running THIS
// worktree (bind-mounted read-only, its own agent dir in a volume) with scripts/fake-claude.mjs as
// `claude`. They pair over a Docker network of their own that is `--internal` (no route out) with
// tailnet-range addresses, in address-identity mode (§mesh.peers/address-identity): no Tailscale,
// no headscale, no real tailnet, no real peer. Every credential is synthetic.
//
//   node scripts/claude-pool-e2e/run.mjs            # up, run every scenario, leave it up
//   node scripts/claude-pool-e2e/run.mjs --down     # remove every container, volume and network
//   node scripts/claude-pool-e2e/run.mjs --keep     # up and pair only (for a browser: desk on 127.0.0.1:4821)
//
// Needs docker and the mesh lab's `sovamesh-plain:lab` image (node 25 + socat; scripts/mesh-lab
// builds it). Names are `sovapool*`. Build the worktree first (pnpm run build) for the browser.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const WT = resolve(import.meta.dirname, "..", "..");
const IMAGE = process.env.POOL_E2E_IMAGE ?? "sovamesh-plain:lab";
const NET = "sovapool_mesh";
const PUB = "sovapool_pub";
const NAMES = ["desk", "vps", "phone"];
/** Each host's address, once the network exists (see network()). */
const HOSTS = Object.fromEntries(NAMES.map((h) => [h, ""]));
const PORTS = { desk: 4821, phone: 4822 };
const AGENT = `${WT}/.agent`;
const IDLE_MS = 25_000;
const CUT_MS = 60_000;

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const quiet = (...args) => {
  try {
    return docker(...args);
  } catch {
    return "";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function down() {
  for (const h of NAMES) quiet("rm", "-f", `sovapool-${h}`);
  for (const h of NAMES) quiet("volume", "rm", "-f", `sovapool_${h}_agent`, `sovapool_${h}_home`);
  quiet("network", "rm", NET);
  quiet("network", "rm", PUB);
}

/**
 * The hosts' network: a /24 inside the tailnet range (address identity accepts only those), picked
 * at random the first time and read back from Docker after. A /24 the host's own tailnet routes
 * (policy table 52) already use is never picked, and the network is `--internal`, so its traffic
 * stays on the bridge between the containers.
 */
function network() {
  let subnet = quiet("network", "inspect", NET, "--format", "{{range .IPAM.Config}}{{.Subnet}}{{end}}");
  if (!subnet) {
    let taken = "";
    try {
      taken = execFileSync("ip", ["route", "show", "table", "52"], { encoding: "utf8" });
    } catch {
      // no tailscale here
    }
    const inUse = new Set([...taken.matchAll(/^(\d+\.\d+\.\d+)\./gm)].map((m) => m[1]));
    let prefix;
    do prefix = [100, 64 + Math.floor(Math.random() * 64), Math.floor(Math.random() * 256)].join(".");
    while (inUse.has(prefix));
    subnet = `${prefix}.0/24`;
    docker("network", "create", "--internal", "--subnet", subnet, "--label", "sova.claude-pool-e2e=1", NET);
  }
  const prefix = subnet.split(".").slice(0, 3).join(".");
  NAMES.forEach((h, i) => { HOSTS[h] = `${prefix}.${10 + i}`; });
}

function up() {
  if (!quiet("image", "inspect", IMAGE)) throw new Error(`${IMAGE} is missing (scripts/mesh-lab/lab build)`);
  if (!existsSync(AGENT)) mkdirSync(AGENT); // the mount point of each host's agent volume
  network();
  if (!quiet("network", "inspect", PUB)) docker("network", "create", "--label", "sova.claude-pool-e2e=1", PUB);
  for (const [h, ip] of Object.entries(HOSTS)) {
    if (quiet("inspect", `sovapool-${h}`)) continue;
    const boot = [
      "set -e",
      `cd ${WT}`,
      "node scripts/hermetic-agent-dir.mjs >/dev/null",
      "mkdir -p /pool/home/.claude/projects",
      // Claude Code's own login on this host (the last resort): synthetic.
      `[ -f /pool/home/.claude/.credentials.json ] || printf '%s' '{"claudeAiOauth":{"accessToken":"fake","refreshToken":"fake","expiresAt":4102444800000}}' > /pool/home/.claude/.credentials.json`,
      `printf '%s' '{"hasCompletedOnboarding":true,"oauthAccount":{"accountUuid":"acct-own-${h}","emailAddress":"own-${h}@example.com"}}' > /pool/home/.claude/.claude.json`,
      'export PATH="$(sh scripts/fake-claude-path.sh):$PATH"',
      "socat TCP-LISTEN:4900,fork,reuseaddr TCP:127.0.0.1:4800 &",
      "exec node --import tsx server/index.ts",
    ].join("\n");
    const pub = PORTS[h];
    docker(
      "run", "-d", "--name", `sovapool-${h}`, "--hostname", h, "--label", "sova.claude-pool-e2e=1",
      "--network", pub ? PUB : NET, ...(pub ? [] : ["--ip", ip]), ...(pub ? ["-p", `127.0.0.1:${pub}:4900`] : []),
      "-v", `${WT}:${WT}:ro`, "-v", `sovapool_${h}_agent:${AGENT}`, "-v", `sovapool_${h}_home:/pool/home`,
      "-e", `PI_CODING_AGENT_DIR=${AGENT}`, "-e", "HOME=/pool/home", "-e", "CLAUDE_CONFIG_DIR=/pool/home/.claude",
      "-e", "PORT=4800", "-e", "SOVA_MESH_IDENTITY=addresses", "-e", `SOVA_PEER_HOST=${ip}`, "-e", `SOVA_SELF_NODE_ID=n-${h}`,
      "-e", "SOVA_USAGE_POLL=off", "-e", "SOVA_PRICES_FETCH=off", "-e", `SOVA_CLAUDE_POOL_IDLE_MS=${IDLE_MS}`,
      "-e", `SOVA_CLAUDE_POOL_CUT_MS=${CUT_MS}`, "-e", "SOVA_CLAUDE_POOL_TICK_MS=1000", "-e", "TMPDIR=/tmp",
      "--entrypoint", "sh", IMAGE, "-c", boot,
    );
    if (pub) docker("network", "connect", "--ip", ip, NET, `sovapool-${h}`);
  }
}

// ---- driving a host ----------------------------------------------------------------------------

const sh = (h, script) => docker("exec", `sovapool-${h}`, "sh", "-c", script);
/** Each host's own token, minted by its server at first start in its agent dir (§app.access/token). */
const tokens = {};
const tokenOf = (h) => (tokens[h] ||= quiet("exec", `sovapool-${h}`, "cat", `${AGENT}/sova/auth-token`));
async function api(h, method, path, body) {
  const args = ["exec", `sovapool-${h}`, "curl", "-sS", "-m", "90", "-X", method, "-H", "content-type: application/json", "-H", `x-sova-token: ${tokenOf(h)}`, "-w", "\n%{http_code}"];
  if (body !== undefined) args.push("--data-binary", JSON.stringify(body));
  args.push(`http://127.0.0.1:4800${path}`);
  const out = docker(...args);
  const i = out.lastIndexOf("\n");
  const status = Number(out.slice(i + 1));
  const text = out.slice(0, i);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status, json };
}
async function waitFor(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 400)}`);
}
const pool = async (h) => (await api(h, "GET", "/api/claude/accounts")).json.pool;
const loginDir = (id) => `${AGENT}/claude-accounts/${id}`;
const hasCreds = (h, id) => sh(h, `test -f ${loginDir(id)}/.credentials.json && echo yes || echo no`) === "yes";
const leaving = (h, id) => sh(h, `test -f ${loginDir(id)}/.sova-leaving && echo yes || echo no`) === "yes";

/** The invariant: a login's credentials are on at most one host (staged copies aside, never used). */
function copiesOf(id) {
  return Object.keys(HOSTS).filter((h) => quiet("inspect", "-f", "{{.State.Running}}", `sovapool-${h}`) === "true" && !quiet("inspect", "-f", "{{.State.Paused}}", `sovapool-${h}`).startsWith("true") && hasCreds(h, id));
}
function assertOne(id, where) {
  const on = copiesOf(id);
  if (on.length > 1) throw new Error(`${where}: ${id} is on ${on.join(" and ")}`);
  return on;
}
function check(cond, message) {
  if (!cond) throw new Error(message);
  log(`  ok: ${message}`);
}

async function addLogin(h, code) {
  const started = await api(h, "POST", "/api/claude/accounts/flow", {});
  if (started.json.state !== "waiting") throw new Error(`flow on ${h}: ${JSON.stringify(started.json)}`);
  const done = await api(h, "POST", "/api/claude/accounts/flow/code", { code });
  if (done.json.state !== "done") throw new Error(`code on ${h}: ${JSON.stringify(done.json)}`);
  return done.json.login;
}

/** A chat on `h` on the fake Claude Code model; returns its session path. */
async function newChat(h) {
  const created = await api(h, "POST", "/api/sessions", { cwd: "/tmp" });
  const path = created.json.path ?? created.json.sessionPath ?? created.json.file;
  if (!path) throw new Error(`session on ${h}: ${JSON.stringify(created.json)}`);
  const conf = await api(h, "POST", "/api/sessions/configure", { path, model: "claude-code-cli/sonnet" });
  if (conf.status !== 200) throw new Error(`configure on ${h}: ${JSON.stringify(conf.json)}`);
  return path;
}
async function prompt(h, path, text) {
  const r = await api(h, "POST", "/api/sessions/prompt", { path, text });
  if (r.status !== 200) throw new Error(`prompt on ${h}: ${JSON.stringify(r.json)}`);
}
/** The session file's entries, parsed. */
function entries(h, path) {
  return sh(h, `cat '${path}'`).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const answers = (h, path) =>
  entries(h, path).filter((e) => e.type === "message" && e.message?.role === "assistant").map((e) => (e.message.content ?? []).map((c) => c.text ?? "").join(""));
const loginEntries = (h, path) => entries(h, path).filter((e) => e.type === "custom" && e.customType === "claude-login").map((e) => e.data);
async function waitAnswer(h, path, n, ms = 90_000) {
  return waitFor(`answer #${n} on ${h}`, () => {
    const a = answers(h, path);
    return a.length >= n ? a[n - 1] : undefined;
  }, ms);
}

// ---- the scenarios -------------------------------------------------------------------------------

async function pair() {
  for (const [h, ip] of Object.entries(HOSTS)) {
    const peers = Object.entries(HOSTS).filter(([x]) => x !== h).map(([x, xip]) => ({ id: x, label: x[0].toUpperCase() + x.slice(1), nodeId: `n-${x}`, dnsName: xip }));
    const doc = JSON.stringify({ version: 1, self: { id: h, label: h[0].toUpperCase() + h.slice(1) }, peers });
    sh(h, `mkdir -p ${AGENT}/sova && printf '%s' '${doc}' > ${AGENT}/sova/peers.json`);
    void ip;
  }
  for (const h of Object.keys(HOSTS)) await api(h, "GET", "/api/mesh"); // a hand edit is picked up here
  await waitFor("every host sees the pool with desk as keeper", async () => {
    for (const h of Object.keys(HOSTS)) {
      const p = await pool(h);
      if (!p || p.keeper.id !== "desk" || p.logins.length < 3) return false;
    }
    return true;
  }, 90_000);
}

async function main() {
  if (process.argv.includes("--down")) return down();
  up();
  for (const h of Object.keys(HOSTS)) await waitFor(`${h} serving`, async () => (await api(h, "GET", "/api/claude/accounts")).status === 200, 120_000);

  log("1. mesh off: desk signs in 3 logins (phase 1); vps and phone have none");
  const existing = (await api("desk", "GET", "/api/claude/accounts")).json.logins.filter((l) => l.id !== "default");
  const [alpha, beta, gamma] = existing.length >= 3 ? existing : [await addLogin("desk", "ok-alpha#s"), await addLogin("desk", "ok-beta#s"), await addLogin("desk", "ok-alpha+2#s")];
  const name = { [alpha.id]: "alpha", [beta.id]: "beta", [gamma.id]: "gamma (alpha's account)" };
  check(hasCreds("desk", alpha.id) && hasCreds("desk", beta.id) && hasCreds("desk", gamma.id), "desk holds alpha, beta, gamma");

  log("2. pair the three hosts: the pool forms from desk's logins (migration), desk is the keeper");
  await pair();
  const p0 = await pool("vps");
  check(p0.logins.every((l) => l.holder.device === "desk"), "vps sees every login held by desk");
  check(hasCreds("desk", alpha.id), "nothing moved or was deleted by forming the pool");
  if (process.argv.includes("--keep")) return log(`paired; desk on http://127.0.0.1:4821/#t=${tokenOf("desk")}`);

  log(`3. idle return: after ${IDLE_MS / 1000}s unused, desk's held logins become free`);
  await waitFor("all free at desk", async () => (await pool("desk")).logins.every((l) => l.holder.free && l.holder.device === "desk"), IDLE_MS + 60_000);
  check(true, "alpha, beta, gamma free at the keeper");

  log("4. borrow: a chat on vps borrows the first free login and answers on it");
  const chat = await newChat("vps");
  await prompt("vps", chat, "hello");
  const a1 = await waitAnswer("vps", chat, 1);
  check(a1.includes(alpha.id), `vps answered on alpha: "${a1}"`);
  check(hasCreds("vps", alpha.id) && !hasCreds("desk", alpha.id), "alpha moved desk → vps (desk deleted its copy)");
  assertOne(alpha.id, "after the borrow");
  check((await pool("phone")).logins.find((l) => l.id === alpha.id).holder.device === "vps", "phone sees alpha held by vps");

  log("5. limit → return + borrow: alpha hits its limit on vps");
  sh("vps", `touch ${loginDir(alpha.id)}/FAKE_LIMIT`);
  await prompt("vps", chat, "again");
  const a2 = await waitAnswer("vps", chat, 2);
  check(a2.includes(beta.id), `the same turn answered on beta, skipping gamma (same account): "${a2}"`);
  const sw = loginEntries("vps", chat).find((e) => e.from === alpha.id);
  check(sw && sw.reason === "limit" && /switched/.test(sw.text ?? ""), `the chat records the switch: "${sw?.text}"`);
  await waitFor("alpha back at the keeper", async () => !hasCreds("vps", alpha.id) && hasCreds("desk", alpha.id), 60_000);
  const pAlpha = (await pool("desk")).logins.find((l) => l.id === alpha.id);
  check(pAlpha.holder.free && pAlpha.standing.state === "limited", "alpha is free at desk, limited until its reset");
  assertOne(alpha.id, "after the return");
  assertOne(beta.id, "after the second borrow");

  log("6. move by request with a running turn: phone presses Return on beta while vps is mid-turn");
  await prompt("vps", chat, "[fake-slow 12000] a long one");
  await sleep(2500);
  const r = await api("phone", "POST", `/api/claude/pool/${beta.id}/return`);
  check(r.status === 200, "Return accepted on phone");
  await waitFor("beta marked leaving on vps", async () => leaving("vps", beta.id), 30_000);
  check(hasCreds("vps", beta.id), "beta stays on vps while its turn runs");
  const a3 = await waitAnswer("vps", chat, 3, 60_000);
  check(a3.includes(beta.id), `the running turn finished on beta: "${a3}"`);
  await waitFor("beta back at desk after the turn", async () => !hasCreds("vps", beta.id) && hasCreds("desk", beta.id), 60_000);
  assertOne(beta.id, "after the move");

  log("7. stuck: phone borrows, then goes away; signed in again on vps, phone's copy is deleted when it returns");
  const pchat = await newChat("phone");
  await prompt("phone", pchat, "hi from the phone");
  const a4 = await waitAnswer("phone", pchat, 1);
  const held = [beta.id, gamma.id].find((id) => a4.includes(id));
  check(!!held, `phone answered on a borrowed login: "${a4}"`);
  docker("pause", "sovapool-phone");
  await waitFor("desk shows it stuck on phone", async () => (await pool("desk")).logins.find((l) => l.id === held).holder.stuck, 90_000);
  check(true, `${name[held]} is Stuck on Phone`);
  const again = await api("vps", "POST", "/api/claude/accounts/flow", { login: held });
  check(again.json.state === "waiting", "Sign In Again started on vps");
  const signed = await api("vps", "POST", "/api/claude/accounts/flow/code", { code: held === gamma.id ? "ok-alpha+2#s" : "ok-beta#s" });
  check(signed.json.state === "done", "signed in again on vps");
  await waitFor("desk sees vps holding it", async () => (await pool("desk")).logins.find((l) => l.id === held).holder.device === "vps", 30_000);
  check(true, "vps holds it now (desk's view)");
  docker("unpause", "sovapool-phone");
  await waitFor("phone deletes its stale copy", async () => !hasCreds("phone", held), 90_000);
  check(hasCreds("vps", held), "vps keeps the new sign-in");
  assertOne(held, "after the stuck device returned");

  log("8. keeper offline: no borrow; the phone falls back to its own Claude Code login");
  docker("pause", "sovapool-desk");
  const pchat2 = await newChat("phone");
  await prompt("phone", pchat2, "keeper away");
  const a5 = await waitAnswer("phone", pchat2, 1, 120_000);
  check(a5.includes(".claude"), `phone answered on its own login: "${a5}"`);
  docker("unpause", "sovapool-desk");

  log(`9. idle return from another device: vps's login goes back to desk after ${IDLE_MS / 1000}s unused`);
  await waitFor("vps returns it", async () => !hasCreds("vps", held) && hasCreds("desk", held), IDLE_MS + 60_000);
  await waitFor("phone sees it free", async () => (await pool("phone")).logins.find((l) => l.id === held).holder.free, 30_000);
  check(true, `${name[held]} is free at desk again (phone's view)`);

  for (const l of [alpha, beta, gamma]) assertOne(l.id, "at the end");
  log("PASS: every scenario");
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
