#!/usr/bin/env node
// M3 login-sync scenarios against the running mesh lab, driven from the laptop through
// `scripts/mesh-lab/lab exec` (no chaos: nothing here kills or partitions a node).
//
//   node scripts/mesh-lab/mock-token-server/m3-drive.mjs [h1|h2|h2c|h6|h6c|h9|all] [--hosts a,b,c]
//
// Needs the lab's mock token server (laptop http://127.0.0.1:4888, MOCK_TOKEN_URL inside hosts)
// and SOVA_SYNC_CLAUDE_DIR in the hosts for the Claude scenarios. Hosts are compared by sha256 of
// the refresh token they hold against the mock's CURRENT token for the lineage; no token is ever
// printed. c-lite is live (90 s tokens: the origin refreshes about every 45 s), so "converged"
// means "every host holds the lineage's current token", polled until it holds.

import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const ALL = { h1, h2, h2c, h6, h6c, h9 };
const run = which === "all" ? Object.keys(ALL) : which.split(",");
for (const name of run) {
  if (!ALL[name]) {
    console.error(`unknown scenario ${name}; one of ${Object.keys(ALL).join(", ")}, all`);
    process.exit(2);
  }
  await scenario(name, ALL[name]);
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
