#!/usr/bin/env node
// Dial-out pairing against a real macOS host (§mesh/lan), run from the relay machine:
//   node scripts/mesh-dialout/mac-e2e.mjs [--keep] [--skip-tests]
//
// 1. Ships this checkout's HEAD to a scratch directory on the Mac (git bundle over scp), installs,
//    and runs the transport's unit tests there on Bun and on Node (unless --skip-tests).
// 2. Starts a hermetic Sova on the Mac (the DIAL-OUT HOST, loopback only) and one here (the RELAY,
//    listening on RELAY_IP:RELAY_PORT), each with its own throwaway agent dir and token.
// 3. Pairs them through their Mesh page routes and checks: both channels up, presence by default,
//    each direction under the answering host's grant, a hardened /peer answer, and that removing the
//    pairing on the relay drops the Mac's connections within seconds.
// 4. Stops both servers; removes the Mac's scratch directory unless --keep.
//
// Values come from scripts/mesh-dialout/local.env (see local.env.example). Needs: ssh access to the
// Mac with mise, pnpm and git there, and the relay port open from the Mac's address (README.md).
// Never touches either machine's live Sova or ~/.pi. Prints no token, key or fingerprint.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = new Set(process.argv.slice(2));

// ---- config -----------------------------------------------------------------------------------
function loadEnv() {
  const file = join(HERE, "local.env");
  if (!existsSync(file)) die(`no ${file}: copy local.env.example there and fill it in`);
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "").replace(/\$HOME|~(?=\/)/g, process.env.HOME ?? "");
  }
  for (const k of ["MAC_SSH", "MAC_SSH_KEY", "MAC_DIR", "MAC_PORT", "RELAY_IP", "RELAY_PORT", "RELAY_UI_PORT"]) if (!env[k]) die(`${k} is not set in local.env`);
  if (env.MAC_DIR.startsWith("/") || env.MAC_DIR.includes("..")) die("MAC_DIR must be a plain directory name under the Mac user's home");
  return env;
}
const E = loadEnv();
const TOKEN_MAC = randomBytes(24).toString("base64url");
const TOKEN_RELAY = randomBytes(24).toString("base64url");

let failures = 0;
const results = [];
function die(msg) {
  console.error(`[mac-e2e] ${msg}`);
  process.exit(2);
}
function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` (${detail})` : ""}`);
}

// ---- ssh (no user config, no agent, no forwarding) ----------------------------------------------
const SSH_OPTS = ["-F", "/dev/null", "-i", E.MAC_SSH_KEY, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=10"];
/** A command in the Mac user's login zsh (mise, pnpm on PATH). */
function mac(script, { timeoutMs = 600_000, input } = {}) {
  // mise is often activated only in .zshrc (interactive), so put its usual shims first explicitly.
  const path = 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
  const r = spawnSync("ssh", [...SSH_OPTS, E.MAC_SSH, "zsh", "-lc", shq(path + script)], { encoding: "utf8", timeout: timeoutMs, input, maxBuffer: 64 << 20 });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A REST call to the Mac's scratch Sova (loopback there), through ssh + curl. */
function macApi(method, path, body) {
  const r = mac(`curl -sS -m 10 -X ${method} -H 'x-sova-token: ${TOKEN_MAC}' -H 'content-type: application/json' ${body !== undefined ? "--data-binary @-" : ""} -w '\\n%{http_code}' http://127.0.0.1:${E.MAC_PORT}${path}`, { timeoutMs: 30_000, input: body !== undefined ? JSON.stringify(body) : undefined });
  const nl = r.out.lastIndexOf("\n");
  const status = Number(r.out.slice(nl + 1)) || 0;
  let json;
  try {
    json = JSON.parse(r.out.slice(0, nl));
  } catch {}
  return { status, json };
}
/** A REST call to the relay here. */
async function relayApi(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${E.RELAY_UI_PORT}${path}`, {
    method,
    headers: { "x-sova-token": TOKEN_RELAY, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, headers: res.headers };
}
async function waitFor(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ---- 1. the scratch checkout on the Mac ---------------------------------------------------------
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
console.log(`[mac-e2e] shipping ${head.slice(0, 12)} to the Mac's ~/${E.MAC_DIR}`);
const tmp = mkdtempSync(join(tmpdir(), "sova-mac-e2e-"));
const bundle = join(tmp, "head.bundle");
if (spawnSync("git", ["bundle", "create", bundle, "HEAD"], { cwd: ROOT, stdio: "ignore" }).status !== 0) die("git bundle failed");
if (spawnSync("scp", [...SSH_OPTS, bundle, `${E.MAC_SSH}:sova-dialout.bundle`], { stdio: "inherit" }).status !== 0) die("scp of the bundle failed");
rmSync(tmp, { recursive: true, force: true });
const setup = mac(`set -e; cd ~; rm -rf ${E.MAC_DIR}; git clone -q sova-dialout.bundle ${E.MAC_DIR}; rm -f sova-dialout.bundle; cd ${E.MAC_DIR}; git checkout -q ${head}; mise trust . >/dev/null; pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1; uname -sm; bun --version; node --version`);
check("scratch checkout and install on the Mac", setup.code === 0, setup.err.split("\n").slice(-3).join(" | "));
if (setup.code !== 0) process.exit(1);
console.log(`[mac-e2e] Mac: ${setup.out.split("\n").join(", ")}`);

if (!args.has("--skip-tests")) {
  const files = "server/mesh/lan-admission.test.ts server/mesh/lan-cert.test.ts server/mesh/lan-dialer.test.ts server/mesh/lan-fetch.test.ts server/mesh/lan-mesh.test.ts server/mesh/lan-peers.test.ts server/mesh/lan-relay-sessions.test.ts server/mesh/lan-relay.test.ts server/mesh/lan-reverse.test.ts server/mesh/lan-tls.test.ts";
  const bun = mac(`cd ~/${E.MAC_DIR} && pnpm test -- ${files} server/bun-quirks-canary.test.ts 2>&1 | tail -15`);
  check("transport unit tests on the Mac, Bun", /0 fail/.test(bun.out) && bun.code === 0, bun.out.split("\n").filter((l) => /FAIL|fail\)/.test(l)).join(" | "));
  const node = mac(`cd ~/${E.MAC_DIR} && pnpm run test:node -- ${files} 2>&1 | tail -15`);
  check("transport unit tests on the Mac, Node", /ℹ fail 0/.test(node.out) && node.code === 0, node.out.split("\n").filter((l) => /✖|fail/.test(l)).slice(0, 3).join(" | "));
}

// ---- 2. the two servers -----------------------------------------------------------------------
const macAgent = `$HOME/${E.MAC_DIR}/.agent-dialout`;
const macStart = mac(
  `cd ~/${E.MAC_DIR} && HERMETIC_AGENT_DIR=${macAgent} SOVA_PORT=${E.MAC_PORT} node scripts/hermetic-agent-dir.mjs >/dev/null && ` +
    `(SOVA_TOKEN=${TOKEN_MAC} PORT=${E.MAC_PORT} HOST=127.0.0.1 PI_CODING_AGENT_DIR=${macAgent} nohup scripts/start-server.sh > ${macAgent}/server.log 2>&1 & echo $! > ${macAgent}/server.pid)`,
  { timeoutMs: 60_000 },
);
check("scratch Sova started on the Mac", macStart.code === 0, macStart.err);

const relayAgent = mkdtempSync(join(tmpdir(), "sova-dialout-relay-"));
spawnSync("node", ["scripts/hermetic-agent-dir.mjs"], { cwd: ROOT, env: { ...process.env, HERMETIC_AGENT_DIR: relayAgent, SOVA_PORT: E.RELAY_UI_PORT }, stdio: "ignore" });
const relayProc = spawn("scripts/start-server.sh", [], {
  cwd: ROOT,
  env: { ...process.env, SOVA_TOKEN: TOKEN_RELAY, PORT: E.RELAY_UI_PORT, HOST: "127.0.0.1", PI_CODING_AGENT_DIR: relayAgent },
  stdio: ["ignore", "ignore", "ignore"],
});

async function teardown() {
  try {
    await relayApi("DELETE", "/api/mesh/lan/pairings/mac").catch(() => {});
  } finally {
    relayProc.kill("SIGTERM");
    mac(`kill $(cat ${macAgent}/server.pid) 2>/dev/null; ${args.has("--keep") ? "true" : `rm -rf ~/${E.MAC_DIR}`}`, { timeoutMs: 30_000 });
    rmSync(relayAgent, { recursive: true, force: true });
  }
}

try {
  const upMac = await waitFor("the Mac's Sova", () => macApi("GET", "/api/health").json?.ok, 90_000);
  const upRelay = await waitFor("the relay's Sova", async () => (await relayApi("GET", "/api/health")).json?.ok, 60_000);
  check("both servers answer", !!upMac && !!upRelay);
  if (!upMac || !upRelay) throw new Error("a server didn't start");

  // ---- 3. pairing ----------------------------------------------------------------------------
  const macFp = macApi("POST", "/api/mesh/lan/key").json?.fingerprint;
  const relayFp = (await relayApi("POST", "/api/mesh/lan/key")).json?.fingerprint;
  check("each side made its key", !!macFp && !!relayFp);
  const relaySet = await relayApi("PUT", "/api/mesh/lan/relay", { relay: { host: E.RELAY_IP, port: Number(E.RELAY_PORT) } });
  check("relay address set", relaySet.status === 200 && relaySet.json?.relay?.listening === false, `status ${relaySet.status}`);
  const acc = await relayApi("POST", "/api/mesh/lan/pairings", { id: "mac", label: "Mac", role: "accept", pin: macFp });
  check("relay accepts the Mac's fingerprint", acc.status === 200);
  check("relay listens once paired", !!(await waitFor("listening", async () => (await relayApi("GET", "/api/mesh/lan")).json?.relay?.listening)));
  const dial = macApi("POST", "/api/mesh/lan/pairings", { id: "relay", label: "Relay", role: "dial", pin: relayFp, host: E.RELAY_IP, port: Number(E.RELAY_PORT) });
  check("Mac pairs the relay", dial.status === 200);
  const both = (p) => p?.channels.answer.state === "connected" && p?.channels.ask.state === "connected";
  const macUp = await waitFor("the Mac's channels", () => both(macApi("GET", "/api/mesh/lan").json?.pairings?.find((p) => p.id === "relay")), 45_000);
  if (!macUp) {
    const p = macApi("GET", "/api/mesh/lan").json?.pairings?.find((x) => x.id === "relay");
    console.log(`[mac-e2e] the Mac's view: ${JSON.stringify(p?.channels)}`);
  }
  check("both channels up, seen from the Mac", !!macUp, "is the relay port open to the Mac? see README.md");
  check("both channels up, seen from the relay", !!(await waitFor("the relay's channels", async () => both((await relayApi("GET", "/api/mesh/lan")).json?.pairings?.find((p) => p.id === "mac")))));

  // ---- each direction under the answering host's grant -----------------------------------------
  const rowOn = async (side, id) => (side === "mac" ? macApi("GET", "/api/mesh/sessions").json : (await relayApi("GET", "/api/mesh/sessions")).json)?.peers?.find((p) => p.id === id);
  check("presence by default: the relay can't list the Mac's sessions", (await waitFor("hidden", async () => (await rowOn("relay", "mac"))?.state === "hidden")) !== null);
  check("presence by default: the Mac can't list the relay's sessions", (await waitFor("hidden", async () => (await rowOn("mac", "relay"))?.state === "hidden")) !== null);
  macApi("PUT", "/api/mesh/access", { peer: "relay", grant: { preset: "sessions" } });
  check("the Mac grants sessions: the relay lists them", (await waitFor("up", async () => (await rowOn("relay", "mac"))?.state === "up")) !== null);
  const hop = await relayApi("GET", "/peer/mac/api/sessions");
  check("the relay's /peer hop to the Mac answers, hardened", hop.status === 200 && /sandbox/.test(hop.headers.get("content-security-policy") ?? "") && hop.headers.get("x-content-type-options") === "nosniff", `status ${hop.status}`);
  check("grants are per direction: the Mac still can't list the relay's", (await rowOn("mac", "relay"))?.state === "hidden");
  await relayApi("PUT", "/api/mesh/access", { peer: "mac", grant: { preset: "sessions" } });
  check("the relay grants sessions: the Mac lists them over its ask channel", (await waitFor("up", async () => (await rowOn("mac", "relay"))?.state === "up")) !== null);

  // ---- removal ----------------------------------------------------------------------------------
  const t0 = Date.now();
  await relayApi("DELETE", "/api/mesh/lan/pairings/mac");
  const dropped = await waitFor("the Mac to lose its channel", () => macApi("GET", "/api/mesh/lan").json?.pairings?.find((p) => p.id === "relay")?.channels.ask.state !== "connected", 10_000);
  check("unpairing on the relay drops the Mac's connections at once", !!dropped && Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
  check("the relay stops listening", !!(await waitFor("closed", async () => (await relayApi("GET", "/api/mesh/lan")).json?.relay?.listening === false)));
} catch (err) {
  check("run", false, err.message);
} finally {
  await teardown();
}

console.log(`\n[mac-e2e] ${results.length - failures} of ${results.length} checks passed at ${head.slice(0, 12)}`);
process.exit(failures ? 1 : 0);
