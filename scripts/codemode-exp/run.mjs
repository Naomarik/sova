#!/usr/bin/env node
// Codemode turns experiment: the same read-only task, in fresh chats on one model, with the codemode minor
// mode OFF vs ON, interleaved; per run it records model turns, tool calls (top-level and inside codemode
// scripts), token usage, wall time prompt→settle and correctness against a known answer. Drives a running
// Sova server over REST + /ws/chat (wire 2) and reads each session's JSONL. Builtins only, plus the repo's
// own `ws` package. See README.md beside this file.
//
//   node scripts/codemode-exp/run.mjs --port 4814 --agent tmp/codemode-exp/agent --runs 5
//   node scripts/codemode-exp/run.mjs --summarize docs/perf/data/codemode-turns
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

const { values: opt } = parseArgs({
  options: {
    port: { type: "string", default: "4814" },
    agent: { type: "string", default: "tmp/codemode-exp/agent" },
    runs: { type: "string", default: "5" },
    // off: codemode off; on: codemode on, same prompt; hint: codemode on and the prompt asks for it.
    arms: { type: "string", default: "off,on,hint" },
    model: { type: "string", default: "zai/glm-5.3" },
    // Outside the Sova tree by default: pi loads every AGENTS.md / CLAUDE.md from the cwd up to /, and
    // Sova's CLAUDE.md would add ~16k tokens of unrelated instructions to every run.
    "runs-dir": { type: "string", default: path.join(os.tmpdir(), "sova-codemode-exp") },
    out: { type: "string", default: "docs/perf/data/codemode-turns" },
    "timeout-s": { type: "string", default: "600" },
    retries: { type: "string", default: "2" },
    "keep-sessions": { type: "boolean", default: false },
    summarize: { type: "string" },
  },
});

// ---------------------------------------------------------------- fixture + answer key

const FIXTURE = {
  "package.json": `{ "name": "shop-backend", "version": "0.3.0", "type": "module", "main": "src/index.js" }\n`,
  "src/index.js": `import { getUser, listUsers } from "./api/users.js";
import { createOrder, cancelOrder } from "./api/orders.js";
import { ping } from "./api/health.js";
import { runCleanup } from "./jobs/cleanup.js";
import { buildReport, sendReport } from "./jobs/report.js";
import { syncAll } from "./jobs/sync.js";
import { login, logout } from "./auth/session.js";

export const routes = { getUser, listUsers, createOrder, cancelOrder, ping, login, logout };
export const jobs = { runCleanup, buildReport, sendReport, syncAll };
`,
  "src/lib/log.js": `// legacyLog is deprecated: new code should use modernLog.
export function legacyLog(level, msg) {
  process.stdout.write("[" + level.toUpperCase() + "] " + msg + "\\n");
}

export function modernLog(event, fields = {}) {
  process.stdout.write(JSON.stringify({ event, ...fields }) + "\\n");
}
`,
  "src/lib/config.js": `import { readFileSync } from "node:fs";

const files = ["config/app.json", "config/jobs.json"];
const merged = Object.assign({}, ...files.map((f) => JSON.parse(readFileSync(f, "utf8"))));

export const config = {
  get(key) {
    if (!(key in merged)) throw new Error("unknown config key " + key);
    return merged[key];
  },
  raw: merged,
};
`,
  "src/api/users.js": `import { legacyLog, modernLog } from "../lib/log.js";
import { config } from "../lib/config.js";

const db = new Map();

export function getUser(id) {
  legacyLog("debug", "getUser " + id);
  const user = db.get(id);
  if (!user) {
    legacyLog("warn", "no such user " + id);
    return null;
  }
  return user;
}

export function listUsers(page = 0) {
  const size = config.get("pageSize");
  modernLog("users.list", { page, size });
  return [...db.values()].slice(page * size, (page + 1) * size);
}
`,
  "src/api/orders.js": `import { legacyLog } from "../lib/log.js";
import { legacyLogger } from "../util/legacyLogger.js";
import { config } from "../lib/config.js";

export function createOrder(user, items) {
  if (items.length > config.get("maxOrderItems")) throw new Error("too many items");
  legacyLog("info", "order for " + user.id + " with " + items.length + " items");
  return { id: Date.now(), user: user.id, items };
}

export function cancelOrder(order) {
  legacyLogger("cancel " + order.id);
  order.cancelled = true;
  return order;
}
`,
  "src/api/health.js": `import { config } from "../lib/config.js";

export function ping() {
  return { ok: true, path: config.get("healthPath") };
}
`,
  "src/jobs/cleanup.js": `import { legacyLog } from "../lib/log.js";
import { config } from "../lib/config.js";

export function runCleanup(entries, now = Date.now()) {
  const maxAge = config.get("cleanupIntervalMin") * 60_000;
  legacyLog("info", "cleanup start: " + entries.length + " entries");
  let removed = 0;
  for (const e of entries) {
    if (now - e.at > maxAge) {
      removed++;
      legacyLog("debug", "removing " + e.id);
    }
  }
  legacyLog("info", "cleanup done: removed " + removed);
  return removed;
}
`,
  "src/jobs/report.js": `import { legacyLog, modernLog } from "../lib/log.js";
import { config } from "../lib/config.js";

const formatRow = (row) => {
  legacyLog("debug", "format row " + row.id);
  return row.id + "\\t" + row.total;
};

export function buildReport(rows) {
  legacyLog("info", "building report of " + rows.length + " rows");
  return rows.map(formatRow).join("\\n");
}

export function sendReport(text) {
  const to = config.get("reportRecipients");
  modernLog("report.send", { to, bytes: text.length });
  return to.length;
}
`,
  "src/jobs/sync.js": `import { modernLog } from "../lib/log.js";
import { config } from "../lib/config.js";
import { withRetry } from "../util/retry.js";

export async function syncAll(items, push) {
  const cfg = config.raw;
  const batch = cfg["syncBatchSize"];
  for (let i = 0; i < items.length; i += batch) {
    await withRetry(() => push(items.slice(i, i + batch)));
    modernLog("sync.batch", { from: i });
  }
}
`,
  "src/util/strings.js": `export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
`,
  "src/util/legacyLogger.js": `// Not the same thing as lib/log.js's legacyLog.
export function legacyLogger(msg) {
  console.log("legacy: " + msg);
}
`,
  "src/util/retry.js": `import { legacyLog } from "../lib/log.js";
import { config } from "../lib/config.js";

export async function withRetry(fn) {
  const max = config.get("maxRetries");
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= max) throw err;
      legacyLog("warn", "retry " + attempt + ": " + err.message);
    }
  }
}
`,
  "src/auth/session.js": `import { legacyLog, modernLog } from "../lib/log.js";
import { config } from "../lib/config.js";
import { TokenStore } from "./tokens.js";

const store = new TokenStore();

export function login(user, password) {
  if (password !== user.password) {
    legacyLog("warn", "bad password for " + user.id);
    return null;
  }
  legacyLog("info", "login " + user.id);
  return store.issue(user.id, config.get("sessionTtlSec"));
}

export function logout(token) {
  modernLog("auth.logout", { token: token.slice(0, 6) });
  store.revoke(token);
}
`,
  "src/auth/tokens.js": `import { legacyLog } from "../lib/log.js";
import { slug } from "../util/strings.js";

export class TokenStore {
  constructor() {
    this.tokens = new Map();
  }

  issue(userId, ttlSec) {
    const token = slug(userId + "-" + Math.random().toString(36).slice(2));
    this.tokens.set(token, Date.now() + ttlSec * 1000);
    return token;
  }

  rotate(token) {
    legacyLog("info", "rotating token");
    const exp = this.tokens.get(token);
    this.tokens.delete(token);
    return exp;
  }

  revoke(token) {
    this.tokens.delete(token);
  }
}
`,
  "config/app.json": `{
  "pageSize": 25,
  "maxOrderItems": 50,
  "healthPath": "/healthz",
  "sessionTtlSec": 3600,
  "maxRetries": 3
}
`,
  "config/jobs.json": `{
  "cleanupIntervalMin": 30,
  "reportRecipients": ["ops@example.com"],
  "syncBatchSize": 100,
  "archiveAfterDays": 90
}
`,
};

const KEY = {
  callers: [
    "src/api/users.js:getUser",
    "src/api/orders.js:createOrder",
    "src/jobs/cleanup.js:runCleanup",
    "src/jobs/report.js:formatRow",
    "src/jobs/report.js:buildReport",
    "src/util/retry.js:withRetry",
    "src/auth/session.js:login",
    "src/auth/tokens.js:rotate",
  ],
  total: 12,
  unusedKey: "archiveAfterDays",
};

const PROMPT = `This folder is a small JavaScript project. Read-only task, change nothing:
1. Find every function that calls \`legacyLog(\` (the function exported by src/lib/log.js) anywhere in the repo, and list them as file:function pairs (path relative to this folder; for a class method, just the method name).
2. Report the total number of \`legacyLog(\` call sites.
3. Tell me which config key in config/*.json is not used by any source file.

End your reply with exactly this block, filled in (callers separated by "; "):
ANSWER
callers: <file:function>; <file:function>; ...
total: <number>
unused_key: <key>`;

const HINT = "\n\nUse the codemode tool for this: one script can read and search many files at once.";
const promptFor = (arm) => (arm === "hint" ? PROMPT + HINT : PROMPT);

function writeFixture(dir) {
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(FIXTURE)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
}

export function grade(text) {
  const block = text.slice(text.lastIndexOf("ANSWER") >= 0 ? text.lastIndexOf("ANSWER") : 0);
  const field = (name) => block.match(new RegExp(`^\\W*${name}\\W*:\\s*(.+)$`, "im"))?.[1].trim().replace(/[`*]/g, "");
  const norm = (pair) => {
    let [file, fn] = pair.trim().replace(/^\.\//, "").split(/:(?=[^:]*$)/);
    if (!fn) return pair.trim();
    fn = fn.replace(/\(\)$/, "").replace(/^.*\./, "").trim(); // TokenStore.rotate -> rotate
    return `${file.trim()}:${fn}`;
  };
  const callers = (field("callers") ?? "").split(/;|,/).map((s) => s.trim()).filter(Boolean).map(norm);
  const got = new Set(callers);
  const want = new Set(KEY.callers);
  const missing = [...want].filter((c) => !got.has(c));
  const extra = [...got].filter((c) => !want.has(c));
  const total = Number((field("total") ?? "").match(/\d+/)?.[0]);
  const unused = (field("unused_key") ?? "").replace(/["']/g, "").trim();
  const callersOk = missing.length === 0 && extra.length === 0;
  const totalOk = total === KEY.total;
  const keyOk = unused === KEY.unusedKey;
  return { correct: callersOk && totalOk && keyOk, callersOk, totalOk, keyOk, missing, extra, total: Number.isFinite(total) ? total : null, unusedKey: unused || null, answerBlock: field("callers") !== undefined };
}

// ---------------------------------------------------------------- transcript metrics

export function metrics(lines) {
  const firstUser = lines.findIndex((e) => e.type === "message" && e.message.role === "user");
  const msgs = lines.slice(firstUser + 1).filter((e) => e.type === "message").map((e) => e.message);
  const assistants = msgs.filter((m) => m.role === "assistant");
  const toolCalls = assistants.flatMap((m) => m.content.filter((c) => c.type === "toolCall"));
  const byTool = {};
  for (const c of toolCalls) byTool[c.name] = (byTool[c.name] ?? 0) + 1;
  const results = msgs.filter((m) => m.role === "toolResult");
  const cm = results.filter((m) => m.toolName === "codemode");
  const nested = cm.flatMap((m) => m.details?.calls ?? m.details?.nestedCalls ?? []);
  const nestedByTool = {};
  for (const c of nested) nestedByTool[c.name] = (nestedByTool[c.name] ?? 0) + 1;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
  for (const m of assistants) {
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) usage[k] += m.usage?.[k] ?? 0;
    usage.cost += m.usage?.cost?.total ?? 0;
  }
  usage.cost = Number(usage.cost.toFixed(6));
  const last = assistants.at(-1);
  const finalText = last ? last.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
  return {
    turns: assistants.length,
    toolCalls: toolCalls.length,
    byTool,
    codemodeCalls: cm.length,
    codemodeErrors: cm.filter((m) => m.isError).length,
    nestedCalls: nested.length,
    nestedByTool,
    toolErrors: results.filter((m) => m.isError).length,
    usage,
    stopReasons: assistants.map((m) => m.stopReason),
    errorMessage: assistants.find((m) => m.stopReason === "error")?.errorMessage ?? null,
    finalText,
    scripts: cm.length ? toolCalls.filter((c) => c.name === "codemode").map((c) => c.arguments?.code ?? "") : [],
  };
}

// ---------------------------------------------------------------- summary

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x, d = 1) => (Number.isFinite(x) ? (Number.isInteger(x) ? String(x) : x.toFixed(d)) : "–");

export function summarize(runs) {
  const arms = [...new Set(runs.map((r) => r.arm))];
  const rows = [];
  const stats = {};
  for (const arm of arms) {
    const rs = runs.filter((r) => r.arm === arm);
    const col = (f) => rs.map(f);
    const s = (f) => ({ median: median(col(f)), mean: mean(col(f)) });
    stats[arm] = {
      n: rs.length,
      turns: s((r) => r.turns),
      toolCalls: s((r) => r.toolCalls),
      nestedCalls: s((r) => r.nestedCalls),
      inputTokens: s((r) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite),
      uncachedInput: s((r) => r.usage.input),
      outputTokens: s((r) => r.usage.output),
      cost: s((r) => r.usage.cost),
      wallS: s((r) => r.wallMs / 1000),
      correct: rs.filter((r) => r.grade.correct).length,
    };
    const st = stats[arm];
    const ms = (o, d) => `${fmt(o.median, d)} / ${fmt(o.mean, d)}`;
    rows.push(`| ${arm} | ${st.n} | ${ms(st.turns)} | ${ms(st.toolCalls)} | ${ms(st.nestedCalls)} | ${ms({ median: st.inputTokens.median / 1000, mean: st.inputTokens.mean / 1000 })} | ${ms({ median: st.uncachedInput.median / 1000, mean: st.uncachedInput.mean / 1000 })} | ${ms(st.outputTokens, 0)} | ${ms(st.cost, 4)} | ${ms(st.wallS)} | ${st.correct}/${st.n} |`);
  }
  const table = [
    "| arm | n | turns | top-level tool calls | calls inside scripts | input tok k (incl. cache) | uncached input k | output tok | cost $ | wall s | correct |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
  return { stats, table: `${table}\n\nEach cell: median / mean.` };
}

// ---------------------------------------------------------------- driver

if (opt.summarize) {
  const dir = path.resolve(ROOT, opt.summarize);
  const runs = readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
  console.log(summarize(runs.filter((r) => r.ok)).table);
  process.exit(0);
}

const require = createRequire(path.join(ROOT, "package.json"));
const WebSocket = require("ws");
const AGENT = path.resolve(ROOT, opt.agent);
const BASE = `http://127.0.0.1:${opt.port}`;
const COOKIE = `sova_token_${createHash("sha256").update(AGENT).digest("hex").slice(0, 8)}=${readFileSync(path.join(AGENT, "sova/auth-token"), "utf8").trim()}`;
const H = { Cookie: COOKIE, Origin: BASE, "Content-Type": "application/json" };
const OUT = path.resolve(ROOT, opt.out);
const RUNS_DIR = path.resolve(opt["runs-dir"]);
const TIMEOUT = Number(opt["timeout-s"]) * 1000;
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  let b;
  try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${t.slice(0, 300)}`);
  return b;
}

function connect(p) {
  const ws = new WebSocket(`ws://127.0.0.1:${opt.port}/ws/chat?path=${encodeURIComponent(p)}&wire=2`, { headers: { Cookie: COOKIE, Origin: BASE } });
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  return new Promise((res, rej) => { ws.on("open", () => res({ ws, frames })); ws.on("error", rej); });
}
const until = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
};
const events = (c) => c.frames.filter((f) => f.type === "event" && f.v === 2).map((f) => f.event);
const readLines = (p) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));

async function oneRun(id, arm) {
  const repo = path.join(RUNS_DIR, id, "repo");
  writeFixture(repo);
  const created = await api("POST", "/api/sessions", { cwd: repo });
  const sp = created.path ?? created.session?.path;
  const c = await connect(sp);
  try {
    await sleep(800);
    c.ws.send(JSON.stringify({ type: "set_model", ref: opt.model }));
    const modelId = opt.model.split("/").slice(1).join("/");
    await until(() => c.frames.some((f) => f.type === "model" && JSON.stringify(f).includes(modelId)), 20_000, "model");
    const mode = await api("POST", `/api/mode?path=${encodeURIComponent(sp)}`, { minorModes: arm === "off" ? [] : ["codemode"] });
    const from = events(c).length;
    const t0 = Date.now();
    c.ws.send(JSON.stringify({ type: "prompt", text: promptFor(arm) }));
    await until(() => events(c).slice(from).some((e) => e.type === "run.settled"), TIMEOUT, "run.settled");
    const wallMs = Date.now() - t0;
    await sleep(500); // the last entries reach the file
    const lines = readLines(sp);
    const m = metrics(lines);
    const declared = new Set();
    for (const e of lines) {
      const msg = e.type === "message" ? e.message : null;
      if (!msg || msg.role !== "system") continue;
      for (const t of msg.toolsRemoved ?? []) declared.delete(typeof t === "string" ? t : t.name);
      for (const t of msg.toolsAdded ?? []) declared.add(t.name);
    }
    const ok = !m.stopReasons.includes("error") && m.stopReasons.at(-1) === "stop";
    return { id, arm, ok, session: sp, model: opt.model, minorModes: mode.minorModes ?? null, codemodeDeclared: declared.has("codemode"), wallMs, ...m, grade: grade(m.finalText) };
  } finally {
    c.ws.close();
    if (!opt["keep-sessions"]) await api("POST", "/api/sessions/archive", { path: sp, archived: true }).catch((e) => log("archive failed", e.message));
  }
}

mkdirSync(OUT, { recursive: true });
const N = Number(opt.runs);
const arms = opt.arms.split(",");
const all = [];
const attempts = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
for (let i = 1; i <= N; i++) {
  const order = arms.map((_, k) => arms[(k + i - 1) % arms.length]); // interleave, rotating which arm goes first
  for (const arm of order) {
    for (let attempt = 0; attempt <= Number(opt.retries); attempt++) {
      const id = `${stamp}-${String(i).padStart(2, "0")}-${arm}${attempt ? `-retry${attempt}` : ""}`;
      log(`run ${id} …`);
      let r;
      try {
        r = await oneRun(id, arm);
      } catch (err) {
        r = { id, arm, ok: false, error: String(err?.message ?? err) };
      }
      r.attempt = attempt;
      writeFileSync(path.join(OUT, `run-${id}.json`), JSON.stringify({ ...r, prompt: promptFor(arm) }, null, 2) + "\n");
      attempts.push({ id, arm, ok: r.ok, error: r.error ?? r.errorMessage ?? null });
      if (r.ok) {
        all.push(r);
        log(`  ${arm}: turns ${r.turns}, tools ${r.toolCalls} (nested ${r.nestedCalls}), in ${r.usage.input}+${r.usage.cacheRead}c, out ${r.usage.output}, ${(r.wallMs / 1000).toFixed(1)}s, correct ${r.grade.correct}`);
        break;
      }
      log(`  failed: ${r.error ?? r.errorMessage ?? r.stopReasons}; retrying after 30 s`);
      await sleep(30_000);
    }
  }
}
const { stats, table } = summarize(all);
writeFileSync(path.join(OUT, `summary-${stamp}.json`), JSON.stringify({ stamp, model: opt.model, runs: N, arms, attempts, stats, key: KEY }, null, 2) + "\n");
console.log(table);
