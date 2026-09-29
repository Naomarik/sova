#!/usr/bin/env node
// Mine real organization / project-overseer usage into scenario traces for the org-charts replay
// (server/org-charts-replay.ts). READ-ONLY over every source: it opens files and runs `git log`/
// `git show` only, and writes nothing but its own output directory.
//
//   node scripts/org-charts-mine.mjs --out <dir> [--since 2026-09-22] [--root <dir>]... [--fixtures <dir>]
//
// --root   a directory to search for Sova state roots (`<agent>/sova/orgs.json`); repeatable.
// --out    where the full traces go (real text kept: keep it OUTSIDE the repository).
// --fixtures  also write anonymized, minimized traces there (no names, ids, paths, hosts or text).
// --synthetic <dir>  write only the synthetic edge cases there (no corpus needed).
//
// A trace is the ordered events of one project: fact changes read from the workspace stores
// (baton.json, decisions.json, started.json, ideas, roster, holder, the host index), the overseer's
// turns and tool calls read from its session (with the level in force and whether the operator
// started the turn), the actions log's verdicts, and what the stores say happened in the end.
// Nothing here decides whether a chart agrees: the replay does that.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ---- args ----------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const many = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const OUT = resolve(opt("--out", join(homedir(), ".cache/org-charts/scenarios")));
const FIXTURES = opt("--fixtures", null);
const SINCE = opt("--since", new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10));
const ROOTS = many("--root").length ? many("--root") : [join(homedir(), ".cache"), join(homedir(), "webapps/.worktrees"), join(homedir(), ".pi/agent")];

// ---- small helpers -------------------------------------------------------------------------------

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const readLines = (f) => {
  try {
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const textOf = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c) => c.text ?? "").join("") : "");
const git = (cwd, ...a) => {
  try {
    return execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
};

/** Every `<x>/sova/orgs.json` under the roots (bounded depth, skipping node_modules and .git). */
function findStateRoots() {
  const out = new Set();
  const walk = (dir, depth) => {
    if (depth > 7) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git" || e.name === "sessions" || e.name === "extensions") continue;
      const p = join(dir, e.name);
      if (e.name === "sova" && existsSync(join(p, "orgs.json"))) out.add(real(p));
      else walk(p, depth + 1);
    }
  };
  for (const r of ROOTS) if (existsSync(join(r, "sova", "orgs.json"))) out.add(real(join(r, "sova")));
  for (const r of ROOTS) walk(r, 0);
  return [...out];
}

/** Session file by id: the workspace's sessions/ first, then the host's sessions tree. */
function sessionFile(wsDir, agentDirs, id) {
  if (!id) return null;
  const inWs = join(wsDir, "sessions");
  try {
    const f = readdirSync(inWs).find((n) => n.endsWith(`_${id}.jsonl`));
    if (f) return join(inWs, f);
  } catch {}
  for (const a of agentDirs) {
    const root = join(a, "sessions");
    let dirs = [];
    try {
      dirs = readdirSync(root);
    } catch {}
    for (const d of dirs) {
      try {
        const f = readdirSync(join(root, d)).find((n) => n.endsWith(`_${id}.jsonl`));
        if (f) return join(root, d, f);
      } catch {}
    }
  }
  return null;
}

// ---- classification of what the code said ---------------------------------------------------------

/** The kind of a refusal, by the code's own sentences (server/project-overseer-tools.ts). */
export function refusalKind(err) {
  const e = err ?? "";
  if (e.startsWith("This run was not started by the operator")) return "autonomy";
  if (/runs only in a turn the operator started|The to-do list is the operator's own/.test(e)) return "operator-only";
  if (e.startsWith("Today's allowance is used")) return "cap-day";
  if (e.startsWith("This message's allowance is used") || /per message from the operator/.test(e)) return "cap-message";
  if (/^Limit reached: .* (open|running|at once)/.test(e)) return "cap-open";
  if (/coding token budget is spent/.test(e)) return "budget-legacy";
  if (/^(Promoted \d+, refused \d+|\d+ refused)/.test(e)) return "per-id";
  return "validation";
}

/** A watch reason's typed kind and the entity it names (the sentences in server/project-overseer.ts). */
export function reasonKind(r) {
  const pats = [
    [/^The gathering session "(.*)" reached its goal\.$/, "gathering-done", true],
    [/^The gathering session "(.*)" was closed\.$/, "gathering-closed", false],
    [/^Someone was referred in "(.*)"/, "proposal", false],
    [/^The gathering session "(.*)" handed a question to the operator/, "asked-operator", true],
    [/^(\d+) new conflicts? between decisions\.$/, "conflict", false],
    [/^(\d+) conflicts? (was|were) resolved\.$/, "resolved", false],
    [/^The operator promoted (\d+) decisions? into the spec\.$/, "operator-promoted", true],
    [/^(\d+) decisions? (was|were) promoted into the spec\.$/, "promoted", false],
    [/^(\d+) decisions? (is|are) drafted and promotable\.$/, "drafted", false],
    [/^The coding session "(.*)" finished its turn\.$/, "turn-ended", true],
    [/^The coding session "(.*)" stopped with an error\.$/, "turn-failed", true],
    [/^The operator merged "(.*)" \((.*)\) into (.*)\.$/, "merged", true],
    [/^Merge Branch for "(.*)" was refused/, "merge-refused", true],
    [/^Today's looks are back/, "looks-back", true],
    [/^Today's allowance is back/, "allowance-back", true],
    [/^The operator's last message reached its limit/, "message-allowance-back", false],
    [/^You raised the limit on/, "limit-raised", true],
    [/^\(the operator asked for a look\)$/, "run-now", false],
    // Older builds' reasons (version drift: the current source never emits these).
    [/^A decision was recorded in "(.*)"\.$/, "drift:decision-recorded", false],
    [/^The operator queued a to-do item\.$/, "drift:todo-queued", false],
    [/^The operator added an idea\.$/, "drift:idea-added", false],
    [/^Left from the operator's last message: /, "drift:message-left", false],
  ];
  for (const [re, kind, soon] of pats) {
    const m = re.exec(r);
    if (m) return { kind, soon, ref: m[1] ?? null };
  }
  return { kind: "unknown", soon: false, ref: null };
}

const WATCH_PREFIX = "[project watch]";
const NUDGE = /^\[wake_nudge/;
const RELAY = /^From the user, via the Overseer:/;

/** One overseer session's turns: who started each, the level in force, the reasons, the tool calls. */
function turnsOf(file) {
  const entries = readLines(file);
  const turns = [];
  let level = null;
  let levelWhy = null;
  let cur = null;
  const calls = new Map();
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "system") {
      const s = JSON.stringify(m.sections ?? m.content ?? "");
      const lm = /Level in force now: \*\*(L[0-3])/.exec(s);
      if (lm) level = lm[1];
      const why = /Level in force now: \*\*L0[^*]*\*\*\.?\s*\(?([^\\"]{0,160})/.exec(s);
      levelWhy = /paused|attached on this host/i.test(s) && level === "L0" ? "paused" : /roster has no active people/i.test(s) && level === "L0" ? "empty-roster" : null;
      void why;
      continue;
    }
    if (m.role === "user") {
      const text = textOf(m).trim();
      const by = text.startsWith(WATCH_PREFIX) ? "watch" : NUDGE.test(text) ? "nudge" : RELAY.test(text) ? "relay" : "operator";
      const reasons = by === "watch" ? [...text.matchAll(/^- (.*)$/gm)].map((x) => x[1]).filter((x) => !x.startsWith("(")) : [];
      const levelInPrompt = by === "watch" ? (/act within your autonomy \((L[0-3])\)/.exec(text)?.[1] ?? null) : null;
      // A look starts only when the session is idle: a watch prompt after a turn with no end means that
      // turn was cut off (it ends just before). An operator's message mid-turn joins the running one.
      const isWatch = text.startsWith(WATCH_PREFIX);
      if (cur && !cur.stop && isWatch) Object.assign(cur, { stop: "aborted", endAt: new Date(ms(e.timestamp) - 1).toISOString(), error: "no end recorded" });
      const joins = cur && !cur.stop && !isWatch;
      // A wake nudge is unattended; an Overseer relay is attended only inside a turn the operator started.
      const attended = by === "operator" || (by === "relay" && !!joins && !!cur?.attended);
      cur = { at: e.timestamp, joins, by, attended, level: levelInPrompt ?? level, levelWhy, reasons, runAll: by === "watch" && /the operator asked for a look/.test(text), text: by === "watch" ? "" : text, calls: [], stop: null, error: null };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    if (m.role === "assistant") {
      for (const c of m.content ?? []) {
        if (c.type !== "toolCall") continue;
        const call = { id: c.id, at: e.timestamp, name: c.name, args: c.arguments ?? {}, result: null };
        calls.set(c.id, call);
        cur.calls.push(call);
      }
      if (m.stopReason && m.stopReason !== "toolUse") {
        cur.stop = m.stopReason;
        cur.error = m.errorMessage ?? null;
        cur.endAt = e.timestamp;
      }
    } else if (m.role === "toolResult") {
      const call = calls.get(m.toolCallId);
      if (call) call.result = { at: e.timestamp, isError: !!m.isError, text: textOf(m).slice(0, 2000) };
    }
  }
  return turns;
}

/** Running intervals and failures of a coding session, from its own file. */
function codingRuns(file) {
  const runs = [];
  let open = null;
  for (const e of readLines(file)) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "user" && !open) open = { from: e.timestamp, to: null, failed: false };
    // An assistant message with no user message before it: pi retried after an error, the run goes on.
    if (m.role === "assistant" && !open && runs.length) open = runs.pop();
    if (m.role === "assistant" && m.stopReason && m.stopReason !== "toolUse" && open) {
      open.to = e.timestamp;
      open.failed = m.stopReason === "error" || m.stopReason === "aborted";
      open.stop = m.stopReason;
      runs.push(open);
      open = null;
    }
  }
  if (open) runs.push(open);
  // A turn that ends and the next that starts at once (a queued message) never settled: one run.
  const merged = [];
  for (const r of runs) {
    const prev = merged.at(-1);
    if (prev?.to && ms(r.from) - ms(prev.to) < 2000) Object.assign(prev, { to: r.to, failed: r.failed, stop: r.stop });
    else merged.push({ ...r });
  }
  return merged;
}

/** sessionRef (server/overseer-tools.ts): an id, `s/<id>`, a sova:// link or a markdown link to one. */
function sessionRef(raw) {
  let t = typeof raw === "string" ? raw.trim() : "";
  const link = /^\[[^\]]*\]\(([^)\s]+)\)$/.exec(t);
  if (link) t = link[1];
  return t.replace(/^sova:\/\/s\//, "").replace(/^s\//, "") || null;
}

// ---- gap links (none exist in the stores: inferred, with evidence) -----------------------------------

const STOP = new Set("the a an and or of to in on for with is are be it its this that what how from at by as they their them we you your our not no which who when should would can may will each per so if into about".split(" "));
const words = (s) => new Set((s ?? "").toLowerCase().replace(/[^a-z0-9À-￿ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
function overlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/** The gap a gathering or build most plausibly serves: an explicit id in the text, then word overlap. */
function inferGap(allGaps, text, sameTurnGapIds, at) {
  // Only a gap filed by then can be what an act serves.
  const gaps = allGaps.filter((g) => !g.createdAt || g.createdAt <= at);
  const explicit = gaps.find((g) => text.includes(g.id) || text.includes(g.id.replace("§gap/", "")));
  if (explicit) return { gap: explicit.id, how: "named", score: 1 };
  let best = null;
  for (const g of gaps) {
    const s = overlap(`${g.title} ${g.text}`, text) + (sameTurnGapIds.has(g.id) ? 0.15 : 0);
    if (!best || s > best.score) best = { gap: g.id, how: "words", score: Math.round(s * 100) / 100 };
  }
  return best && best.score >= 0.25 ? best : { gap: null, how: "none", score: best?.score ?? 0 };
}

// ---- one project ---------------------------------------------------------------------------------

function mineProject({ orgId, wsDir, project, hosts }) {
  const pid = project.id;
  const pdir = join(wsDir, "projects", pid);
  const odir = join(pdir, "overseer");
  const agentDirs = hosts.map((h) => dirname(h.sova));
  const settings = readJson(join(odir, "overseer.json"));
  const state = readJson(join(odir, "state.json"));
  const actions = readLines(join(odir, "actions.jsonl"));
  const started = readJson(join(odir, "started.json"))?.sessions ?? [];
  const decisions = readJson(join(pdir, "decisions.json"))?.decisions ?? [];
  const conflicts = readJson(join(pdir, "conflicts.json"))?.conflicts ?? [];
  const manifest = readJson(join(odir, "ideas", "manifest.json"))?.ideas ?? {};
  const batons = (readJson(join(wsDir, "baton.json"))?.sessions ?? []).filter((b) => b.projectId === pid || b.owner?.overseerOf === pid);
  const roster = readJson(join(wsDir, "roster.json"))?.people ?? [];
  const rosterHistory = readLines(join(wsDir, "roster-history.jsonl"));

  const overseerIds = state ? [...(state.history ?? []), state.current].filter(Boolean) : [];
  // When the overseer's first conversation began: before it, today notes no reason (noteReason needs its state).
  // The earliest of its conversations: the state's history order is not the order they began in.
  const births = overseerIds.map((id) => sessionFile(wsDir, agentDirs, id)).filter(Boolean).map((f) => readLines(f)[0]?.timestamp).filter(Boolean);
  const bornAt = births.length ? births.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null;
  const turns = overseerIds.flatMap((id) => {
    const f = sessionFile(wsDir, agentDirs, id);
    return f ? turnsOf(f).map((t) => ({ ...t, session: id })) : [];
  });

  const gapText = (id) => {
    const f = join(odir, "ideas", ...id.replace(/^§/, "").split("/")) + ".md";
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  const gaps = Object.entries(manifest)
    .filter(([id, g]) => id.startsWith("§gap/") || g.tags?.includes("gap"))
    .map(([id, g]) => ({ id, title: g.title ?? "", status: g.status, links: g.links ?? [], createdAt: g.createdAt, updatedAt: g.updatedAt, text: gapText(id) }));

  const events = [];
  const push = (e) => events.push(e);

  // Settings and level changes: the workspace repo's history of overseer.json (read-only git).
  const rel = join("projects", pid, "overseer", "overseer.json");
  const log = git(wsDir, "log", "--reverse", "--format=%H %cI", "--", rel);
  let prevLevel = null;
  for (const line of (log ?? "").split("\n").filter(Boolean)) {
    const [sha, at] = line.split(" ");
    const s = JSON.parse(git(wsDir, "show", `${sha}:${rel}`) ?? "null");
    if (s?.autonomy && s.autonomy !== prevLevel) push({ t: at, kind: "setting", key: "autonomy", value: s.autonomy, src: "git", coarse: true });
    prevLevel = s?.autonomy ?? prevLevel;
  }

  if (bornAt) push({ t: bornAt, kind: "fact", entity: "overseer", id: "o", state: "exists" });
  // Roster: active people over time.
  for (const h of rosterHistory) if (h.field === "status") push({ t: h.at, kind: "fact", entity: "person", id: h.personId, status: h.to });

  // Gaps: filed, then every status the overseer set (tool calls), then the store's last word.
  for (const g of gaps) push({ t: g.createdAt, kind: "fact", entity: "gap", id: g.id, status: "open", src: "manifest" });

  // Batons of this project.
  for (const b of batons) {
    const by = b.owner === "operator" ? "operator" : "overseer";
    push({ t: b.createdAt, kind: "fact", entity: "baton", id: b.sessionId, state: "open", by, offer: !!b.offers?.length, settle: !!b.conflict });
    for (const h of b.handoffs ?? []) {
      if (h.n === 1) continue;
      push({ t: h.at, kind: "fact", entity: "baton", id: b.sessionId, state: h.to === "operator" ? "needs-you" : "open", src: "handoff" });
    }
    if (b.state === "done" || b.state === "closed") push({ t: b.closedAt ?? b.wroteAt ?? b.createdAt, kind: "fact", entity: "baton", id: b.sessionId, state: b.state, wrote: !!b.wroteAt });
    else if (b.state === "needs-you" && !(b.handoffs ?? []).some((h) => h.to === "operator")) push({ t: b.createdAt, kind: "fact", entity: "baton", id: b.sessionId, state: "needs-you", src: "final" });
  }

  // Decisions: recorded (pending), drafted (first reconcile after), promoted / superseded.
  const reconcileTimes = [
    ...actions.filter((a) => a.tool === "sova_reconcile" && a.outcome === "ok").map((a) => a.at),
    ...(readJson(join(pdir, "decisions.json"))?.lastRun?.at ? [readJson(join(pdir, "decisions.json")).lastRun.at] : []),
  ].sort();
  // A decision in a conflict: conflict from the conflict's creation (a reconcile run), its own state after it is settled.
  const conflictOf = new Map();
  for (const c of conflicts) for (const id of [c.a, c.b]) if (id && !conflictOf.has(id)) conflictOf.set(id, c);
  for (const d of decisions) {
    push({ t: d.at, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: "pending", ownerArea: d.authorOwnsArea ?? null });
    const cf = conflictOf.get(d.id);
    if (cf?.createdAt) {
      push({ t: cf.createdAt, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: "conflict", derived: "conflict-created" });
      if (cf.resolvedAt && d.state !== "conflict") push({ t: cf.resolvedAt, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: d.state === "promoted" ? "drafted" : d.state, ...(d.supersededBy ? { supersededBy: d.supersededBy } : {}), derived: "conflict-resolved" });
      if (d.promotedAt && d.promotedAt > (cf.resolvedAt ?? "")) push({ t: d.promotedAt, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: "promoted", build: d.build ?? null });
      continue;
    }
    const draftedAt = reconcileTimes.find((t) => t >= d.at) ?? null;
    if (["drafted", "promoted", "superseded", "conflict"].includes(d.state) && draftedAt && (!d.promotedAt || draftedAt <= d.promotedAt))
      push({ t: draftedAt, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: "drafted", derived: "reconcile-after" });
    if (d.state === "conflict") push({ t: draftedAt ?? d.at, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: "conflict", derived: "final" });
    if (d.promotedAt) push({ t: d.promotedAt, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: "promoted", build: d.build ?? null });
    if (d.state === "superseded" && d.supersededBy) push({ t: d.supersededAt ?? reconcileTimes.filter((t) => t >= d.at).at(-1) ?? d.at, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: "superseded", supersededBy: d.supersededBy, derived: d.supersededAt ? null : "last-reconcile" });
    else if (d.state === "superseded") push({ t: d.supersededAt ?? reconcileTimes.filter((t) => t >= d.at).at(-1) ?? d.at, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: "superseded", derived: d.supersededAt ? null : "last-reconcile" });
  }
  for (const c of conflicts) {
    push({ t: c.createdAt, kind: "fact", entity: "conflict", id: c.id, state: "open", settleBaton: c.batonSessionId ?? null });
    if (c.resolvedAt) push({ t: c.resolvedAt, kind: "fact", entity: "conflict", id: c.id, state: "resolved", outcome: c.outcome ?? null });
  }

  // Builds: coding sessions it (or the operator) started, their turns, merges, commits after merge.
  for (const s of started.filter((x) => x.kind === "coding" || x.kind === "operator-coding")) {
    // Every build fact names who started it (a first turn may be dated before the row).
    const startedBy = s.kind === "coding" ? "overseer" : "operator";
    push({ t: s.createdAt, kind: "fact", entity: "build", id: s.sessionId, by: startedBy, branch: !!s.worktree });
    const f = s.path && existsSync(s.path) ? s.path : sessionFile(wsDir, agentDirs, s.sessionId);
    for (const r of f ? codingRuns(f) : []) {
      push({ t: r.from, kind: "fact", entity: "build", id: s.sessionId, running: true, by: startedBy });
      if (r.to) push({ t: r.to, kind: "fact", entity: "build", id: s.sessionId, running: false, lastFailed: r.failed, stop: r.stop, by: startedBy });
    }
    if (s.merged?.at) push({ t: s.merged.at, kind: "fact", entity: "build", id: s.sessionId, merged: true, by: startedBy, mergedBy: "operator" });
    if (s.merged?.at && s.worktree?.path && existsSync(s.worktree.path)) {
      const after = git(s.worktree.path, "log", "--format=%cI", `${s.merged.commit}..HEAD`);
      const times = (after ?? "").split("\n").filter(Boolean).sort();
      if (times.length) push({ t: times[0], kind: "fact", entity: "build", id: s.sessionId, newSinceMerge: times.length });
    }
  }

  // The overseer's turns and tool calls, with the action log's verdict for each call.
  const byCall = new Map(actions.map((a) => [a.toolCallId, a]));
  const gapIdsSeen = new Set(gaps.map((g) => g.id));
  for (const t of turns) {
    push({ t: t.at, kind: "turn", ...(t.joins ? { joins: true } : {}), by: t.by, attended: t.attended, level: t.level, levelWhy: t.levelWhy, reasons: t.reasons.map((r) => ({ ...reasonKind(r), text: r })), runAll: t.runAll, text: t.text.slice(0, 400), session: t.session });
    const sameTurnGaps = new Set(t.calls.filter((c) => c.name === "sova_idea" && typeof c.args.id === "string").map((c) => c.args.id));
    for (const c of t.calls) {
      if (!c.name.startsWith("sova_")) continue;
      const a = byCall.get(c.id);
      const logged = a ? a.outcome : c.result ? (c.result.isError ? "error" : "ok") : "unanswered";
      // Older action logs wrote "ok" for a promote that refused some ids: its own answer says so.
      const verdict = c.name === "sova_promote" && logged === "ok" && /\brefused [1-9]/.test(c.result?.text ?? "") ? "partial" : logged;
      const error = a?.error ?? (c.result?.isError ? c.result.text : null);
      const step = { t: c.at, kind: "tool", name: c.name, attended: t.attended, level: t.level, verdict, refusal: verdict === "partial" ? "per-id" : verdict === "refused" || (verdict === "error" && error) ? refusalKind(error) : null, error: error ? error.slice(0, 300) : null, args: {} };
      // A cap refusal names its numbers: the replay's reconstructed counters are checked against them.
      if (step.refusal === "cap-day" || step.refusal === "cap-message") {
        const n = /: (\d+) of (\d+) /.exec(error ?? "") ?? /\((\d+) used; .*?\)/.exec(error ?? "");
        const max = /at most (\d+) /.exec(error ?? "")?.[1];
        if (n) step.cap = { used: +n[1], max: n[2] !== undefined ? +n[2] : max ? +max : null };
      }
      if (step.refusal === "cap-open") {
        const n = /(\d+) of (?:your|its) (gathering|coding) sessions? (?:are|is) (?:open|running|running or starting), and the limit is (\d+)/.exec(error ?? "");
        if (n) step.cap = { used: +n[1], max: +n[3], of: n[2] };
      }
      // The wrapper reads the level at call time; the turn's system message may be older (a level set mid-run).
      const said = step.refusal === "autonomy" ? /your autonomy here is (L[0-3])( \((.*?)\))?;/.exec(error ?? "") : null;
      if (said) {
        step.levelAtCall = said[1];
        if (said[3]) step.levelWhy = /attached on this host/.test(said[3]) ? "paused" : /no active people/.test(said[3]) ? "empty-roster" : "other";
        if (said[1] !== t.level && !said[3]) push({ t: new Date(ms(c.at) - 1).toISOString(), kind: "setting", key: "autonomy", value: said[1], src: "refusal-text" });
      }
      const A = c.args ?? {};
      if (c.name === "sova_idea") Object.assign(step.args, { op: A.op, id: A.id, status: A.status, tags: A.tags });
      if (c.name === "sova_promote") step.args.ids = A.ids ?? [];
      if (c.name === "sova_roster") step.args.op = A.op;
      if (c.name === "sova_send" || c.name === "sova_close_gathering") step.args.session = sessionRef(A.session ?? A.id ?? null);
      if (c.name === "sova_start_gathering" || c.name === "sova_offer") {
        const sid = /sova:\/\/s\/([0-9a-f-]{36})/.exec(c.result?.text ?? "")?.[1] ?? null;
        step.args.baton = sid;
        step.args.person = A.person ?? A.people ?? null;
        step.link = inferGap(gaps, `${A.public_title ?? ""} ${A.question ?? ""} ${A.goal ?? ""}`, sameTurnGaps, c.at);
      }
      if (c.name === "sova_create_session") {
        const sid = /sova:\/\/s\/([0-9a-f-]{36})/.exec(c.result?.text ?? "")?.[1] ?? null;
        step.args.build = sid;
        step.link = inferGap(gaps, `${A.title ?? ""} ${A.prompt ?? ""}`, sameTurnGaps, c.at);
        step.decisionsNamed = [...new Set([...(A.prompt ?? "").matchAll(/§[a-z0-9.-]+\/[a-z0-9-]+/g)].map((x) => x[0]))];
      }
      if (c.name === "sova_idea" && A.id) gapIdsSeen.add(A.id);
      push(step);
    }
    if (t.stop) push({ t: t.endAt ?? t.at, kind: "turn-end", stop: t.stop, error: t.error ? t.error.slice(0, 200) : null });
  }

  // Operator promotions: a decision promoted with no sova_promote of the overseer's that minute.
  const overseerPromotes = actions.filter((a) => a.tool === "sova_promote" && a.outcome !== "refused").map((a) => ({ at: ms(a.at), ids: new Set(a.args?.ids ?? []) }));
  for (const e of events)
    if (e.entity === "decision" && e.state === "promoted") e.by = overseerPromotes.some((p) => p.ids.has(e.id) && Math.abs(p.at - ms(e.t)) < 120e3) ? "overseer" : "operator";

  // Closes by the overseer.
  const closes = actions.filter((a) => a.tool === "sova_close_gathering" && a.outcome === "ok");
  for (const e of events) if (e.entity === "baton" && e.state === "closed") e.by = closes.some((a) => Math.abs(ms(a.at) - ms(e.t)) < 60e3) ? "overseer" : "operator";

  // A decision whose store state is not the last one emitted moved again later (a promoted decision
  // re-drafted after a merge, lane NEW-MS2-1; superseded or conflicted after promotion): the move is dated
  // by the lab monitor when it saw it, else by the reconciler's last run.
  const lastRunAt = readJson(join(pdir, "decisions.json"))?.lastRun?.at ?? null;
  const pendingFinal = [];
  for (const d of decisions) {
    const mine = events.filter((e) => e.entity === "decision" && e.id === d.id).sort((a, b) => ms(a.t) - ms(b.t));
    const last = mine.at(-1);
    if (last && last.state !== d.state) pendingFinal.push({ d, after: last.t });
  }

  // A lab lane's monitor timeline (TIMELINE.md beside the agent dir): the memo and decisions as polled.
  const lane = laneOf(agentDirs);
  // Each later start of the lab lane's server is a restart (whatever ran was cut off; memos and timers survive).
  if (lane) for (const t of lane.starts.slice(1)) push({ t, kind: "restart", src: "server.log" });
  // The monitor follows one overseer and names no project: its memo lines go to a project with turns only.
  if (lane) for (const e of timelineObs(lane.dir, lane.start ?? events[0]?.t ?? null, new Set(decisions.map((d) => d.id)), pid)) if (e.what === "decision" || turns.length) push(e);
  // A Run Now line names its project when it can; the lane's only overseer otherwise.

  for (const { d, after } of pendingFinal) {
    const seen = events.find((e) => e.kind === "obs" && e.what === "decision" && e.id === d.id && e.state === d.state && ms(e.t) > ms(after));
    const t = seen?.t ?? (lastRunAt && ms(lastRunAt) > ms(after) ? lastRunAt : null);
    if (t) push({ t, kind: "fact", entity: "decision", id: d.id, baton: d.sessionId, state: d.state, ...(d.supersededBy ? { supersededBy: d.supersededBy } : {}), derived: seen ? "monitor" : "last-reconcile" });
  }

  events.sort((a, b) => ms(a.t) - ms(b.t) || order(a) - order(b));

  // Hosts: each host's watch memo (host-local) and pause, and the holder record.
  const hostInfo = hosts.map((h) => {
    const idx = readJson(join(h.sova, "orgs.json"));
    const entry = idx?.orgs?.find((o) => o.id === orgId);
    return {
      host: readJson(join(h.sova, "host.json"))?.id ?? basename(dirname(h.sova)),
      attachedAt: entry?.attachedAt ?? null,
      paused: !!entry?.pausedOverseers?.includes(pid),
      memo: readJson(join(h.sova, "project-overseers", `${orgId}-${pid}`, "watch.json")),
      turn: readJson(join(h.sova, "project-overseers", `${orgId}-${pid}`, "turn.json")),
    };
  });

  const final = {
    autonomy: settings?.autonomy ?? null,
    watch: settings?.watch ?? null,
    caps: settings?.caps ?? null,
    watchGapMin: settings?.watchGapMin ?? null,
    // null is the operator's Off; absent is the default (60 s).
    soonLookSec: settings && "soonLookSec" in settings ? settings.soonLookSec : undefined,
    archived: !!project.archived,
    rosterActive: roster.filter((p) => p.status === "active").length,
    gaps: gaps.map((g) => ({ id: g.id, status: g.status, links: g.links.length })),
    batons: batons.map((b) => ({ id: b.sessionId, state: b.state, owner: b.owner === "operator" ? "operator" : "overseer", wrote: !!b.wroteAt })),
    decisions: decisions.map((d) => ({ id: d.id, baton: d.sessionId, state: d.state, build: d.build ?? null })),
    builds: started.filter((x) => x.kind === "coding" || x.kind === "operator-coding").map((s) => ({ id: s.sessionId, by: s.kind === "coding" ? "overseer" : "operator", merged: !!s.merged })),
    holder: readJson(join(wsDir, "holder.json"))?.host?.id ?? null,
    hosts: hostInfo.map((h) => ({ host: h.host, paused: h.paused, lastRun: h.memo?.lastRun ?? null, perDay: h.memo?.perDay ?? {}, held: h.memo?.held ?? [], pending: h.memo?.pending ?? [] })),
  };
  return { events, final, turns: turns.length, gapsSeen: [...gapIdsSeen], lane: lane ? { name: lane.name, sova: lane.sova } : null };
}

/** The lab lane an agent dir belongs to (`lane.json` naming it), with the Sova commit it ran. */
function laneOf(agentDirs) {
  for (const a of agentDirs) {
    for (const dir of [dirname(a), dirname(dirname(a))]) {
      const l = readJson(join(dir, "lane.json"));
      if (!l || real(l.agent ?? "") !== real(a)) continue;
      const starts = (() => {
        try {
          return [...readFileSync(join(dir, "server.log"), "utf8").matchAll(/=== start (\S+)/g)].map((m) => m[1]);
        } catch {
          return [];
        }
      })();
      const startLine = starts[0] ?? null;
      const sova = l.tree && startLine ? (git(l.tree, "log", "-1", `--before=${startLine}`, "--format=%H")?.trim() ?? null) : null;
      return { dir, name: l.lane ?? basename(dir), sova, start: startLine, starts };
    }
  }
  return null;
}

/** `[mon]` lines of a lane's TIMELINE.md as observations (times carry no date: the trace's day, wrapped). */
function timelineObs(dir, firstIso, decisionIds, project) {
  let text;
  try {
    text = readFileSync(join(dir, "TIMELINE.md"), "utf8");
  } catch {
    return [];
  }
  if (!firstIso) return [];
  let day = ms(`${firstIso.slice(0, 10)}T00:00:00.000Z`);
  let prev = -1;
  const out = [];
  const seenDecision = new Map();
  for (const line of text.split("\n")) {
    const run = /^- (\d\d):(\d\d):(\d\d)Z .*\bRun Now\b.*→ 200/.exec(line);
    // A Run Now naming another project is not this one's.
    if (run && project && /prj_[a-z0-9]+/.test(line) && !line.includes(project)) continue;
    const m = run ? [run[0], run[1], run[2], run[3], "RUN-NOW"] : /^- (\d\d):(\d\d):(\d\d)Z \[mon\] (.*)$/.exec(line);
    if (!m) continue;
    const tod = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
    if (prev >= 0 && tod + 12 * 3600e3 < prev) day += 86400e3;
    prev = tod;
    // The monitor prints whole seconds: what it saw happened within that second, so it counts at its end.
    const t = new Date(day + tod + 999).toISOString();
    const body = m[4];
    let x;
    const json = (s) => {
      try {
        return JSON.parse(s);
      } catch {
        return undefined;
      }
    };
    if (body === "RUN-NOW") out.push({ t: new Date(day + tod).toISOString(), kind: "operator", act: "run-now", src: "timeline" });
    else if ((x = /^overseer pending (.*)$/.exec(body))) out.push({ t, kind: "obs", what: "pending", pending: json(x[1]) ?? [] });
    else if ((x = /^overseer busy=(true|false)/.exec(body))) out.push({ t, kind: "obs", what: "busy", busy: x[1] === "true" });
    else if ((x = /^overseer lastRun (.*)$/.exec(body))) out.push({ t, kind: "obs", what: "lastRun", lastRun: json(x[1]) ?? null });
    else if ((x = /^overseer HELD (.*)$/.exec(body))) out.push({ t, kind: "obs", what: "held", held: (json(x[1]) ?? []).map((h) => h.key ?? h) });
    else if ((x = /^decision (\S+) \[([a-z-]+)\]/.exec(body)) && decisionIds.has(x[1]) && seenDecision.get(x[1]) !== x[2]) {
      seenDecision.set(x[1], x[2]);
      out.push({ t, kind: "obs", what: "decision", id: x[1], state: x[2] });
    }
  }
  return out;
}

/** Behaviour that changed during the corpus week, by the commit that introduced it (server/ at HEAD). */
const FEATURES = {
  askedOperatorReason: "8b7f6751", // a gathering's hand-off to the operator is a watch reason
  codingSettledReason: "239852ee", // an overseer-started coding session's turn end is a reason; "The operator promoted" reason
  noDecisionRecordedReason: "239852ee", // "A decision was recorded in …" stops being a reason
  allowanceHeld: "80a785ca", // held items / allowance back, day vs message ledgers
  mergeReasonAndTodosOperatorOnly: "77f3cdbf", // Merge Branch is a reason; sova_todos needs the operator
  noTokenBudget: "320042f0", // the coding token budget is gone
};
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** Which Sova commit a trace ran: the lab lane's tree, a worktree's own history, else master by date. */
function sovaCommit(lane, agentDirs, start) {
  if (lane?.sova) return { sha: lane.sova, how: "lane" };
  for (const a of agentDirs) {
    const wt = dirname(a);
    if (basename(a) === ".agent" && existsSync(join(wt, ".git")) && start) {
      const sha = git(wt, "log", "-1", `--before=${start}`, "--format=%H")?.trim();
      if (sha) return { sha, how: "worktree-by-date" };
    }
  }
  const sha = start ? git(REPO, "log", "master", "-1", `--before=${start}`, "--format=%H")?.trim() : null;
  return { sha: sha || null, how: "master-by-date" };
}

function featuresAt(sha) {
  const out = {};
  for (const [k, f] of Object.entries(FEATURES)) {
    if (!sha) out[k] = null;
    else {
      try {
        execFileSync("git", ["-C", REPO, "merge-base", "--is-ancestor", f, sha], { stdio: "ignore" });
        out[k] = true;
      } catch (err) {
        out[k] = err?.status === 1 ? false : null;
      }
    }
  }
  return out;
}

/** Same-millisecond order: facts before turns before tool calls before turn ends. */
function order(e) {
  return { restart: 0, setting: 1, fact: 2, obs: 3, operator: 4, turn: 5, tool: 6, "turn-end": 7 }[e.kind] ?? 8;
}

// ---- findings: what really happened, judged against the pipeline ---------------------------------------

/** Plain checks over the trace (the replay adds the chart's own view). Each names its evidence. */
function findings(trace) {
  const out = [];
  const ev = trace.events;
  const tools = ev.filter((e) => e.kind === "tool");
  // Gatherings and builds started with no gap id: the link the chart needs and today lacks.
  for (const t of tools.filter((t) => (t.name === "sova_start_gathering" || t.name === "sova_offer" || t.name === "sova_create_session") && t.verdict === "ok"))
    out.push({ kind: "missing-link", at: t.t, what: `${t.name} carried no gap id`, inferred: t.link });
  // A gap marked done while what it led to was not built / merged.
  for (const t of tools.filter((t) => t.name === "sova_idea" && t.args.op === "status" && t.args.status === "done")) {
    const linked = tools.filter((x) => x.link?.gap === t.args.id && ms(x.t) <= ms(t.t));
    const build = tools.find((x) => x.name === "sova_create_session" && x.link?.gap === t.args.id && ms(x.t) <= ms(t.t));
    const merged = build && ev.some((e) => e.entity === "build" && e.id === build.args.build && e.merged && ms(e.t) <= ms(t.t));
    if (!merged) out.push({ kind: "early-done", at: t.t, gap: t.args.id, what: `gap marked done with ${build ? "its build not merged" : "no build started"}`, linked: linked.map((x) => x.name) });
  }
  // Refusals by kind.
  for (const t of tools.filter((t) => t.verdict === "refused" || t.verdict === "partial")) out.push({ kind: `refused:${t.refusal}`, at: t.t, tool: t.name, attended: t.attended, level: t.level });
  // Drafted decisions still unpromoted at the end, and promoted ones never built.
  const last = ev.at(-1)?.t;
  for (const d of trace.final.decisions) {
    if (d.state === "drafted") out.push({ kind: "stall:drafted", decision: d.id, until: last });
    if (d.state === "promoted" && d.build !== "built") out.push({ kind: "stall:promoted-not-built", decision: d.id, until: last });
  }
  // Watch looks: reasons listed vs the facts that changed since the last look (reasons dropped).
  return out;
}

// ---- anonymization for committed fixtures ----------------------------------------------------------------

/** A stable short token per real id, per trace: nothing of the id survives. */
function anonymizer() {
  const maps = new Map();
  return (kind, id) => {
    if (id == null) return id;
    if (!maps.has(kind)) maps.set(kind, new Map());
    const m = maps.get(kind);
    if (!m.has(id)) m.set(id, `${kind}${m.size + 1}`);
    return m.get(id);
  };
}

/** The committed form: typed events only, ids replaced, no text, names, paths, hosts or emails. */
export function anonymize(trace, n) {
  const A = anonymizer();
  const gapId = (id) => (id ? `§gap/g${A("", id)}` : id);
  const decId = (id) => A("d", id);
  const t0 = ms(trace.events[0]?.t ?? trace.start);
  const batonIds = new Set(trace.events.filter((e) => e.entity === "baton").map((e) => e.id));
  const buildIds = new Set(trace.events.filter((e) => e.entity === "build").map((e) => e.id));
  const rel = (t) => Math.round(ms(t) - Math.floor(t0 / 60e3) * 60e3);
  const events = trace.events.map((e) => {
    const o = { dt: rel(e.t), kind: e.kind };
    if (e.kind === "setting") Object.assign(o, { key: e.key, value: e.value, src: e.src });
    if (e.kind === "fact") {
      o.entity = e.entity;
      const id = { overseer: () => "o", gap: gapId, baton: (x) => A("b", x), decision: decId, build: (x) => A("c", x), person: (x) => A("p", x), conflict: (x) => A("k", x) }[e.entity];
      if (e.settleBaton) o.settleBaton = A("b", e.settleBaton);
      if (e.outcome) o.outcome = e.outcome;
      o.id = id ? id(e.id) : null;
      for (const k of ["state", "status", "by", "running", "lastFailed", "merged", "newSinceMerge", "ownerArea", "derived", "build", "wrote", "offer", "settle"]) if (e[k] !== undefined && e[k] !== null) o[k] = e[k];
      if (e.baton) o.baton = A("b", e.baton);
      if (e.supersededBy) o.supersededBy = decId(e.supersededBy);
    }
    if (e.kind === "turn") Object.assign(o, { ...(e.joins ? { joins: true } : {}), by: e.by, attended: e.attended, level: e.level, ...(e.levelWhy ? { levelWhy: e.levelWhy } : {}), reasons: e.reasons.map((r) => ({ kind: r.kind, soon: r.soon })), ...(e.runAll ? { runAll: true } : {}) });
    if (e.kind === "tool") {
      Object.assign(o, { name: e.name, attended: e.attended, level: e.level, verdict: e.verdict });
      if (e.refusal) o.refusal = e.refusal;
      if (e.levelAtCall) o.levelAtCall = e.levelAtCall;
      if (e.cap) o.cap = e.cap;
      if (e.levelWhy) o.levelWhy = e.levelWhy;
      const a = {};
      if (e.args.op) a.op = e.args.op;
      if (e.args.id) a.id = e.args.id.startsWith("§gap/") ? gapId(e.args.id) : "§idea/x";
      if (e.args.status) a.status = e.args.status;
      if (e.args.ids) a.ids = e.args.ids.map(decId);
      if (e.args.baton) a.baton = A("b", e.args.baton);
      if (e.args.build) a.build = A("c", e.args.build);
      if (e.args.session) a.session = A(batonIds.has(e.args.session) ? "b" : buildIds.has(e.args.session) ? "c" : "s", e.args.session);
      if (Object.keys(a).length) o.args = a;
      if (e.link) o.link = { gap: gapId(e.link.gap), how: e.link.how };
    }
    if (e.kind === "turn-end") Object.assign(o, { stop: e.stop });
    if (e.kind === "operator") Object.assign(o, { act: e.act, src: e.src });
    if (e.kind === "restart") o.src = e.src;
    if (e.kind === "obs") {
      o.what = e.what;
      if (e.what === "pending") o.pending = e.pending.map((r) => reasonKind(r).kind);
      if (e.what === "busy") o.busy = e.busy;
      if (e.what === "lastRun") o.lastRun = e.lastRun ? { outcome: e.lastRun.outcome, dAt: rel(e.lastRun.at), reasons: (e.lastRun.reasons ?? []).map((r) => reasonKind(r).kind) } : null;
      if (e.what === "held") o.held = e.held;
      if (e.what === "decision") Object.assign(o, { id: decId(e.id), state: e.state });
    }
    return o;
  });
  const f = trace.final;
  return {
    v: 1,
    id: `real-${String(n).padStart(2, "0")}`,
    source: trace.source,
    note: "Mined from a real run and anonymized (scripts/org-charts-mine.mjs): ids are per-trace tokens, times are ms from the first event, no text.",
    t0: new Date(Math.floor(t0 / 60e3) * 60e3).toISOString(),
    hosts: f.hosts.length,
    sova: { commit: trace.sova?.sha?.slice(0, 8) ?? null, how: trace.sova?.how ?? null, features: trace.sova?.features ?? {} },
    events,
    final: {
      autonomy: f.autonomy,
      watch: f.watch,
      caps: f.caps,
      watchGapMin: f.watchGapMin,
      soonLookSec: f.soonLookSec,
      archived: f.archived,
      rosterActive: f.rosterActive,
      gaps: f.gaps.map((g) => ({ id: gapId(g.id), status: g.status, links: g.links })),
      batons: f.batons.map((b) => ({ ...b, id: A("b", b.id) })),
      decisions: f.decisions.map((d) => ({ ...d, id: decId(d.id), baton: A("b", d.baton) })),
      builds: f.builds.map((b) => ({ ...b, id: A("c", b.id) })),
      hosts: f.hosts.map((h, i) => ({ host: `h${i + 1}`, paused: h.paused, lastRun: h.lastRun ? { outcome: h.lastRun.outcome, reasons: (h.lastRun.reasons ?? []).map((r) => reasonKind(r).kind) } : null, looks: Object.values(h.perDay).reduce((a, b) => a + b, 0), held: h.held.map((x) => x.key), pending: h.pending.map((r) => reasonKind(r).kind) })),
    },
  };
}

// ---- main ------------------------------------------------------------------------------------------------

function main() {
  const stateRoots = findStateRoots();
  // workspace (real path) → { orgId, hosts: [{ sova }] }
  const workspaces = new Map();
  for (const sova of stateRoots) {
    const idx = readJson(join(sova, "orgs.json"));
    for (const o of idx?.orgs ?? []) {
      if (!o.dir || !existsSync(o.dir)) continue;
      const key = real(o.dir);
      if (!workspaces.has(key)) workspaces.set(key, { orgId: o.id, dir: key, hosts: [] });
      workspaces.get(key).hosts.push({ sova });
    }
  }
  mkdirSync(OUT, { recursive: true });
  const index = [];
  const seenOverseers = new Map();
  for (const ws of workspaces.values()) {
    const projects = readJson(join(ws.dir, "projects.json"))?.projects ?? [];
    for (const p of projects) {
      const odir = join(ws.dir, "projects", p.id, "overseer");
      const st = readJson(join(odir, "state.json"));
      if (!st?.current) continue;
      let mined;
      try {
        mined = mineProject({ orgId: ws.orgId, wsDir: ws.dir, project: p, hosts: ws.hosts });
      } catch (err) {
        index.push({ ws: ws.dir, project: p.id, error: String(err?.stack ?? err) });
        continue;
      }
      const first = mined.events[0]?.t ?? null;
      const last = mined.events.at(-1)?.t ?? null;
      if (!last || last < SINCE) continue;
      // The same run copied into several places (evidence folders, a second lane): keep the richest.
      const key = st.current;
      const size = mined.events.length;
      const prev = seenOverseers.get(key);
      if (prev && prev.size >= size) continue;
      const id = `${ws.orgId}-${p.id}-${st.current.slice(0, 8)}`;
      const sova = sovaCommit(mined.lane, ws.hosts.map((h) => dirname(h.sova)), first);
      const trace = { v: 1, id, source: "e2e-lane", lane: mined.lane, sova: { ...sova, features: featuresAt(sova.sha) }, start: first, end: last, ws: ws.dir, org: ws.orgId, project: p.id, hostsCount: ws.hosts.length, turns: mined.turns, events: mined.events, final: mined.final };
      trace.findings = findings(trace);
      if (prev) index.splice(index.findIndex((x) => x.id === prev.id), 1);
      seenOverseers.set(key, { id, size });
      writeFileSync(join(OUT, `${id}.json`), `${JSON.stringify(trace, null, 1)}\n`);
      index.push({ id, ws: ws.dir, hosts: ws.hosts.length, turns: mined.turns, events: size, tools: mined.events.filter((e) => e.kind === "tool").length, start: first, end: last, findings: countBy(trace.findings.map((f) => f.kind)) });
    }
  }
  index.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  // The global Overseer (not an org project): counted, never charted.
  const global = readLines(join(homedir(), ".pi/agent/sova/overseer-actions.jsonl")).filter((a) => a.at >= SINCE);
  const summary = { since: SINCE, stateRoots: stateRoots.length, workspaces: workspaces.size, scenarios: index.filter((x) => !x.error).length, errors: index.filter((x) => x.error).length, globalOverseer: { actions: global.length, byTool: countBy(global.map((a) => `${a.tool} ${a.outcome}`)) }, index };
  writeFileSync(join(OUT, "index.json"), `${JSON.stringify(summary, null, 1)}\n`);
  const failed = index.filter((x) => x.error);
  if (failed.length) {
    // Never write fixtures from a partial run: the old ones would stay beside the new.
    console.error(`${failed.length} projects failed to mine:\n${failed.map((x) => `${x.project}: ${x.error.split("\n")[0]}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  if (FIXTURES) {
    mkdirSync(FIXTURES, { recursive: true });
    for (const f of readdirSync(FIXTURES)) if (/^real-\d+\.json$/.test(f)) rmSync(join(FIXTURES, f));
    let n = 0;
    const map = [];
    for (const x of index.filter((x) => !x.error && x.tools > 0)) {
      const trace = readJson(join(OUT, `${x.id}.json`));
      const anon = anonymize(trace, ++n);
      assertClean(anon, trace);
      writeFileSync(join(FIXTURES, `${anon.id}.json`), compact(anon));
      map.push({ fixture: anon.id, trace: x.id });
    }
    writeFileSync(join(OUT, "fixture-map.json"), `${JSON.stringify(map, null, 1)}\n`);
  }
  console.log(JSON.stringify({ ...summary, index: undefined }, null, 1));
}

/** Refuse to write a fixture carrying anything of the real trace's identity or text. */
function assertClean(anon, trace) {
  const s = JSON.stringify(anon);
  const bad = [homedir(), trace.org, trace.project, trace.ws, ...trace.events.flatMap((e) => [e.id, e.session, e.baton, e.args?.baton, e.args?.build]).filter((x) => typeof x === "string" && x.length > 12)];
  for (const b of bad) if (b && s.includes(b)) throw new Error(`fixture ${anon.id} leaks ${b.slice(0, 12)}…`);
  if (/@|\/home\/|sova:\/\//.test(s)) throw new Error(`fixture ${anon.id} carries a path, link or address`);
}

/** One event per line: small, and a diff reads event by event. */
function compact(t) {
  const { events, final, ...head } = t;
  return `${JSON.stringify(head).slice(0, -1)},\n"events": [\n${events.map((e) => JSON.stringify(e)).join(",\n")}\n],\n"final": ${JSON.stringify(final)}\n}\n`;
}

function countBy(xs) {
  const o = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}


// ---- synthetic edge cases (--synthetic <dir>) -------------------------------------------------------------
// Hand-built traces for what the corpus lacks or shows too rarely. Each states, in `expect` steps, what the
// design says must hold (org-fsm-vs-statechart.md §4), so the replay checks the charts against it.

function writeSynthetic(out) {
  mkdirSync(out, { recursive: true });
  const caps = { gatherPerTurn: 3, promotePerTurn: 20, createPerTurn: 2, promptsPerTurn: 5, gatherPerDay: 4, promotePerDay: 60, createPerDay: 4, promptsPerDay: 12, unattendedPerDay: 12, gatheringsOpen: 5, codingRunning: 2 };
  const base = (id, note, t0, events, final = {}) => ({
    v: 1, id, source: "synthetic", note: `Synthetic: ${note}`, t0, hosts: 1,
    sova: { commit: null, how: "synthetic", features: { askedOperatorReason: true, codingSettledReason: true, noDecisionRecordedReason: true, allowanceHeld: true, mergeReasonAndTodosOperatorOnly: true, noTokenBudget: true } },
    events,
    final: { autonomy: "L3", watch: true, caps, watchGapMin: 10, soonLookSec: 60, archived: false, rosterActive: 1, gaps: [], batons: [], decisions: [], builds: [], hosts: [], ...final },
  });
  const S = 1000, M = 60 * S;
  const person = [{ dt: 0, kind: "fact", entity: "person", id: "p1", status: "active" }];
  const tool = (dt, name, o = {}) => ({ dt, kind: "tool", name, attended: false, level: "L3", verdict: "ok", ...o });
  const watch = (dt, reasons, o = {}) => ({ dt, kind: "turn", by: "watch", attended: false, level: "L3", reasons, ...o });
  const end = (dt, stop = "stop") => ({ dt, kind: "turn-end", stop });
  // A gap through gathering to promoted, the overseer's own acts (L3), for the build cases.
  const toPromoted = (t) => [
    ...person,
    { dt: t, kind: "fact", entity: "gap", id: "§gap/g1", status: "open" },
    { dt: t + S, kind: "turn", by: "operator", attended: true, level: "L3", reasons: [] },
    tool(t + 2 * S, "sova_start_gathering", { attended: true, args: { baton: "b1" }, link: { gap: "§gap/g1", how: "named" } }),
    { dt: t + 2 * S + 5, kind: "fact", entity: "baton", id: "b1", state: "open", by: "overseer" },
    end(t + 3 * S),
    { dt: t + 5 * M, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "pending", ownerArea: true },
    { dt: t + 6 * M, kind: "fact", entity: "baton", id: "b1", state: "done", wrote: true },
    { dt: t + 7 * M, kind: "turn", by: "operator", attended: true, level: "L3", reasons: [] },
    tool(t + 7 * M + S, "sova_reconcile", { attended: true }),
    { dt: t + 7 * M + 2 * S, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "drafted", by: "overseer" },
    tool(t + 7 * M + 3 * S, "sova_promote", { attended: true, args: { ids: ["d1"] } }),
    { dt: t + 7 * M + 4 * S, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "promoted", by: "overseer" },
    end(t + 7 * M + 5 * S),
  ];
  const building = (t) => [
    ...toPromoted(t),
    { dt: t + 8 * M, kind: "turn", by: "operator", attended: true, level: "L3", reasons: [] },
    tool(t + 8 * M + S, "sova_create_session", { attended: true, args: { build: "c1" }, link: { gap: "§gap/g1", how: "named" } }),
    { dt: t + 8 * M + S + 5, kind: "fact", entity: "build", id: "c1", by: "overseer" },
    { dt: t + 8 * M + 2 * S, kind: "fact", entity: "build", id: "c1", running: true },
    end(t + 8 * M + 3 * S),
    { dt: t + 8 * M + 4 * S, kind: "expect", session: "§gap/g1", in: ["working"] },
  ];
  const fx = [];
  fx.push(base("syn-restart-mid-look", "the server restarts while a look runs; the reasons it was for must not be lost (R2)", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "baton", id: "b1", state: "open", by: "operator" },
    { dt: 2 * M, kind: "fact", entity: "baton", id: "b1", state: "done", wrote: true },
    { dt: 3 * M + 20 * S, kind: "expect", session: "project", in: ["running"], lookStarted: true },
    watch(3 * M + 20 * S, [{ kind: "gathering-done", soon: true }]),
    { dt: 3 * M + 40 * S, kind: "restart" },
    { dt: 3 * M + 41 * S, kind: "expect", session: "project", notIn: ["running"], reasonKinds: ["baton/done"] },
  ]));
  fx.push(base("syn-reason-while-streaming", "the operator reconciles on the page while the overseer answers the operator; today's memo drops the reason (R3), the chart keeps it", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "decision", id: "d1", baton: "b0", state: "pending", ownerArea: true },
    { dt: 1 * M, kind: "turn", by: "operator", attended: true, level: "L3", reasons: [] },
    { dt: 1 * M + 10 * S, kind: "fact", entity: "decision", id: "d1", baton: "b0", state: "drafted", by: "operator" },
    end(1 * M + 30 * S),
    { dt: 1 * M + 31 * S, kind: "expect", session: "project", reasonKinds: ["reconcile/drafted"] },
  ]));
  fx.push(base("syn-own-reason-while-streaming", "the overseer's own reconcile during its turn is not a reason (its own act)", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "decision", id: "d1", baton: "b0", state: "pending", ownerArea: true },
    { dt: 1 * M, kind: "turn", by: "operator", attended: true, level: "L3", reasons: [] },
    tool(1 * M + 5 * S, "sova_reconcile", { attended: true }),
    { dt: 1 * M + 10 * S, kind: "fact", entity: "decision", id: "d1", baton: "b0", state: "drafted", by: "overseer" },
    end(1 * M + 30 * S),
    { dt: 1 * M + 31 * S, kind: "expect", session: "project", noReasonKinds: ["reconcile/drafted"] },
  ]));
  fx.push(base("syn-pause-by-attach", "attached on this host: level in force L0 until the operator sets a level", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "gap", id: "§gap/g1", status: "open" },
    { dt: 2 * S, kind: "operator", act: "attach" },
    { dt: 3 * S, kind: "expect", session: "project", in: ["paused"] },
    { dt: 1 * M, kind: "turn", by: "watch", attended: false, level: "L0", levelWhy: "paused", reasons: [], runAll: true },
    tool(1 * M + 5 * S, "sova_start_gathering", { level: "L0", levelWhy: "paused", verdict: "refused", refusal: "autonomy", levelAtCall: "L0", link: { gap: "§gap/g1", how: "named" } }),
    tool(1 * M + 6 * S, "sova_idea", { level: "L0", levelWhy: "paused", args: { op: "add", id: "§gap/g2" } }),
    end(1 * M + 10 * S),
    { dt: 2 * M, kind: "setting", key: "autonomy", value: "L1", src: "synthetic" },
    { dt: 2 * M + 1, kind: "expect", session: "project", in: ["live"], notIn: ["paused"] },
    { dt: 3 * M, kind: "turn", by: "operator", attended: false, level: "L1", reasons: [] },
    tool(3 * M + 5 * S, "sova_start_gathering", { level: "L1", args: { baton: "b1" }, link: { gap: "§gap/g1", how: "named" } }),
    { dt: 3 * M + 5 * S + 5, kind: "fact", entity: "baton", id: "b1", state: "open", by: "overseer" },
    end(3 * M + 10 * S),
    { dt: 3 * M + 11 * S, kind: "expect", session: "§gap/g1", in: ["asking"] },
  ], { autonomy: "L1" }));
  fx.push(base("syn-two-hosts", "host A dumps, host B loads the same snapshots (attach elsewhere) and is paused until its level is set", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "gap", id: "§gap/g1", status: "open" },
    { dt: 1 * M, kind: "turn", by: "operator", attended: true, level: "L1", reasons: [] },
    tool(1 * M + 2 * S, "sova_start_gathering", { attended: true, level: "L1", args: { baton: "b1" }, link: { gap: "§gap/g1", how: "named" } }),
    { dt: 1 * M + 2 * S + 5, kind: "fact", entity: "baton", id: "b1", state: "open", by: "overseer" },
    end(1 * M + 5 * S),
    { dt: 5 * M, kind: "restart" },
    { dt: 5 * M + 1, kind: "operator", act: "attach" },
    { dt: 5 * M + 2, kind: "expect", session: "§gap/g1", in: ["asking"] },
    { dt: 5 * M + 3, kind: "expect", session: "project", in: ["paused"] },
    { dt: 6 * M, kind: "fact", entity: "baton", id: "b1", state: "needs-you" },
    { dt: 6 * M + 1, kind: "expect", session: "§gap/g1", in: ["needs-operator"] },
  ], { autonomy: "L1" }));
  fx.push(base("syn-empty-roster", "the last active person leaves: level in force L0; the operator's own turn still acts", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "gap", id: "§gap/g1", status: "open" },
    { dt: 1 * M, kind: "fact", entity: "person", id: "p1", status: "left" },
    { dt: 2 * M, kind: "turn", by: "watch", attended: false, level: "L0", levelWhy: "empty-roster", reasons: [], runAll: true },
    tool(2 * M + 5 * S, "sova_start_gathering", { level: "L0", levelWhy: "empty-roster", verdict: "refused", refusal: "autonomy", levelAtCall: "L0", link: { gap: "§gap/g1", how: "named" } }),
    end(2 * M + 10 * S),
    { dt: 3 * M, kind: "turn", by: "operator", attended: true, level: "L0", levelWhy: "empty-roster", reasons: [] },
    tool(3 * M + 5 * S, "sova_start_gathering", { attended: true, level: "L0", levelWhy: "empty-roster", args: { baton: "b1" }, link: { gap: "§gap/g1", how: "named" } }),
    { dt: 3 * M + 5 * S + 5, kind: "fact", entity: "baton", id: "b1", state: "open", by: "overseer" },
    end(3 * M + 10 * S),
    { dt: 3 * M + 11 * S, kind: "expect", session: "§gap/g1", in: ["asking"] },
  ], { rosterActive: 0 }));
  // Local time (no Z): midnight is the host's.
  fx.push(base("syn-cap-at-midnight", "the day's gathering allowance is used at 23:50; it is back after local midnight", "2026-09-28T23:40:00", [
    ...person,
    ...[1, 2, 3, 4].map((i) => ({ dt: i * S, kind: "fact", entity: "gap", id: `§gap/g${i}`, status: "open" })),
    { dt: 10 * S, kind: "fact", entity: "gap", id: "§gap/g5", status: "open" },
    watch(1 * M, [], { runAll: true }),
    ...[1, 2, 3, 4].flatMap((i) => [
      tool(1 * M + i * S, "sova_start_gathering", { args: { baton: `b${i}` }, link: { gap: `§gap/g${i}`, how: "named" } }),
      { dt: 1 * M + i * S + 5, kind: "fact", entity: "baton", id: `b${i}`, state: "open", by: "overseer" },
    ]),
    end(1 * M + 30 * S),
    watch(10 * M, [], { runAll: true }),
    tool(10 * M + 5 * S, "sova_start_gathering", { verdict: "refused", refusal: "cap-day", cap: { used: 4, max: 4 }, link: { gap: "§gap/g5", how: "named" } }),
    end(10 * M + 10 * S),
    { dt: 21 * M, kind: "expect", session: "project", reasonKinds: ["held/day"] },
    watch(21 * M + 5 * S, [{ kind: "allowance-back", soon: true }]),
    tool(21 * M + 10 * S, "sova_start_gathering", { args: { baton: "b5" }, link: { gap: "§gap/g5", how: "named" } }),
    { dt: 21 * M + 10 * S + 5, kind: "fact", entity: "baton", id: "b5", state: "open", by: "overseer" },
    end(21 * M + 20 * S),
    { dt: 21 * M + 21 * S, kind: "expect", session: "§gap/g5", in: ["asking"] },
  ]));
  fx.push(base("syn-gap-dropped-mid-build", "the gap is dropped while its build works: final, and later build facts never revive it", "2026-09-28T10:00:00Z", [
    ...building(1 * S),
    { dt: 10 * M, kind: "turn", by: "operator", attended: true, level: "L3", reasons: [] },
    tool(10 * M + S, "sova_idea", { attended: true, args: { op: "status", id: "§gap/g1", status: "dropped" } }),
    end(10 * M + 2 * S),
    { dt: 10 * M + 3 * S, kind: "expect", session: "§gap/g1", in: [] , notIn: ["working", "live"] },
    { dt: 12 * M, kind: "fact", entity: "build", id: "c1", running: false, lastFailed: false },
    { dt: 13 * M, kind: "fact", entity: "build", id: "c1", merged: true, by: "operator" },
    { dt: 13 * M + 1, kind: "expect", session: "§gap/g1", notIn: ["merged", "idle", "live"] },
  ]));
  fx.push(base("syn-merge-refused", "Merge Branch refusals: busy and root ones are the operator's, only a git refusal is a reason to look", "2026-09-28T10:00:00Z", [
    ...building(1 * S),
    { dt: 9 * M, kind: "operator", act: "merge-refused", cause: "busy", id: "c1" },
    { dt: 9 * M + 1, kind: "expect", session: "project", noReasonKinds: ["build/merge-refused"] },
    { dt: 11 * M, kind: "fact", entity: "build", id: "c1", running: false, lastFailed: false },
    { dt: 11 * M + 1, kind: "expect", session: "§gap/g1", in: ["idle"] },
    { dt: 11 * M + 30 * S, kind: "operator", act: "merge-refused", cause: "root", id: "c1" },
    { dt: 11 * M + 30 * S + 1, kind: "expect", session: "project", noReasonKinds: ["build/merge-refused"] },
    { dt: 11 * M + 40 * S, kind: "operator", act: "merge-refused", cause: "git", id: "c1" },
    { dt: 11 * M + 40 * S + 1, kind: "expect", session: "project", reasonKinds: ["build/merge-refused"] },
    { dt: 12 * M, kind: "operator", act: "merge", id: "c1" },
    { dt: 12 * M + 5, kind: "fact", entity: "build", id: "c1", merged: true, by: "operator" },
    { dt: 12 * M + 6, kind: "expect", session: "§gap/g1", in: ["merged"] },
  ]));
  fx.push(base("syn-new-commits-after-merge", "a merged build gets new commits: the item is building again until the next merge", "2026-09-28T10:00:00Z", [
    ...building(1 * S),
    { dt: 11 * M, kind: "fact", entity: "build", id: "c1", running: false, lastFailed: false },
    { dt: 12 * M, kind: "operator", act: "merge", id: "c1" },
    { dt: 12 * M + 5, kind: "fact", entity: "build", id: "c1", merged: true, by: "operator" },
    { dt: 12 * M + 6, kind: "expect", session: "§gap/g1", in: ["merged"] },
    { dt: 14 * M, kind: "fact", entity: "build", id: "c1", running: true },
    { dt: 15 * M, kind: "fact", entity: "build", id: "c1", running: false, newSinceMerge: 2 },
    { dt: 15 * M + 1, kind: "expect", session: "§gap/g1", in: ["idle"], notIn: ["merged"] },
    { dt: 16 * M, kind: "operator", act: "merge", id: "c1" },
    { dt: 16 * M + 5, kind: "fact", entity: "build", id: "c1", merged: true, newSinceMerge: 0, by: "operator" },
    { dt: 16 * M + 6, kind: "expect", session: "§gap/g1", in: ["merged"] },
  ]));
  // ---- the verifier's list: paths the charts claim that the corpus lacks -----------------------------
  const H = 60 * M;
  const gathering = (dt, gap, baton, o = {}) => [
    tool(dt, "sova_start_gathering", { attended: true, args: { baton }, link: { gap, how: "named" }, ...o }),
    { dt: dt + 5, kind: "fact", entity: "baton", id: baton, state: "open", by: "overseer" },
  ];
  const opTurn = (dt) => ({ dt, kind: "turn", by: "operator", attended: true, level: "L3", reasons: [] });
  fx.push(base("syn-soon-off", "the soon look is Off: a finished gathering waits for the gap after the last look", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "operator", act: "run-now" },
    watch(2 * S, [], { runAll: true }),
    end(10 * S),
    { dt: 1 * M, kind: "fact", entity: "baton", id: "b1", state: "open", by: "operator" },
    { dt: 2 * M, kind: "fact", entity: "baton", id: "b1", state: "done", wrote: true },
    { dt: 5 * M, kind: "expect", session: "project", notIn: ["running"], reasonKinds: ["baton/done"] },
    { dt: 10 * M + 30 * S, kind: "expect", session: "project", in: ["running"] },
    watch(10 * M + 40 * S, [{ kind: "gathering-done", soon: true }]),
    end(10 * M + 50 * S),
  ], { soonLookSec: null }));
  fx.push(base("syn-watch-off-run-now", "Watch off: reasons wait and no look starts on its own; Run Now still looks", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "baton", id: "b1", state: "open", by: "operator" },
    { dt: 1 * M, kind: "fact", entity: "baton", id: "b1", state: "done", wrote: true },
    { dt: 11 * M, kind: "expect", session: "project", in: ["watch-off"], notIn: ["running"], reasonKinds: ["baton/done"] },
    { dt: 12 * M, kind: "operator", act: "run-now" },
    { dt: 12 * M + 1, kind: "expect", session: "project", in: ["running"] },
    watch(12 * M + 1 * S, [{ kind: "gathering-done", soon: true }]),
    end(12 * M + 10 * S),
  ], { watch: false }));
  fx.push(base("syn-archive-during-look", "archived while a look runs: the look ends, no look starts, Run Now is refused, unarchive resumes", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "baton", id: "b0", state: "open", by: "operator" },
    { dt: 2 * S, kind: "fact", entity: "baton", id: "b0", state: "done", wrote: true },
    watch(3 * S, [{ kind: "gathering-done", soon: true }]),
    { dt: 10 * S, kind: "operator", act: "archive" },
    { dt: 11 * S, kind: "expect", session: "project", in: ["archived", "running"] },
    end(20 * S),
    { dt: 30 * S, kind: "fact", entity: "baton", id: "b1", state: "open", by: "operator" },
    { dt: 40 * S, kind: "fact", entity: "baton", id: "b1", state: "closed" },
    { dt: 12 * M, kind: "expect", session: "project", notIn: ["running"], reasonKinds: ["baton/closed"] },
    { dt: 13 * M, kind: "operator", act: "run-now" },
    { dt: 13 * M + 1, kind: "expect", session: "project", notIn: ["running"] },
    { dt: 14 * M, kind: "operator", act: "unarchive" },
    { dt: 14 * M + 1, kind: "expect", session: "project", in: ["active", "running"] },
    watch(14 * M + 2 * S, [{ kind: "gathering-closed", soon: false }]),
    end(14 * M + 10 * S),
  ]));
  fx.push(base("syn-limit-raised", "the day's looks are used: held until the operator raises the limit, which releases a look", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "baton", id: "b0", state: "open", by: "operator" },
    { dt: 2 * S, kind: "fact", entity: "baton", id: "b0", state: "done", wrote: true },
    watch(3 * S, [{ kind: "gathering-done", soon: true }]),
    end(10 * S),
    { dt: 1 * M, kind: "fact", entity: "baton", id: "b1", state: "open", by: "operator" },
    { dt: 11 * M, kind: "fact", entity: "baton", id: "b1", state: "done", wrote: true },
    { dt: 12 * M, kind: "expect", session: "project", in: ["held"], notIn: ["running"] },
    { dt: 13 * M, kind: "operator", act: "limit-raised", value: { unattendedPerDay: 3 } },
    { dt: 13 * M + 1, kind: "expect", session: "project", in: ["running"] },
    watch(13 * M + 2 * S, [{ kind: "gathering-done", soon: true }, { kind: "limit-raised", soon: true }]),
    end(13 * M + 10 * S),
  ], { caps: { ...caps, unattendedPerDay: 1 } }));
  fx.push(base("syn-hold-resume", "the operator holds an item; facts that land meanwhile are taken, and resume returns it where they put it", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "gap", id: "§gap/g1", status: "open" },
    opTurn(2 * S),
    ...gathering(3 * S, "§gap/g1", "b1"),
    end(5 * S),
    { dt: 6 * S, kind: "expect", session: "§gap/g1", in: ["asking"] },
    { dt: 2 * M, kind: "operator", act: "hold", gap: "§gap/g1" },
    { dt: 2 * M + 1, kind: "expect", session: "§gap/g1", in: ["on-hold"] },
    { dt: 3 * M, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "pending", ownerArea: true },
    { dt: 4 * M, kind: "fact", entity: "baton", id: "b1", state: "done", wrote: true },
    { dt: 4 * M + 1, kind: "expect", session: "§gap/g1", in: ["on-hold"], notIn: ["asking", "unreconciled"] },
    { dt: 5 * M, kind: "operator", act: "resume", gap: "§gap/g1" },
    { dt: 5 * M + 1, kind: "expect", session: "§gap/g1", in: ["unreconciled"], notIn: ["on-hold"] },
  ]));
  fx.push(base("syn-stall-after-days", "a gathering nobody answers for three days: the item stalls and the project is told", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "gap", id: "§gap/g1", status: "open" },
    opTurn(2 * S),
    ...gathering(3 * S, "§gap/g1", "b1"),
    end(5 * S),
    { dt: 2 * 24 * H, kind: "expect", session: "§gap/g1", in: ["asking", "calm"] },
    // The stall fires three days after the item entered asking; the project looks for it at once.
    { dt: 3 * 24 * H + 30 * S, kind: "expect", session: "§gap/g1", in: ["asking", "stalled"] },
    { dt: 3 * 24 * H + 30 * S + 1, kind: "expect", session: "project", in: ["running"], reasonKinds: ["item/stalled"] },
  ]));
  fx.push(base("syn-spec-edited-keep", "a promoted decision edited in the spec: the item waits on the operator's Keep, then goes on", "2026-09-28T10:00:00Z", [
    ...toPromoted(1 * S),
    { dt: 9 * M, kind: "expect", session: "§gap/g1", in: ["awaiting-build"] },
    { dt: 10 * M, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "promoted", edited: true },
    { dt: 10 * M + 1, kind: "expect", session: "§gap/g1", in: ["spec-edited"] },
    { dt: 11 * M, kind: "operator", act: "settle-text", gap: "§gap/g1", value: "keep" },
    { dt: 12 * M, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "promoted", edited: false },
    { dt: 12 * M + 1, kind: "expect", session: "§gap/g1", in: ["awaiting-build"] },
  ]));
  fx.push(base("syn-conflict-two-gaps", "decisions of two gaps conflict; the settle session answers with one of them, and both items follow the winner", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "gap", id: "§gap/g1", status: "open" },
    { dt: 2 * S, kind: "fact", entity: "gap", id: "§gap/g2", status: "open" },
    opTurn(3 * S),
    ...gathering(4 * S, "§gap/g1", "b1"),
    ...gathering(5 * S, "§gap/g2", "b2"),
    end(6 * S),
    { dt: 2 * M, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "pending", ownerArea: true },
    { dt: 3 * M, kind: "fact", entity: "baton", id: "b1", state: "done", wrote: true },
    { dt: 4 * M, kind: "fact", entity: "decision", id: "d2", baton: "b2", state: "pending", ownerArea: true },
    { dt: 5 * M, kind: "fact", entity: "baton", id: "b2", state: "done", wrote: true },
    { dt: 10 * M, kind: "operator", act: "reconcile" },
    { dt: 10 * M + 1, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "conflict" },
    { dt: 10 * M + 1, kind: "fact", entity: "decision", id: "d2", baton: "b2", state: "conflict" },
    { dt: 10 * M + 1, kind: "fact", entity: "conflict", id: "k1", state: "open", settleBaton: "b3" },
    { dt: 10 * M + 2, kind: "fact", entity: "baton", id: "b3", state: "open", by: "overseer", settle: true },
    { dt: 10 * M + 3, kind: "expect", session: "§gap/g1", in: ["conflicted"] },
    { dt: 10 * M + 4, kind: "expect", session: "§gap/g2", in: ["conflicted"] },
    { dt: 15 * M, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "superseded", supersededBy: "d2" },
    { dt: 15 * M, kind: "fact", entity: "decision", id: "d2", baton: "b2", state: "drafted" },
    { dt: 15 * M, kind: "fact", entity: "conflict", id: "k1", state: "resolved", outcome: "b" },
    { dt: 15 * M + 1, kind: "fact", entity: "baton", id: "b3", state: "done", wrote: true },
    { dt: 15 * M + 2, kind: "expect", session: "§gap/g1", in: ["drafted"] },
    { dt: 15 * M + 3, kind: "expect", session: "§gap/g2", in: ["drafted"] },
    { dt: 16 * M, kind: "fact", entity: "decision", id: "d2", baton: "b2", state: "promoted", by: "operator" },
    { dt: 16 * M + 1, kind: "expect", session: "§gap/g1", in: ["awaiting-build"] },
    { dt: 16 * M + 2, kind: "expect", session: "§gap/g2", in: ["awaiting-build"] },
  ]));
  fx.push(base("syn-promote-two-gaps", "one sova_promote names decisions of two gaps: each item takes its own ids", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "gap", id: "§gap/g1", status: "open" },
    { dt: 2 * S, kind: "fact", entity: "gap", id: "§gap/g2", status: "open" },
    opTurn(3 * S),
    ...gathering(4 * S, "§gap/g1", "b1"),
    ...gathering(5 * S, "§gap/g2", "b2"),
    end(6 * S),
    { dt: 2 * M, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "pending", ownerArea: true },
    { dt: 2 * M + 1, kind: "fact", entity: "decision", id: "d2", baton: "b2", state: "pending", ownerArea: true },
    { dt: 3 * M, kind: "fact", entity: "baton", id: "b1", state: "done", wrote: true },
    { dt: 3 * M + 1, kind: "fact", entity: "baton", id: "b2", state: "done", wrote: true },
    opTurn(5 * M),
    tool(5 * M + 1 * S, "sova_reconcile", { attended: true }),
    { dt: 5 * M + 2 * S, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "drafted", by: "overseer" },
    { dt: 5 * M + 2 * S, kind: "fact", entity: "decision", id: "d2", baton: "b2", state: "drafted", by: "overseer" },
    tool(5 * M + 3 * S, "sova_promote", { attended: true, args: { ids: ["d1", "d2"] } }),
    { dt: 5 * M + 4 * S, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "promoted", by: "overseer" },
    { dt: 5 * M + 4 * S, kind: "fact", entity: "decision", id: "d2", baton: "b2", state: "promoted", by: "overseer" },
    end(5 * M + 5 * S),
    { dt: 5 * M + 6 * S, kind: "expect", session: "§gap/g1", in: ["awaiting-build"] },
    { dt: 5 * M + 7 * S, kind: "expect", session: "§gap/g2", in: ["awaiting-build"] },
  ]));
  fx.push(base("syn-baton-done-then-closed", "a gathering reaches its goal with decisions, then the operator closes it: the item stays deciding", "2026-09-28T10:00:00Z", [
    ...person,
    { dt: 1 * S, kind: "fact", entity: "gap", id: "§gap/g1", status: "open" },
    opTurn(2 * S),
    ...gathering(3 * S, "§gap/g1", "b1"),
    end(5 * S),
    { dt: 2 * M, kind: "fact", entity: "decision", id: "d1", baton: "b1", state: "pending", ownerArea: true },
    { dt: 3 * M, kind: "fact", entity: "baton", id: "b1", state: "done", wrote: true },
    { dt: 3 * M + 1, kind: "expect", session: "§gap/g1", in: ["unreconciled"] },
    { dt: 4 * M, kind: "fact", entity: "baton", id: "b1", state: "closed" },
    { dt: 4 * M + 1, kind: "expect", session: "§gap/g1", in: ["unreconciled"], notIn: ["open", "asking"] },
  ]));
  fx.push(base("syn-build-failed-l3", "a build's turn fails; an unattended prompt at L2 is refused (needs L3), and once the level is L3 it runs", "2026-09-28T10:00:00Z", [
    ...building(1 * S),
    { dt: 10 * M, kind: "fact", entity: "build", id: "c1", running: false, lastFailed: true, by: "overseer" },
    { dt: 10 * M + 1, kind: "expect", session: "§gap/g1", in: ["failed"] },
    { dt: 11 * M, kind: "setting", key: "autonomy", value: "L2", src: "synthetic" },
    watch(12 * M, [{ kind: "turn-failed", soon: true }], { level: "L2" }),
    tool(12 * M + 5 * S, "sova_send", { level: "L2", verdict: "refused", refusal: "autonomy", levelAtCall: "L2", args: { session: "c1" } }),
    end(12 * M + 10 * S),
    { dt: 13 * M, kind: "setting", key: "autonomy", value: "L3", src: "synthetic" },
    { dt: 14 * M, kind: "operator", act: "run-now" },
    watch(14 * M + 1 * S, [], { runAll: true }),
    tool(14 * M + 5 * S, "sova_send", { args: { session: "c1" } }),
    { dt: 14 * M + 6 * S, kind: "fact", entity: "build", id: "c1", running: true, by: "overseer" },
    end(14 * M + 10 * S),
    { dt: 14 * M + 11 * S, kind: "expect", session: "§gap/g1", in: ["working"] },
  ]));
  for (const t of fx) writeFileSync(join(out, `${t.id}.json`), compact(t));
    return fx.length;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
const SYNTHETIC = opt("--synthetic", null);
if (isMain && SYNTHETIC) console.log(`${writeSynthetic(SYNTHETIC)} synthetic traces`);
else if (isMain) main();
void statSync;
void createHash;
