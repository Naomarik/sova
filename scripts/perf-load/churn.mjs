#!/usr/bin/env node
// churn.mjs — keep the seeded list moving, the way running agents do.
//
// Usage: node churn.mjs --agent-dir <dir> [--rate 1] [--live 360]
//
// Two things move, both of which the server notices:
//   - a message line is appended to a seeded session file every ~1/rate seconds (the file's mtime
//     is `lastActiveAt`, so the row changes);
//   - a set of fake live records under <agent-dir>/sessions/live/ flips between working and idle.
//     churn's own pid is the writer, and pid is alive, so server/live.ts keeps the records. Each
//     rewrite is temp+rename, and every record is heartbeated every 3 s (SCHEMA.md §1).
//
// The live records are what server/session-feed.ts turns into `list_changed`: rowSignature() reads
// live.status, live.busy and activity.state, and appending changes lastActiveAt. Nothing here
// touches ~/.pi: every path is under the agent dir churn was given.
//
// SIGTERM/SIGINT removes the live records churn owns and exits.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const agentDir = args.get("agent-dir");
if (!agentDir) {
  console.error("usage: churn.mjs --agent-dir <dir> [--rate N] [--live N]");
  process.exit(2);
}
const agent = resolve(agentDir);
const rate = Math.max(0.25, Number(args.get("rate") ?? 1));
const liveCount = Number(args.get("live") ?? 360);

const manifest = JSON.parse(readFileSync(join(agent, "perf-load-seed.json"), "utf8"));
const sessions = manifest.sessions;
const liveDir = join(agent, "sessions", "live");
mkdirSync(liveDir, { recursive: true });

const pid = process.pid;
const hex8 = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
const live = sessions.slice(0, liveCount).map((s) => ({ ...s, liveId: `p${pid}-${hex8()}` }));
const busy = new Uint8Array(live.length);
const lastLine = new Map(sessions.map((s) => [s.path, s.lastMessageId]));
let msgSeq = 0;

/** One live record; `session.id` equals the file stem, which SCHEMA.md §1 makes the identity. */
function recordOf(entry, working) {
  const t = Date.now();
  return {
    v: 1,
    schemaVersion: 2,
    session: {
      id: entry.liveId,
      cwd: entry.cwd,
      model: "zai/glm-5.3",
      pid,
      startedAt: entry.mtime,
      lastActivity: t,
      sessionId: entry.id,
      sessionFile: entry.path,
      mode: "tui",
      host: "perf-load",
      piVersion: "0.87.1",
    },
    presence: {
      type: "presence",
      version: 1,
      status: working ? "Running: bash" : "Idle",
      since: t,
      completed: 0,
      preview: working ? "working on it" : "idle",
      workers: [],
      activity: { state: working ? "working" : "idle", since: t },
      workerCounts: { total: 0, working: working ? 1 : 0, waiting: 0, done: 0, error: 0, killed: 0 },
    },
    heartbeat: t,
  };
}

function writeLive(entry, working) {
  const file = join(liveDir, `${entry.liveId}.json`);
  const tmp = join(liveDir, `.${entry.liveId}.${pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(recordOf(entry, working)));
  renameSync(tmp, file);
}

/** Append a real assistant line, chained to the file's current leaf so the transcript stays one branch. */
function appendLine(entry) {
  const id = `c-${pid}-${msgSeq++}`;
  const line = {
    type: "message",
    id,
    parentId: lastLine.get(entry.path) ?? null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: `churn ${msgSeq}` }],
      provider: "zai",
      model: "glm-5.3",
      api: "openai-completions",
      stopReason: "stop",
      timestamp: 0,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  };
  try {
    writeFileSync(entry.path, JSON.stringify(line) + "\n", { flag: "a" });
    lastLine.set(entry.path, id);
  } catch {
    // a session removed under us: skip
  }
}

let cursor = 0;
const appendTimer = setInterval(() => {
  const entry = sessions[cursor++ % sessions.length];
  appendLine(entry);
}, Math.max(250, Math.round(1000 / rate)));

let flipCursor = 0;
const flipTimer = setInterval(() => {
  for (let n = 0; n < 24 && live.length; n++) {
    const i = flipCursor++ % live.length;
    busy[i] ^= 1;
    writeLive(live[i], busy[i] === 1);
  }
}, 1000);

const heartbeat = setInterval(() => {
  for (let i = 0; i < live.length; i++) writeLive(live[i], busy[i] === 1);
}, 3000);

let stopped = false;
function cleanup() {
  if (stopped) return;
  stopped = true;
  clearInterval(appendTimer);
  clearInterval(flipTimer);
  clearInterval(heartbeat);
  for (const e of live) {
    try {
      unlinkSync(join(liveDir, `${e.liveId}.json`));
    } catch {
      // already gone
    }
  }
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// Write once up front so the records exist the moment the server first lists.
for (let i = 0; i < live.length; i++) writeLive(live[i], false);
console.error(`[churn] pid=${pid} live=${live.length} rate=${rate}/s`);
