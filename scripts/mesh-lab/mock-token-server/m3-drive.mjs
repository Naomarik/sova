#!/usr/bin/env node
// M3 login-sync scenarios against the running mesh lab, driven from the laptop through
// `scripts/mesh-lab/lab`. `all` runs the non-chaos ones; `chaos` (h3,h4,h7,h8,h10) partitions a
// node (h3) or stops only its Sova (h4, h7, h10) through the lab's own commands, always undoing it
// in a finally. `conflict` stops two hosts' Sova to plant different pre-sync keys, then settles the
// conflict through the Mesh page's routes (GET /api/mesh/logins, POST /api/mesh/logins/claim).
//
//   node scripts/mesh-lab/mock-token-server/m3-drive.mjs [h1|h2|h2c|h6|h6c|h9|all|h3|h4|h7|h8|h10|chaos|h11|conflict|conflict-verify|conflict-clean] [--hosts a,b,c] [--plant-only]
//   (h11 is meant for an 8-host lab: --hosts a,b,c,d,e,f,g,h; M3_H11_SECONDS sets its length)
//
// Needs the lab's mock token server (laptop http://127.0.0.1:4888, MOCK_TOKEN_URL inside hosts)
// and SOVA_SYNC_CLAUDE_DIR in the hosts for the Claude scenarios. Hosts are compared by sha256 of
// the refresh token they hold against the mock's CURRENT token for the lineage; no token is ever
// printed. c-lite is live (90 s tokens: the origin refreshes about every 45 s), so "converged"
// means "every host holds the lineage's current token", polled until it holds.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN, PEER_PORT, PORTS } from "../lab.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB = resolve(HERE, "../lab");
const MOCK = process.env.MOCK_LAPTOP_URL ?? "http://127.0.0.1:4888";
const args = process.argv.slice(2);
const hostsArg = args.indexOf("--hosts");
const HOSTS = hostsArg >= 0 ? args[hostsArg + 1].split(",") : ["a", "b", "c"];
const which = args.find((a) => !a.startsWith("--") && a !== (hostsArg >= 0 ? args[hostsArg + 1] : "")) ?? "all";

// ---- in-host probes (node ESM, resolved from /sova; secrets never leave the container) ----------

const PROBE = String.raw`
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const sha = (s) => (s ? createHash("sha256").update(String(s)).digest("hex") : null);
const authPath = join(process.env.PI_CODING_AGENT_DIR, "auth.json");
const pi = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const load = async () => (await import(pathToFileURL(join(pi, "..", "core", "auth-storage.js")).href)).AuthStorage;
const [cmd, a1, a2] = JSON.parse(process.env.M3_ARGS);
const readAuth = () => { try { return JSON.parse(readFileSync(authPath, "utf8")); } catch (e) { return { __invalid: String(e.code ?? "json") }; } };
const out = {};
if (cmd === "pi-state") {
  const d = readAuth(); const e = d[a1];
  Object.assign(out, { invalid: d.__invalid ?? null, present: !!e, refreshSha: sha(e?.refresh ?? e?.key), expires: e?.expires ?? null });
} else if (cmd === "pi-refresh") {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const rt = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  try { await rt.getAuth(a1); out.outcome = "ok"; } catch (e) { out.outcome = "failed"; out.why = String(e.message).slice(0, 120); }
} else if (cmd === "pi-delete") {
  await (await load()).create(authPath).delete(a1); out.deleted = a1;
} else if (cmd === "pi-set-key") {
  await (await load()).create(authPath).modify(a1, async () => ({ type: "api_key", key: a2 })); out.set = a1;
} else if (cmd === "torn-add-key") {
  // A careless writer: no lock, truncate, then one byte at a time.
  const d = readAuth(); d[a1] = { type: "api_key", key: a2 };
  const s = JSON.stringify(d, null, 2); const fd = openSync(authPath, "w");
  for (const ch of s) { writeSync(fd, ch); await new Promise((r) => setTimeout(r, 2)); }
  closeSync(fd); out.written = s.length;
}
console.log(JSON.stringify(out));
`;

function inHost(host, cmd, ...rest) {
  const b64 = Buffer.from(PROBE).toString("base64");
  const file = `/sova/.m3-probe-${process.pid}.mjs`;
  const script = `echo ${b64} | base64 -d > ${file} && cd /sova && M3_ARGS='${JSON.stringify([cmd, ...rest]).replace(/'/g, "'\\''")}' node ${file}; rc=$?; rm -f ${file}; exit $rc`;
  const r = spawnSync(LAB, ["exec", host, "sh", "-c", script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${host} ${cmd}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
const inHostAsync = (host, cmd, ...rest) =>
  new Promise((ok, fail) => {
    const b64 = Buffer.from(PROBE).toString("base64");
    const file = `/sova/.m3-probe-${process.pid}-${host}.mjs`;
    const script = `echo ${b64} | base64 -d > ${file} && cd /sova && M3_ARGS='${JSON.stringify([cmd, ...rest])}' node ${file}; rc=$?; rm -f ${file}; exit $rc`;
    const p = spawn(LAB, ["exec", host, "sh", "-c", script]);
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.on("exit", (c) => (c === 0 ? ok(JSON.parse(o.trim().split("\n").at(-1))) : fail(new Error(`${host} ${cmd} exit ${c}`))));
  });

function sh(host, script) {
  const r = spawnSync(LAB, ["exec", host, "sh", "-c", script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${host}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout.trim();
}
const shAsync = (host, script) =>
  new Promise((ok, fail) => {
    const p = spawn(LAB, ["exec", host, "sh", "-c", script]);
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.on("exit", (c) => (c === 0 ? ok(o.trim()) : fail(new Error(`${host} exit ${c}`))));
  });
const claudeSim = (host, cmd, extra = "") =>
  JSON.parse(sh(host, `cd /sova && node scripts/mesh-lab/mock-token-server/claude-sim.mjs ${cmd} --dir "$SOVA_SYNC_CLAUDE_DIR" --mock "$MOCK_TOKEN_URL" ${extra}`).split("\n").at(-1));

const mock = async (path) => (await fetch(new URL(path, MOCK))).json();
const lineage = async (id) => (await mock("/mock/lineages"))[id];
/** The throwaway provider of the conflict scenarios; a fresh name has no logout history on the mesh. */
const CONFLICT_PROVIDER = process.env.M3_CONFLICT_PROVIDER ?? "m3conflict";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, cond, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await cond();
    if (last === true) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what} (last: ${JSON.stringify(last)})`);
}

/** Every host holds the lineage's CURRENT refresh token (pi entry `provider`). */
const piConverged = (id, provider = "openai-codex", hosts = HOSTS) => async () => {
  const want = (await lineage(id))?.refreshSha256;
  const got = Object.fromEntries(hosts.map((h) => [h, inHost(h, "pi-state", provider).refreshSha]));
  return Object.values(got).every((s) => s === want) || { want: want?.slice(0, 8), got: Object.fromEntries(Object.entries(got).map(([h, s]) => [h, s?.slice(0, 8) ?? null])) };
};
const piAbsent = (provider, hosts = HOSTS) => async () => hosts.every((h) => !inHost(h, "pi-state", provider).present) || "still present";
const claudeConverged = (id, hosts = HOSTS) => async () => {
  const want = (await lineage(id))?.refreshSha256;
  const got = Object.fromEntries(hosts.map((h) => [h, claudeSim(h, "status").refreshSha256 ?? null]));
  return Object.values(got).every((s) => s === want) || { want: want?.slice(0, 8), got };
};

const results = [];
async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, ...(note ? { note } : {}) });
    console.log(`✔ ${name} (${Date.now() - t0} ms)${note ? ` — ${note}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`✖ ${name}: ${e.message}`);
  }
}

// ---- scenarios ----------------------------------------------------------------------------------

async function h1() {
  const out = JSON.parse(sh(HOSTS[0], `cd /sova && node scripts/mesh-lab/mock-token-server/pi-login.mjs --mock "$MOCK_TOKEN_URL"`).split("\n").at(-1));
  await until("every host holds the new lineage", piConverged(out.lineage));
  for (const h of HOSTS) {
    const mode = sh(h, `stat -c %a "$PI_CODING_AGENT_DIR/auth.json"`);
    if (mode !== "600") throw new Error(`${h}: auth.json mode ${mode}`);
    const junk = sh(h, `ls -a "$PI_CODING_AGENT_DIR" | grep -E 'sova-sync|\\.tmp$|auth.json.lock' || true`);
    if (junk) throw new Error(`${h}: leftovers ${junk}`);
  }
  return `lineage ${out.lineage}`;
}

async function codexLineage() {
  const lins = await mock("/mock/lineages");
  const want = inHost(HOSTS[0], "pi-state", "openai-codex").refreshSha;
  const id = Object.keys(lins).find((k) => lins[k].refreshSha256 === want);
  if (!id) throw new Error("no current codex lineage on the first host (run h1 first)");
  return id;
}

async function h2() {
  const id = await codexLineage();
  await until("converged before", piConverged(id));
  const before = (await mock("/mock/events")).length;
  const [x, y] = await Promise.all([inHostAsync(HOSTS[0], "pi-refresh", "openai-codex"), inHostAsync(HOSTS[1], "pi-refresh", "openai-codex")]);
  const loser = x.outcome === "failed" ? HOSTS[0] : y.outcome === "failed" ? HOSTS[1] : null;
  if (loser && !inHost(loser, "pi-state", "openai-codex").present) throw new Error(`${loser} cleared its entry`);
  await until("every host on the latest token", piConverged(id), 30_000);
  const ev = (await mock("/mock/events")).slice(before).filter((e) => e.lineage === id);
  const ok = ev.filter((e) => e.outcome === "ok").length;
  const bad = ev.filter((e) => e.outcome === "invalid_grant").length;
  if (bad > ok) throw new Error(`more invalid_grants (${bad}) than refreshes (${ok})`);
  if (loser && inHost(loser, "pi-refresh", "openai-codex").outcome !== "ok") throw new Error(`${loser}'s next request still fails`);
  return `outcomes ${HOSTS[0]}=${x.outcome} ${HOSTS[1]}=${y.outcome}; mock: ${ok} ok, ${bad} invalid_grant (c-lite included)`;
}

async function h2c() {
  const { lineage: id } = claudeSim(HOSTS[0], "login");
  await until("Claude login on every host", claudeConverged(id));
  const [x, y] = await Promise.all(
    [HOSTS[0], HOSTS[1]].map((h) =>
      shAsync(h, `cd /sova && node scripts/mesh-lab/mock-token-server/claude-sim.mjs refresh --force --dir "$SOVA_SYNC_CLAUDE_DIR" --mock "$MOCK_TOKEN_URL"`).then(
        (o) => JSON.parse(o.split("\n").at(-1)).outcome,
      ),
    ),
  );
  if ([x, y].sort().join() !== "invalid_grant,ok") throw new Error(`outcomes ${x}, ${y}`);
  await until("every host back on the winner's lineage (the loser pulled)", claudeConverged(id), 30_000);
  return `outcomes ${HOSTS[0]}=${x} ${HOSTS[1]}=${y}`;
}

async function h6() {
  await codexLineage();
  inHost(HOSTS[0], "pi-delete", "openai-codex");
  await until("logout reached every host", piAbsent("openai-codex"));
  await sleep(2000);
  if (!(await piAbsent("openai-codex")())) throw new Error("an entry came back");
  const out = JSON.parse(sh(HOSTS[1], `cd /sova && node scripts/mesh-lab/mock-token-server/pi-login.mjs --mock "$MOCK_TOKEN_URL"`).split("\n").at(-1));
  await until("re-login resurrected everywhere", piConverged(out.lineage));
  return `new lineage ${out.lineage} from ${HOSTS[1]}`;
}

async function h6c() {
  const { lineage: id } = claudeSim(HOSTS[0], "login");
  await until("Claude login on every host", claudeConverged(id));
  claudeSim(HOSTS[0], "logout");
  await until("Claude logout everywhere", async () => HOSTS.every((h) => claudeSim(h, "status").state === "missing") || HOSTS.map((h) => claudeSim(h, "status").state));
  if (!(await lineage(id)).revoked) throw new Error("the refresh token was not revoked");
  return `lineage ${id} revoked`;
}

async function h9() {
  const key = `lab-fake-${Date.now()}`;
  const watcher = HOSTS[1];
  let torn = 0;
  const writing = inHostAsync(HOSTS[0], "torn-add-key", "labtorn", key);
  let done = false;
  void writing.then(() => (done = true), () => (done = true));
  while (!done) {
    const s = inHost(watcher, "pi-state", "labtorn");
    if (s.invalid) torn++;
    await sleep(100);
  }
  if (torn) throw new Error(`${watcher} saw an unparsable auth.json ${torn} times`);
  const want = (await import("node:crypto")).createHash("sha256").update(key).digest("hex");
  await until("the complete write reached every host", async () => HOSTS.every((h) => inHost(h, "pi-state", "labtorn").refreshSha === want) || "not yet");
  inHost(HOSTS[0], "pi-delete", "labtorn");
  await until("test key removed everywhere", piAbsent("labtorn"));
  return "peers never saw a torn file; the final one arrived";
}

// ---- chaos (lab partition/restore, sova-stop/start) ---------------------------------------------

function lab(...a) {
  const r = spawnSync(LAB, a, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`lab ${a.join(" ")}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return r.stdout.trim();
}
async function partitioned(host, fn) {
  lab("partition", host);
  try {
    return await fn();
  } finally {
    lab("restore", host);
  }
}
/** The origin a host's sidecar records for a key (metadata, no secret). */
const originOn = (host, key) =>
  JSON.parse(sh(host, `cat "$PI_CODING_AGENT_DIR/sova/login-sync.json"`)).records?.[key]?.meta?.origin ?? null;
async function freshLineage(host) {
  const out = JSON.parse(sh(host, `cd /sova && node scripts/mesh-lab/mock-token-server/pi-login.mjs --mock "$MOCK_TOKEN_URL"`).split("\n").at(-1));
  await until("new lineage everywhere", piConverged(out.lineage));
  return out.lineage;
}

async function h3() {
  const [a, b, c] = HOSTS;
  const id = await freshLineage(a);
  const outcomes = await partitioned(a, async () => {
    const r = await Promise.all([inHostAsync(b, "pi-refresh", "openai-codex"), inHostAsync(c, "pi-refresh", "openai-codex")]);
    await until("b and c converge while a is away", piConverged(id, "openai-codex", [b, c]), 30_000);
    return r.map((x) => x.outcome);
  });
  await until("a catches up after restore", piConverged(id), 60_000);
  const origins = HOSTS.map((h) => originOn(h, "pi:openai-codex"));
  if (new Set(origins).size !== 1 || origins[0] === a) throw new Error(`origins ${origins.join(",")}`);
  return `b=${outcomes[0]} c=${outcomes[1]}; new origin ${origins[0]} on every host`;
}

/**
 * A host that "misses" updates: only its Sova is stopped, so pi on it still reaches the mock (a
 * `lab partition` would cut it off the mock too, and no refresh could happen there at all).
 */
async function sovaDown(host, fn) {
  lab("sova-stop", host);
  try {
    return await fn();
  } finally {
    lab("sova-start", host);
  }
}

async function h4() {
  const [a, , c] = HOSTS;
  const id = await freshLineage(a);
  await sovaDown(c, async () => {
    for (let i = 0; i < 2; i++) if (inHost(a, "pi-refresh", "openai-codex").outcome !== "ok") throw new Error("a's refresh failed");
    await until("a and b on the latest", piConverged(id, "openai-codex", HOSTS.filter((h) => h !== c)));
    sh(c, `touch -d '+1 hour' "$PI_CODING_AGENT_DIR/auth.json"`); // the stale file looks newest
    const r = inHost(c, "pi-refresh", "openai-codex");
    if (r.outcome !== "failed" || !/invalid_grant|400/.test(r.why ?? "")) throw new Error(`c's stale refresh: ${r.outcome} ${r.why ?? ""}`);
  });
  await until("c adopts the latest; nobody took c's stale entry", piConverged(id), 90_000);
  return "c's rotated-away token failed with invalid_grant, its newer mtime won nothing, c adopted the latest (clock skew: unit tests; the lab shares one kernel clock)";
}

async function h7() {
  const [a, , c] = HOSTS;
  await freshLineage(a);
  await sovaDown(c, async () => {
    inHost(a, "pi-delete", "openai-codex");
    await until("logged out on the hosts that were up", piAbsent("openai-codex", HOSTS.filter((h) => h !== c)));
    const r = inHost(c, "pi-refresh", "openai-codex");
    if (r.outcome !== "ok") throw new Error(`c's refresh ${r.outcome} (${r.why ?? ""})`);
  });
  await until("c is logged out too once back (a refresh is not a login)", piAbsent("openai-codex"), 90_000);
  await sleep(3000);
  if (!(await piAbsent("openai-codex")())) throw new Error("the refreshed lineage came back");
  return "c's post-logout refresh was discarded everywhere";
}

async function h8() {
  const [a, , c] = HOSTS;
  const providers = (h) => sh(h, `node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.env.PI_CODING_AGENT_DIR+"/auth.json","utf8"))).sort().join())'`);
  const want = providers(a);
  sh(c, `rm "$PI_CODING_AGENT_DIR/auth.json"`);
  await until("c re-pulled every entry", async () => {
    try {
      return providers(c) === want || providers(c);
    } catch {
      return "no file yet";
    }
  }, 60_000);
  const keysA = want.split(",").map((p) => inHost(a, "pi-state", p).refreshSha);
  const keysC = want.split(",").map((p) => inHost(c, "pi-state", p).refreshSha);
  if (JSON.stringify(keysA) !== JSON.stringify(keysC)) throw new Error("c's entries differ from a's");
  if (providers(a) !== want) throw new Error("a lost entries: the delete was taken as a logout");
  return `c re-pulled ${want}`;
}

async function h10() {
  const [a, b] = HOSTS;
  const id = await freshLineage(a);
  lab("sova-stop", b);
  try {
    if (inHost(a, "pi-refresh", "openai-codex").outcome !== "ok") throw new Error("a's refresh failed");
  } finally {
    lab("sova-start", b);
  }
  await until("b pulls the newest lineage once it is back", piConverged(id), 90_000);
  return "b caught up after its restart";
}

/**
 * H11: many hosts (run with --hosts a,b,…,h on an 8-host lab), random Sova stops/starts and
 * concurrent refreshes for M3_H11_SECONDS (default 180). Invariant at every step: no running host
 * holds nothing while some host holds the lineage. At the end every host is started and all must
 * converge on the mock's latest token; then, left quiet, only one host (the origin) refreshes and no
 * refresh fails.
 */
async function h11() {
  const id = await freshLineage(HOSTS[0]);
  const seconds = Number(process.env.M3_H11_SECONDS ?? 180);
  const down = new Set();
  let seed = 11;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const end = Date.now() + seconds * 1000;
  let steps = 0;
  try {
    while (Date.now() < end) {
      steps++;
      const roll = rand();
      const h = pick(HOSTS);
      if (roll < 0.25 && down.size < HOSTS.length - 2) {
        if (down.has(h)) {
          lab("sova-start", h);
          down.delete(h);
        } else {
          lab("sova-stop", h);
          down.add(h);
        }
      } else {
        const who = HOSTS.filter(() => rand() < 0.3);
        await Promise.all(who.map((x) => inHostAsync(x, "pi-refresh", "openai-codex").catch(() => null)));
      }
      const up = HOSTS.filter((x) => !down.has(x));
      const present = up.map((x) => inHost(x, "pi-state", "openai-codex").present);
      if (present.some(Boolean) && !present.every(Boolean)) {
        // A host may be empty only transiently while an exchange is in flight: give it a moment.
        await sleep(3000);
        const again = up.map((x) => inHost(x, "pi-state", "openai-codex").present);
        if (again.some(Boolean) && !again.every(Boolean)) throw new Error(`step ${steps}: a running host holds nothing (${up.filter((_, i) => !again[i]).join(",")})`);
      }
      await sleep(1000);
    }
  } finally {
    for (const h of down) lab("sova-start", h);
  }
  await until("every host on the latest token", piConverged(id), 120_000);
  const chaos = await lineage(id);
  // During the chaos invalid_grants are expected and harmless: k hosts refreshing at once give one
  // winner and k-1 losers, and pi on a host whose Sova is stopped refreshes a token it can't hear
  // has rotated. What must hold is above (no running host ever empty, all converge) and below:
  // once quiet, only the origin refreshes (c-lite), and never with a stale token.
  const before = (await mock("/mock/events")).length;
  await sleep(Number(process.env.M3_H11_QUIET_SECONDS ?? 60) * 1000);
  const quiet = (await mock("/mock/events")).slice(before).filter((e) => e.lineage === id);
  const ok = quiet.filter((e) => e.outcome === "ok");
  const bad = quiet.filter((e) => e.outcome !== "ok");
  if (!ok.length) throw new Error("no c-lite refresh in the quiet period");
  if (bad.length) throw new Error(`${bad.length} failed refreshes once quiet (${[...new Set(bad.map((e) => e.ip))].join(",")})`);
  if (new Set(ok.map((e) => e.ip)).size !== 1) throw new Error(`more than one host refreshed once quiet: ${[...new Set(ok.map((e) => e.ip))].join(",")}`);
  await until("still converged after the quiet period", piConverged(id), 30_000);
  return `${steps} steps over ${seconds}s on ${HOSTS.length} hosts (chaos: ${chaos.refreshes} refreshes, ${chaos.invalidGrants} invalid_grant); quiet ${Math.round(Number(process.env.M3_H11_QUIET_SECONDS ?? 60))}s: ${ok.length} c-lite refresh(es) from one host, 0 failures`;
}

// ---- pre-sync conflict (first pairing), settled from the Mesh page's routes ----------------------

const mainApi = async (host, path, init) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.host(host)}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, text: await res.text() };
};
const loginRow = async (host, key) => JSON.parse((await mainApi(host, "/api/mesh/logins")).text).entries.find((e) => e.key === key);

/**
 * Two hosts hold different keys for one provider from before sync (sidecar gone, key written while
 * their Sova was stopped): each keeps its own and reports the other; nothing leaks through the
 * routes; a claim on a spreads a's key everywhere. The key is a throwaway and is logged out after.
 */
async function conflict() {
  const [a, b] = HOSTS;
  const provider = CONFLICT_PROVIDER;
  const key = `pi:${provider}`;
  const val = Object.fromEntries([a, b].map((h) => [h, `m3c-${h}-${randomBytes(6).toString("hex")}`]));
  const shaOf = (h) => inHost(h, "pi-state", provider).refreshSha;
  lab("sova-stop", a);
  try {
    lab("sova-stop", b);
    try {
      for (const h of [a, b]) {
        sh(h, `rm -f "$PI_CODING_AGENT_DIR/sova/login-sync.json"`);
        inHost(h, "pi-set-key", provider, val[h]);
      }
    } finally {
      lab("sova-start", b);
    }
  } finally {
    lab("sova-start", a);
  }
  const wantA = shaOf(a);
  const wantB = shaOf(b);
  await until(`${a} reports the conflict with ${b}`, async () => (await loginRow(a, key).catch(() => undefined))?.conflictWith?.includes(b) || "not yet", 60_000);
  await sleep(3000);
  // b notes it on its own next exchange with a (at most the 5-min reconcile): reported, not required (S1).
  const bSees = !!(await loginRow(b, key).catch(() => undefined))?.conflictWith?.includes(a);
  if (shaOf(a) !== wantA || shaOf(b) !== wantB) throw new Error("a host lost its own pre-sync key while in conflict");
  for (const h of HOSTS) {
    const body = (await mainApi(h, "/api/mesh/logins")).text;
    if (Object.values(val).some((v) => body.includes(v)) || /fingerprint|tombstone/.test(body)) throw new Error(`${h}: /api/mesh/logins leaks a key or internals`);
  }
  // A peer can't reach the routes through its listener (a's own browser routes are main-only).
  const viaPeer = sh(b, `curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST -H 'content-type: application/json' --data '{"key":"${key}"}' http://${a}.${DOMAIN}:${PEER_PORT}/api/mesh/logins/claim`);
  if (viaPeer !== "404" && viaPeer !== "403") throw new Error(`claim through a's peer listener answered ${viaPeer}`);
  // --plant-only: leave the conflict for a look at the Mesh page; settle it there, or run `conflict-clean`.
  if (args.includes("--plant-only")) return `planted: ${key} differs on ${a} and ${b}, ${a} lists ${b}; ${b} lists ${a}: ${bSees ? "yes" : "not yet"}; peer-listener claim ${viaPeer}`;
  const claimed = await mainApi(a, "/api/mesh/logins/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  if (claimed.status !== 200 || JSON.parse(claimed.text).ok !== true) throw new Error(`claim on a: ${claimed.status} ${claimed.text.slice(0, 120)}`);
  const t0 = Date.now();
  await until("every host holds a's key", async () => HOSTS.every((h) => shaOf(h) === wantA) || Object.fromEntries(HOSTS.map((h) => [h, shaOf(h)?.slice(0, 8) ?? null])), 30_000);
  const spread = Date.now() - t0;
  await until("no conflict left", async () => {
    const rows = await Promise.all(HOSTS.map((h) => loginRow(h, key)));
    return rows.every((r) => !r?.conflictWith) || rows.map((r) => r?.conflictWith ?? null);
  });
  // Clean up: log the throwaway key out everywhere.
  inHost(a, "pi-delete", provider);
  await until("the throwaway key is gone everywhere", piAbsent(provider));
  return `a and b kept their own keys, a listed b (b listed a: ${bSees ? "yes" : "not yet"}); claim on a → every host on a's key in ${spread} ms; peer-listener claim ${viaPeer}; no key/fingerprint in any body`;
}

/** After a claim made elsewhere (the Mesh page on the first host): every host on its key, no conflict left. */
async function conflictVerify() {
  const [a] = HOSTS;
  const key = `pi:${CONFLICT_PROVIDER}`;
  const want = inHost(a, "pi-state", CONFLICT_PROVIDER).refreshSha;
  if (!want) throw new Error(`${a} holds no ${CONFLICT_PROVIDER} key`);
  await until(`every host holds ${a}'s key`, async () => HOSTS.every((h) => inHost(h, "pi-state", CONFLICT_PROVIDER).refreshSha === want) || "not yet", 30_000);
  await until("no conflict left", async () => {
    const rows = await Promise.all(HOSTS.map((h) => loginRow(h, key)));
    return rows.every((r) => r && !r.conflictWith && r.origin === a && r.loginAt > 0) || rows.map((r) => [r?.origin, r?.loginAt, r?.conflictWith ?? null]);
  });
  return `every host on ${a}'s key, origin ${a}, a login made at the claim, no conflict`;
}

/** Log the throwaway conflict key out everywhere (after a --plant-only run). */
async function conflictClean() {
  const holders = HOSTS.filter((h) => inHost(h, "pi-state", CONFLICT_PROVIDER).present);
  for (const h of holders) inHost(h, "pi-delete", CONFLICT_PROVIDER);
  await until("the throwaway key is gone everywhere", piAbsent(CONFLICT_PROVIDER));
  return `logged out on ${holders.join(",") || "no host"}`;
}

const ALL = { conflict, "conflict-verify": conflictVerify, "conflict-clean": conflictClean, h1, h2, h2c, h6, h6c, h9, h3, h4, h7, h8, h10, h11 };
const GROUPS = { all: ["h1", "h2", "h2c", "h6", "h6c", "h9"], chaos: ["h3", "h4", "h7", "h8", "h10"] };
const run = GROUPS[which] ?? which.split(",");
for (const name of run) {
  if (!ALL[name]) {
    console.error(`unknown scenario ${name}; one of ${Object.keys(ALL).join(", ")}, all`);
    process.exit(2);
  }
  await scenario(name, ALL[name]);
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
