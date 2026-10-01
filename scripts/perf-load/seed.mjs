#!/usr/bin/env node
// seed.mjs — write synthetic pi session files into a hermetic agent dir, so the Sova sidebar has
// a realistic, deterministic list to render.
//
// Usage: node seed.mjs --agent-dir <dir> [--sessions 480] [--cwds 40] [--big 2] [--big-turns 300] [--overseer-big 5300]
//
// Every session is a real session file the server's own parser understands: a v3 header, a
// model_change, a user message (what the list titles from) and an assistant reply with usage.
// mtimes are spread over ~2 weeks so the Archive's Today/Yesterday/… sections all appear. The
// paths, ids, cwds and mtimes are written to <agent-dir>/perf-load-seed.json for churn.mjs.
// `--big N` adds N long sessions (`--big-turns` user/assistant pairs each) in their own folder,
// listed under `big` in that file: the probe's session-switch check opens them. churn never
// touches them.
//
// Nothing is written outside <agent-dir>.

import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const agentDir = args.get("agent-dir");
if (!agentDir) {
  console.error("usage: seed.mjs --agent-dir <dir> [--sessions N] [--cwds N]");
  process.exit(2);
}
const SESSIONS = Number(args.get("sessions") ?? 480);
const CWDS = Number(args.get("cwds") ?? 40);
const BIG = Number(args.get("big") ?? 0);
const BIG_TURNS = Number(args.get("big-turns") ?? 300);

const agent = resolve(agentDir);
const sessionsDir = join(agent, "sessions");
const liveDir = join(sessionsDir, "live");

/** True only for a .jsonl the harness itself wrote, under this agent's sessions dir. */
function insideSessions(p) {
  const r = resolve(p);
  return r.startsWith(sessionsDir + sep) && !r.startsWith(liveDir + sep) && r.endsWith(".jsonl");
}

/** A rerun must start from the same state: remove the previous run's seed files and churn live
    records, and nothing else. Both are named by the markers the harness writes. */
function cleanPrevious() {
  const liveMarker = join(agent, "perf-load-live.json");
  if (existsSync(liveMarker)) {
    try {
      const ids = JSON.parse(readFileSync(liveMarker, "utf8"));
      if (Array.isArray(ids)) for (const id of ids) {
        if (typeof id === "string" && /^p[0-9]+-[0-9a-f]+$/.test(id)) {
          try { unlinkSync(join(liveDir, `${id}.json`)); } catch { /* already gone */ }
        }
      }
    } catch { /* malformed marker: leave its files */ }
    try { unlinkSync(liveMarker); } catch { /* already gone */ }
  }
  const seedMarker = join(agent, "perf-load-seed.json");
  if (!existsSync(seedMarker)) return;
  let old = null;
  try { old = JSON.parse(readFileSync(seedMarker, "utf8")); } catch { /* malformed: leave files */ }
  const dirs = new Set();
  if (old && Array.isArray(old.sessions)) {
    for (const s of [...old.sessions, ...(Array.isArray(old.big) ? old.big : []), ...(Array.isArray(old.overseer) ? old.overseer : [])]) {
      if (!s || typeof s.path !== "string" || !insideSessions(s.path)) continue;
      dirs.add(dirname(s.path));
      try { unlinkSync(s.path); } catch { /* already gone */ }
    }
  }
  for (const d of dirs) {
    if (!resolve(d).startsWith(sessionsDir + sep)) continue;
    try { rmdirSync(d); } catch { /* not empty, or a real dir */ }
  }
  try { unlinkSync(seedMarker); } catch { /* already gone */ }
}
cleanPrevious();
mkdirSync(liveDir, { recursive: true });

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

// Long sessions for the switch check: many turns with a little markdown each, so a transcript is
// thousands of nodes and one that stays retained after a switch shows in the node count too.
const big = [];
// A real folder (the chat view refuses a session whose working directory is gone), inside the agent dir.
const bigCwd = join(agent, "perf-load-cwd");
if (BIG > 0) mkdirSync(bigCwd, { recursive: true });
for (let b = 0; b < BIG; b++) {
  const id = uuid();
  const at = now - 2 * DAY - b * 60_000; // older than the write guard's 2-minute "someone else is writing" window
  const createdAt = new Date(at).toISOString();
  const dir = join(sessionsDir, `--${bigCwd.slice(1).replace(/\//g, "-")}--`);
  const path = join(dir, `${createdAt.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: createdAt, cwd: bigCwd },
    { type: "model_change", id: `bm-${b}`, parentId: null, timestamp: createdAt, provider: "zai", modelId: "glm-5.3" },
  ];
  let parent = `bm-${b}`;
  for (let t = 0; t < BIG_TURNS; t++) {
    const u = `bu-${b}-${t}`;
    const a = `ba-${b}-${t}`;
    const text = t === 0 ? `big transcript ${String.fromCharCode(65 + b)}` : `step ${t}: ${pick(verbs)} the ${pick(nouns)}`;
    lines.push({ type: "message", id: u, parentId: parent, timestamp: createdAt, message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } });
    lines.push({
      type: "message",
      id: a,
      parentId: u,
      timestamp: createdAt,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Done with step ${t}.\n\n- ${pick(verbs)} **${pick(apps)}**\n- check \`${pick(nouns)}\`\n\nNext: ${pick(verbs)} ${pick(nouns)}.` }],
        provider: "zai",
        model: "glm-5.3",
        api: "openai-completions",
        stopReason: "stop",
        timestamp: 0,
        usage: { input: 120, output: 24, cacheRead: 0, cacheWrite: 0, totalTokens: 144, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    });
    parent = a;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(path, new Date(at), new Date(at));
  big.push({ path, id, cwd: bigCwd, createdAt, mtime: at });
}

// The switch check types a draft into A, and the server keeps drafts by session id (seeded ids
// repeat), so a rerun would open A with last run's draft already in the composer. Drop the big
// sessions' drafts, and nothing else, from the agent dir's draft store.
const draftsFile = join(agent, "sova", "drafts.json");
if (big.length && existsSync(draftsFile)) {
  try {
    const store = JSON.parse(readFileSync(draftsFile, "utf8"));
    if (store && typeof store.drafts === "object" && store.drafts) {
      for (const b of big) delete store.drafts[b.id];
      writeFileSync(draftsFile, JSON.stringify(store));
    }
  } catch { /* malformed: leave it */ }
}

// The Overseer, long (`--overseer-big <rows>`): a marked conversation of about that many rows,
// made current in overseer-state.json before the server starts (the server then finds it instead
// of creating one), with one earlier conversation of OVERSEER_EARLIER_ROWS in its history.
// `sova_card` calls c_1..c_40 sit in the first half; c_1..c_20 are reopened and c_21..c_30
// dropped later, still far above the tail, so each card's newest snapshot is well above the rows
// a capped view builds; c_31..c_40 stay open as created. The last reply names [c_35](#c_35).
const OVERSEER_ROWS = Number(args.get("overseer-big") ?? 0);
const OVERSEER_EARLIER_ROWS = 1500;
const overseer = [];
if (OVERSEER_ROWS > 0) {
  const ovCwd = join(agent, "sova", "overseer");
  mkdirSync(ovCwd, { recursive: true });
  const ovDir = join(sessionsDir, `--${ovCwd.slice(1).replace(/\//g, "-")}--`);
  mkdirSync(ovDir, { recursive: true });
  const usage = { input: 120, output: 24, cacheRead: 0, cacheWrite: 0, totalTokens: 144, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const asst = (content, stopReason, at) => ({ role: "assistant", content, provider: "zai", model: "glm-5.3", api: "openai-completions", stopReason, timestamp: at, usage });
  const iso = (ms) => new Date(ms).toISOString();
  const card = (n, phase, rev, at, extra = {}) => ({
    id: `c_${n}`,
    title: `Archive the finished ${pick(apps)} sessions (${n})`,
    detail: `Three sessions in ${pick(apps)} look done: merged, nothing running.`,
    options: [{ label: "Archive them", reply: `Archive the sessions on c_${n}.` }, { label: "Keep them" }],
    items: [],
    phase,
    rev,
    createdAt: iso(at),
    updatedAt: iso(at),
    ...extra,
  });
  /** One conversation of about `rows` rows; returns its path and id. */
  const writeConversation = (rows, label, endAgo, withCards) => {
    const id = uuid();
    const total = Math.ceil(rows / 3); // turns: a plain turn is 2 rows, a tool turn (every third) 5
    const startAt = now - endAgo - total * 60_000;
    const path = join(ovDir, `${iso(startAt).replace(/[:.]/g, "-")}_${id}.jsonl`);
    const lines = [
      { type: "session", version: 3, id, timestamp: iso(startAt), cwd: ovCwd },
      { type: "custom", customType: "sova-overseer", data: { v: 1 }, id: `ov-mark-${label}`, parentId: null, timestamp: iso(startAt) },
      { type: "model_change", id: `ov-m-${label}`, parentId: `ov-mark-${label}`, timestamp: iso(startAt), provider: "zai", modelId: "glm-5.3" },
    ];
    let parent = `ov-m-${label}`;
    let n = 0;
    const push = (message, at) => {
      const eid = `ov-${label}-${++n}`;
      lines.push({ type: "message", id: eid, parentId: parent, timestamp: iso(at), message });
      parent = eid;
      return eid;
    };
    // Turn index → what happens to a card there (c_N created; reopened; dropped).
    const plan = new Map();
    if (withCards) {
      for (let c = 1; c <= 40; c++) plan.set(Math.floor(total * (0.05 + (0.5 * (c - 1)) / 40)), { n: c, op: "create" });
      for (let c = 1; c <= 20; c++) plan.set(Math.floor(total * (0.62 + (0.06 * (c - 1)) / 20)), { n: c, op: "reopen" });
      for (let c = 21; c <= 30; c++) plan.set(Math.floor(total * (0.58 + (0.03 * (c - 21)) / 10)), { n: c, op: "drop" });
    }
    let rowCount = 0;
    for (let t = 0; t < total; t++) {
      const at = startAt + t * 60_000;
      const last = t === total - 1;
      push({ role: "user", content: [{ type: "text", text: t === 0 ? `overseer transcript ${label}` : `What about ${pick(apps)} ${pick(nouns)}? (${t})` }], timestamp: at }, at);
      rowCount++;
      const cardOp = plan.get(t);
      if (cardOp || t % 3 === 1) {
        const callId = `call-${label}-${t}`;
        let name = "sova_session";
        let details = { v: 1 };
        let args2 = { id: `s-${t}` };
        if (cardOp) {
          name = "sova_card";
          const c = cardOp.n;
          if (cardOp.op === "create") {
            details = { v: 1, card: card(c, "open", 1, at), changes: [{ kind: "created" }], line: "created" };
            args2 = { ops: [{ op: "create", title: `Archive the finished sessions (${c})` }] };
          } else if (cardOp.op === "reopen") {
            details = { v: 1, card: card(c, "open", 2, at), changes: [{ kind: "reopened" }], line: "reopened" };
            args2 = { card: `c_${c}`, ops: [{ op: "reopen" }] };
          } else {
            details = { v: 1, card: card(c, "dropped", 2, at, { droppedWhy: "The sessions were archived by hand." }), changes: [{ kind: "dropped" }], line: "dropped" };
            args2 = { card: `c_${c}`, ops: [{ op: "drop", reason: "The sessions were archived by hand." }] };
          }
        }
        push(asst([{ type: "text", text: `Checking ${pick(apps)} first.` }, { type: "toolCall", id: callId, name, arguments: args2 }], "toolUse", at + 1000), at + 1000);
        push({ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: `${name}: ok (${t})` }], details, isError: false, timestamp: at + 2000 }, at + 2000);
        rowCount += 3;
      }
      const text = last && withCards
        ? `Two cards still wait: [c_35](#c_35) and [c_1](#c_1).\n\n- ${pick(verbs)} **${pick(apps)}**\n- check \`${pick(nouns)}\``
        : `Looked at ${pick(apps)}: ${pick(verbs)} the ${pick(nouns)}.\n\n- ${pick(verbs)} **${pick(apps)}**\n- check \`${pick(nouns)}\`\n\nNext: ${pick(verbs)} ${pick(nouns)}.`;
      push(asst([{ type: "text", text }], "stop", at + 3000), at + 3000);
      rowCount++;
    }
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    // Older than the write guard's 2-minute window, so the chat opens writable.
    const mtime = new Date(now - endAgo);
    utimesSync(path, mtime, mtime);
    return { path, id, rows: rowCount };
  };
  const earlier = writeConversation(OVERSEER_EARLIER_ROWS, "earlier", 3 * DAY, false);
  const current = writeConversation(OVERSEER_ROWS, "current", 10 * 60_000, true);
  overseer.push({ ...current, current: true }, { ...earlier, current: false });
  mkdirSync(join(agent, "sova"), { recursive: true });
  writeFileSync(join(agent, "sova", "overseer-state.json"), JSON.stringify({ version: 1, current: current.id, history: [earlier.id] }, null, 2) + "\n");
}

writeFileSync(join(agent, "perf-load-seed.json"), JSON.stringify({ cwds, sessions, big, overseer }, null, 0));
console.error(
  `[seed] ${sessions.length} sessions across ${cwds.length} cwds${big.length ? `, ${big.length} big (${BIG_TURNS} turns)` : ""}` +
    `${overseer.length ? `, the Overseer (${overseer[0].rows} rows, earlier ${overseer[1].rows})` : ""} in ${sessionsDir}`,
);
