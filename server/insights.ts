import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentsInsight,
  CompactionInfo,
  LiveAgentSession,
  OutlineTopic,
  SessionInsight,
  SessionOutline,
  TeamInfo,
  TeamMember,
  UsageInsight,
  UsageProvider,
  UsageWindow,
  WorkerInfo,
  WorkerStatus,
} from "../shared/protocol";
import { readLiveRecords, type RawLiveRecord } from "./live";
import { resolveSessionPath } from "./paths";
import { activeBranch, parseLines } from "./transcript";

// Read-only views over what the user's pi extensions leave on disk (sources and shapes:
// docs/insights-research.md "Data sources"). Nothing here writes to ~/.pi. Every source is
// untrusted JSON: anything malformed is skipped, and a missing source yields an empty payload.

type Rec = Record<string, any>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// ---------------------------------------------------------------------------
// Usage: ~/.pi/agent/cache/usage-status.json (written by the usage-status extension)

const USAGE_FILE = join(getAgentDir(), "cache", "usage-status.json");
/** Only TUI pis refresh the cache (every 180s); older than this means nothing is refreshing it. */
const USAGE_STALE_MS = 10 * 60_000;

let usageCache: { mtimeMs: number; size: number; data: Omit<UsageInsight, "stale"> } | null = null;

function usageWindow(label: string, w: unknown): UsageWindow | null {
  if (!isRec(w)) return null;
  const pct = num(w.pct);
  if (pct === undefined) return null;
  const resetsAt = str(w.resetsAt);
  return resetsAt ? { label, pct, resetsAt } : { label, pct };
}

function usageProvider(id: UsageProvider["id"], data: unknown, error: unknown): UsageProvider {
  const err = str(error);
  const withError = (p: UsageProvider): UsageProvider => (err ? { ...p, error: err } : p);
  if (!isRec(data)) return { id, state: "error", windows: [], error: err ?? "no data" };
  const state = str(data.state);
  if (state === "ok") {
    const windows: (UsageWindow | null)[] =
      id === "claude"
        ? [usageWindow("5h", data.fiveHour), usageWindow("7d", data.sevenDay), usageWindow("7d opus", data.sevenDayOpus)]
        : id === "openai"
          ? (Array.isArray(data.windows) ? data.windows : []).map((w: unknown) =>
              usageWindow(isRec(w) && typeof w.label === "string" ? w.label : "?", w))
          : [usageWindow("month", { pct: data.usedPct })];
    const valid = windows.filter((w): w is UsageWindow => w !== null);
    // "ok" without a readable window is what the extension renders as "n/a"
    return withError(valid.length ? { id, state: "ok", windows: valid } : { id, state: "na", windows: [] });
  }
  const known = ["nologin", "expired", "nokey", "badkey", "na"] as const;
  const s = known.find((k) => k === state) ?? "na";
  return withError({ id, state: s, windows: [] });
}

function parseUsage(text: string): Omit<UsageInsight, "stale"> | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  // Same validity rule as the extension's own reader (isCacheFile).
  if (!isRec(v) || num(v.fetchedAt) === undefined || !isRec(v.errors)) return null;
  return {
    available: true,
    fetchedAt: v.fetchedAt,
    nextFetchAt: num(v.nextFetchAt) ?? null,
    providers: [
      usageProvider("claude", v.claude, v.errors.claude),
      usageProvider("openai", v.openai, v.errors.openai),
      usageProvider("ollama", v.ollama, v.errors.ollama),
    ],
  };
}

export async function getUsageInsight(): Promise<UsageInsight> {
  const unavailable = (reason: "missing" | "corrupt"): UsageInsight => ({
    available: false,
    reason,
    fetchedAt: null,
    nextFetchAt: null,
    stale: false,
    providers: [],
  });
  let st;
  try {
    st = await stat(USAGE_FILE);
  } catch {
    return unavailable("missing");
  }
  if (!usageCache || usageCache.mtimeMs !== st.mtimeMs || usageCache.size !== st.size) {
    let data: Omit<UsageInsight, "stale"> | null;
    try {
      data = parseUsage(await readFile(USAGE_FILE, "utf8"));
    } catch (err) {
      return unavailable((err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt");
    }
    if (!data) return unavailable("corrupt");
    usageCache = { mtimeMs: st.mtimeMs, size: st.size, data };
  }
  const d = usageCache.data;
  return { ...d, stale: d.fetchedAt !== null && Date.now() - d.fetchedAt > USAGE_STALE_MS };
}

// ---------------------------------------------------------------------------
// Session JSONL facts: teams (subagents-team-v1), last worker reports (subagent-complete),
// topic-outline snapshot, compactions. One parse per (mtime, size), active branch only.

const TEAM_ENTRY = "subagents-team-v1";
const TEAM_ID = /^team_\d+$/;

interface RosterTeam {
  id: string;
  name: string;
  objective: string;
  createdAt: number;
  members: Omit<TeamMember, "worker" | "lastReport">[];
}
interface SessionFacts {
  teams: RosterTeam[];
  reports: Map<string, NonNullable<TeamMember["lastReport"]>>;
  outline: SessionOutline | null;
  compactions: CompactionInfo[];
}

const FACTS_MAX = 64;
const factsCache = new Map<string, { mtimeMs: number; size: number; facts: SessionFacts }>();

function decodeMember(m: unknown): RosterTeam["members"][number] | null {
  if (!isRec(m)) return null;
  const workerId = str(m.workerId);
  const role = str(m.role);
  const backend = str(m.backend);
  const addedAt = num(m.addedAt);
  if (!workerId || !role || !backend || addedAt === undefined) return null;
  const model = str(m.model);
  return {
    workerId,
    role,
    orchestrator: m.orchestrator === true,
    backend,
    ...(model ? { model } : {}),
    ownedPaths: strings(m.ownedPaths),
    addedAt,
  };
}

function addTeamEntry(teams: Map<string, RosterTeam>, data: unknown): void {
  if (!isRec(data) || data.version !== 1 || !Array.isArray(data.members)) return;
  const members = data.members.map(decodeMember);
  if (members.some((m) => !m)) return; // like the extension: never adopt a partial entry
  const valid = members as RosterTeam["members"];
  if (data.op === "create" && isRec(data.team)) {
    const t = data.team;
    const id = str(t.id);
    const createdAt = num(t.createdAt);
    if (!id || !TEAM_ID.test(id) || createdAt === undefined || teams.has(id)) return;
    teams.set(id, { id, name: str(t.name) ?? id, objective: str(t.objective) ?? "", createdAt, members: [...valid] });
  } else if (data.op === "add") {
    const team = teams.get(str(data.teamId) ?? "");
    if (!team) return;
    for (const m of valid) if (!team.members.some((x) => x.workerId === m.workerId)) team.members.push(m);
  }
}

// "### ag_08 (lead) — waiting · task success" (current) or "Subagent ag_02 (quick-2) finished its task." (older)
const REPORT_HEAD = /^### (ag_\d+) \([^)]*\) — ([a-z-]+)(?: · task ([a-z]+))?/;
const REPORT_OLD = /^Subagent (ag_\d+) \([^)]*\) finished its task/;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) for (const b of content) if (b?.type === "text" && typeof b.text === "string") return b.text;
  return "";
}

function addReport(reports: SessionFacts["reports"], e: Rec): void {
  const text = contentText(e.content);
  const at = str(e.timestamp) ?? "";
  const m = REPORT_HEAD.exec(text);
  if (m?.[1] && m[2]) {
    reports.set(m[1], { status: m[2], ...(m[3] ? { outcome: m[3] } : {}), at });
    return;
  }
  const old = REPORT_OLD.exec(text);
  if (old?.[1]) reports.set(old[1], { status: "finished", at });
}

const OUTLINE_STATES = new Set<SessionOutline["state"]>(["none", "drafting", "fresh", "updating", "stale", "failed-keeping-last"]);
const outlineState = (v: unknown, fallback: SessionOutline["state"]): SessionOutline["state"] =>
  OUTLINE_STATES.has(v as SessionOutline["state"]) ? (v as SessionOutline["state"]) : fallback;

/** Latest topic-outline snapshot (data.version 2), as the extension's OutlineStore.restore reads it. */
function decodeOutline(data: unknown): SessionOutline | null {
  if (!isRec(data) || data.version !== 2 || !Array.isArray(data.topics)) return null;
  const topics: OutlineTopic[] = [];
  for (const t of data.topics) {
    if (!isRec(t) || typeof t.id !== "string" || typeof t.heading !== "string" || !Array.isArray(t.summary)) continue;
    topics.push({
      id: t.id,
      heading: t.heading,
      bullets: strings(t.summary),
      at: num(t.at) ?? 0,
      manual: t.manual === true,
      entryId: isRec(t.anchor) ? (str(t.anchor.entryId) ?? null) : null,
    });
  }
  return {
    now: str(data.now) ?? "",
    overall: str(data.overall) ?? "",
    lastHeading: str(data.lastHeading) || str(data.lastManualHeading) || null,
    state: outlineState(data.state, "stale"),
    generatedAt: num(data.generatedAt) ?? 0,
    topics,
  };
}

function decodeCompaction(e: Rec): CompactionInfo {
  const details = isRec(e.details) ? e.details : {};
  return {
    id: str(e.id) ?? "",
    timestamp: str(e.timestamp) ?? "",
    tokensBefore: num(e.tokensBefore) ?? null,
    summary: str(e.summary) ?? "",
    readFiles: strings(details.readFiles),
    modifiedFiles: strings(details.modifiedFiles),
  };
}

function extractFacts(text: string): SessionFacts {
  const teams = new Map<string, RosterTeam>();
  const reports: SessionFacts["reports"] = new Map();
  let outlineData: unknown;
  const compactions: CompactionInfo[] = [];
  for (const e of activeBranch(parseLines(text))) {
    if (e.type === "custom" && e.customType === TEAM_ENTRY) addTeamEntry(teams, e.data);
    else if (e.type === "custom" && e.customType === "topic-outline") outlineData = e.data;
    else if (e.type === "custom_message" && e.customType === "subagent-complete") addReport(reports, e);
    else if (e.type === "compaction") compactions.push(decodeCompaction(e));
  }
  return { teams: [...teams.values()], reports, outline: decodeOutline(outlineData), compactions };
}

const EMPTY_FACTS: SessionFacts = { teams: [], reports: new Map(), outline: null, compactions: [] };

async function sessionFacts(path: string): Promise<SessionFacts> {
  try {
    const st = await stat(path);
    const hit = factsCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.facts;
    const facts = extractFacts(await readFile(path, "utf8"));
    factsCache.delete(path); // re-insert as most recent
    factsCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, facts });
    while (factsCache.size > FACTS_MAX) {
      const oldest = factsCache.keys().next().value;
      if (oldest === undefined) break;
      factsCache.delete(oldest);
    }
    return facts;
  } catch {
    return EMPTY_FACTS;
  }
}

// ---------------------------------------------------------------------------
// Live registry (sessions/live/*.json, contract: pi-config/extensions/sessions/public/SCHEMA.md)

const FRESH_MS = 15_000;
const FUTURE_SLACK_MS = 5 * 60_000;
const WORKER_STATUSES = new Set<WorkerStatus>(["starting", "running", "waiting", "stopping", "done", "error", "killed"]);
const WORKER_ALIASES: Record<string, WorkerStatus> = {
  busy: "running",
  working: "running",
  idle: "waiting",
  waiting_input: "waiting",
  completed: "done",
  finished: "done",
  failed: "error",
  stopped: "killed",
};
/** Settled statuses, same set working-subagent-count.ts treats as not working. */
const IDLE = new Set<WorkerStatus>(["waiting", "done", "error", "killed"]);

function workerStatus(v: unknown): WorkerStatus {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (WORKER_STATUSES.has(s as WorkerStatus)) return s as WorkerStatus;
  return WORKER_ALIASES[s] ?? "running"; // schema: unknown ⇒ running
}

function decodeWorker(w: unknown): WorkerInfo | null {
  if (!isRec(w) || typeof w.id !== "string") return null;
  const status = workerStatus(w.status);
  const out: WorkerInfo = { id: w.id, name: str(w.name) ?? w.id, status, working: !IDLE.has(status) };
  const model = str(w.model);
  const backend = str(w.backend);
  const preview = str(w.preview);
  if (model) out.model = model;
  if (backend) out.backend = backend;
  if (preview) out.preview = preview;
  for (const k of ["startedAt", "lastActivity", "endedAt"] as const) {
    const t = num(w[k]);
    if (t !== undefined) out[k] = t;
  }
  if (w.outcome === "success" || w.outcome === "error" || w.outcome === "aborted") out.outcome = w.outcome;
  return out;
}

function decodeWorkers(presence: Rec | undefined): WorkerInfo[] {
  if (!Array.isArray(presence?.workers)) return [];
  return presence.workers.map(decodeWorker).filter((w: WorkerInfo | null): w is WorkerInfo => w !== null);
}

function sessionState(presence: Rec | undefined, session: Rec): LiveAgentSession["state"] {
  const a = presence && isRec(presence.activity) ? presence.activity.state : undefined;
  if (a === "working" || a === "idle" || a === "needs-input" || a === "error") return a;
  const label = str(presence?.status) ?? str(session.status) ?? "";
  if (/^Running/.test(label)) return "working";
  if (label === "Needs input") return "needs-input";
  if (/^Error|error/.test(label)) return "error";
  return "idle";
}

function joinTeams(facts: SessionFacts, parentPath: string, workers: WorkerInfo[] | null): TeamInfo[] {
  const byId = new Map((workers ?? []).map((w) => [w.id, w]));
  return facts.teams.map((t) => {
    const members: TeamMember[] = t.members.map((m) => {
      const worker = byId.get(m.workerId) ?? null;
      if (worker) worker.teamId = t.id;
      const report = facts.reports.get(m.workerId);
      return { ...m, worker, ...(report ? { lastReport: report } : {}) };
    });
    return {
      id: t.id,
      name: t.name,
      objective: t.objective,
      createdAt: t.createdAt,
      parentPath,
      live: workers !== null,
      members,
      working: members.filter((m) => m.worker?.working).length,
    };
  });
}

async function liveSession({ sessionFile, pid, rec }: RawLiveRecord): Promise<LiveAgentSession | null> {
  const session = isRec(rec.session) ? rec.session : null;
  if (!session) return null;
  const presence = isRec(rec.presence) ? rec.presence : undefined;
  const heartbeat = num(rec.heartbeat) ?? 0;
  const age = Date.now() - heartbeat;
  const workers = decodeWorkers(presence);
  const wc = isRec(presence?.workerCounts) ? presence.workerCounts : null;
  const workerCounts = wc
    ? { total: count(wc.total), working: count(wc.working), waiting: count(wc.waiting), done: count(wc.done), error: count(wc.error), killed: count(wc.killed) }
    : {
        total: workers.length,
        working: workers.filter((w) => w.working).length,
        waiting: workers.filter((w) => w.status === "waiting").length,
        done: workers.filter((w) => w.status === "done").length,
        error: workers.filter((w) => w.status === "error").length,
        killed: workers.filter((w) => w.status === "killed").length,
      };
  // Only expose paths the rest of the API accepts as session keys.
  const path = sessionFile ? resolveSessionPath(sessionFile) : null;
  const teams = path ? joinTeams(await sessionFacts(path), path, workers) : [];
  return {
    path,
    sessionId: str(session.sessionId) ?? null,
    name: str(session.name) ?? null,
    cwd: str(session.cwd) ?? "",
    pid,
    mode: str(session.mode) ?? null,
    fresh: age <= FRESH_MS && age >= -FUTURE_SLACK_MS,
    state: sessionState(presence, session),
    workerCounts,
    workers,
    teams,
  };
}

/** Every running pi process (including this server's embedded runtimes), with workers and teams. */
export async function getAgentsInsight(): Promise<AgentsInsight> {
  const at = Date.now();
  const lastActivity = new Map<LiveAgentSession, number>();
  const sessions: LiveAgentSession[] = [];
  for (const raw of readLiveRecords({ includeOwn: true })) {
    try {
      const s = await liveSession(raw);
      if (!s) continue;
      sessions.push(s);
      lastActivity.set(s, num(raw.rec.session?.lastActivity) ?? 0);
    } catch {
      // malformed record: skip
    }
  }
  const busy = (s: LiveAgentSession) => s.state === "working" || s.workerCounts.working > 0;
  sessions.sort((a, b) => Number(busy(b)) - Number(busy(a)) || (lastActivity.get(b) ?? 0) - (lastActivity.get(a) ?? 0));

  // rpc-mode records are headless pis (e.g. subagent workers, already listed under their
  // parent's workers): not separate sessions. Stale records say nothing about "working now".
  const totals = { sessions: 0, working: 0, total: 0, teams: 0, teamWorking: 0, soloWorking: 0 };
  for (const s of sessions) {
    if (s.mode === "rpc") continue;
    totals.sessions++;
    totals.total += s.workerCounts.total;
    totals.teams += s.teams.length;
    if (!s.fresh) continue;
    totals.working += s.workerCounts.working;
    for (const t of s.teams) totals.teamWorking += t.working;
  }
  totals.soloWorking = Math.max(0, totals.working - totals.teamWorking);
  return { at, totals, sessions };
}

// ---------------------------------------------------------------------------
// Per-session insight: outline + compactions + teams

/** The live record's outline (topic-outline broadcast) may be newer than the last JSONL snapshot. */
function overlayOutline(disk: SessionOutline | null, live: unknown): SessionOutline | null {
  if (!isRec(live)) return disk;
  const generatedAt = num(live.generatedAt) ?? 0;
  if (disk && generatedAt < disk.generatedAt) return disk;
  const state = outlineState(live.state, disk?.state ?? "none");
  if (!disk) {
    // No snapshot on disk yet: headings (+ shared detail bullets) from the broadcast only.
    const detail = new Map<string, string[]>();
    if (Array.isArray(live.detail))
      for (const d of live.detail) if (isRec(d) && typeof d.heading === "string") detail.set(d.heading, strings(d.bullets));
    const topics = strings(live.topics).map((heading, i) => ({
      id: `live${i + 1}`,
      heading,
      bullets: detail.get(heading) ?? [],
      at: generatedAt,
      manual: false,
      entryId: null,
    }));
    const now = str(live.now) ?? "";
    if (!topics.length && !now && state === "none") return null;
    return { now, overall: str(live.overall) ?? "", lastHeading: str(live.lastHeading) ?? null, state, generatedAt, topics };
  }
  return {
    ...disk,
    now: str(live.now) || disk.now,
    overall: str(live.overall) || disk.overall,
    lastHeading: str(live.lastHeading) ?? disk.lastHeading,
    state,
    generatedAt: Math.max(generatedAt, disk.generatedAt),
  };
}

/** `path` must already be validated with resolveSessionPath(). Never throws. */
export async function getSessionInsight(path: string): Promise<SessionInsight> {
  const facts = await sessionFacts(path);
  let live: RawLiveRecord | undefined;
  try {
    live = readLiveRecords({ includeOwn: true }).find((r) => r.sessionFile === path);
  } catch {
    live = undefined;
  }
  const presence = isRec(live?.rec.presence) ? live.rec.presence : undefined;
  const workers = live ? decodeWorkers(presence) : null;
  return {
    outline: live ? overlayOutline(facts.outline, presence?.outline) : facts.outline,
    compactions: facts.compactions,
    teams: joinTeams(facts, path, workers),
  };
}
