#!/usr/bin/env node
// seed.mjs — write synthetic pi session files into a hermetic agent dir, so the Sova sidebar has
// a realistic, deterministic list to render.
//
// Usage: node seed.mjs --agent-dir <dir> [--sessions 480] [--cwds 40]
//
// Every session is a real session file the server's own parser understands: a v3 header, a
// model_change, a user message (what the list titles from) and an assistant reply with usage.
// mtimes are spread over ~2 weeks so the Archive's Today/Yesterday/… sections all appear. The
// paths, ids, cwds and mtimes are written to <agent-dir>/perf-load-seed.json for churn.mjs.
//
// Nothing is written outside <agent-dir>.

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const agentDir = args.get("agent-dir");
if (!agentDir) {
  console.error("usage: seed.mjs --agent-dir <dir> [--sessions N] [--cwds N]");
  process.exit(2);
}
const SESSIONS = Number(args.get("sessions") ?? 480);
const CWDS = Number(args.get("cwds") ?? 40);

const agent = resolve(agentDir);
const sessionsDir = join(agent, "sessions");
mkdirSync(join(sessionsDir, "live"), { recursive: true });

/** mulberry32 — small, fast, seeded, so a run is reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(0x5eed);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
const uuid = () => `0199${hex(4)}-${hex(4)}-7${hex(3)}-8${hex(3)}-${hex(12)}`;

const teams = ["platform", "web", "infra", "data", "tools"];
const apps = ["console", "gateway", "scheduler", "ledger", "search", "billing", "mailer", "router"];
const verbs = ["fix", "audit", "add", "refactor", "profile", "debug", "migrate", "document", "wire", "tune"];
const nouns = ["flow", "cache", "auth", "retry", "layout", "export", "sync", "index", "tokens", "errors"];
const cwds = Array.from({ length: CWDS }, (_, i) => `/work/${teams[i % teams.length]}/${apps[i % apps.length]}-${String(i).padStart(2, "0")}`);

const DAY = 86_400_000;
const now = Date.now();
const sessions = [];

for (let i = 0; i < SESSIONS; i++) {
  const cwd = cwds[i % cwds.length];
  const id = uuid();
  // createdAt is up to 14 days old; the file's mtime is always at or after it. Spreading both
  // means the list has sessions in every Archive date section and a stable folder count.
  const createdAgo = rand() * 14 * DAY;
  const activeAgo = createdAgo * rand();
  const createdAt = new Date(now - createdAgo).toISOString();
  const activeAt = new Date(now - activeAgo).toISOString();
  const title = `${pick(verbs)} ${pick(apps)} ${pick(nouns)} #${i}`;
  const dir = join(sessionsDir, `--${cwd.slice(1).replace(/\//g, "-")}--`);
  const path = join(dir, `${createdAt.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: createdAt, cwd },
    { type: "model_change", id: `m-${i}`, parentId: null, timestamp: createdAt, provider: "zai", modelId: "glm-5.3" },
    { type: "message", id: `u-${i}`, parentId: `m-${i}`, timestamp: createdAt, message: { role: "user", content: [{ type: "text", text: title }], timestamp: 0 } },
    {
      type: "message",
      id: `a-${i}`,
      parentId: `u-${i}`,
      timestamp: activeAt,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Done: ${title}.` }],
        provider: "zai",
        model: "glm-5.3",
        api: "openai-completions",
        stopReason: "stop",
        timestamp: 0,
        usage: { input: 120, output: 24, cacheRead: 0, cacheWrite: 0, totalTokens: 144, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    },
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(path, new Date(now - activeAgo), new Date(now - activeAgo));
  sessions.push({ path, id, cwd, createdAt, mtime: now - activeAgo, lastMessageId: `a-${i}` });
}

writeFileSync(join(agent, "perf-load-seed.json"), JSON.stringify({ cwds, sessions }, null, 0));
console.error(`[seed] ${sessions.length} sessions across ${cwds.length} cwds in ${sessionsDir}`);
