import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentsInsight,
  CompactionInfo,
  ExplanationInfo,
  LiveAgentSession,
  ModelSpend,
  OutlineSnapshot,
  OutlineTopic,
  RewindInfo,
  SessionInsight,
  SessionOutline,
  SessionSkills,
  SessionUsage,
  SpendOrigin,
  TeamInfo,
  TeamMember,
  TokenUsage,
  TokenUsageTotal,
  UsageInsight,
  UsageBalance,
  UsageProvider,
  UsageWindow,
  WorkerInfo,
  WorkerStatus,
} from "../shared/protocol";
// The usage-status extension's fetch/cache core. Part of the sanctioned pi-config import
// surface (node builtins only, like extensions/mode/state.ts) — see CLAUDE.md.
import { forceRefresh } from "../pi-config/extensions/usage-status/fetch.ts";
import { hasPage, listExplanations, sortExplanations } from "./explanations";
import { readLiveRecords, type RawLiveRecord } from "./live";
import { modelProvider } from "./models";
import { resolveSessionPath } from "./paths";
import { collectSkills, hasSkills } from "./skills";
import { activeBranch, parseLines } from "./transcript";
import { LAST_KNOWN_REASON, lastKnownUsage, rememberUsage } from "./usage-last-known";
import { workerSkills } from "./worker-skills";

// Read-only views over what the user's pi extensions leave on disk (sources and shapes:
// docs/insights-research.md "Data sources"). The one writer is refreshUsageInsight, which
// force-refreshes the shared usage cache through the extension's own lock protocol. Every
// source is untrusted JSON: anything malformed is skipped, and a missing source yields an
// empty payload.

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

let usageCache: { mtimeMs: number; size: number; data: Omit<UsageInsight, "stale">; absent: UsageProvider["id"][] } | null = null;

const USAGE_PROVIDERS = ["claude", "openai", "ollama", "zai", "deepseek"] as const satisfies readonly UsageProvider["id"][];
const USAGE_META_KEYS = new Set(["schemaVersion", "fetchedAt", "nextFetchAt", "errors"]);

/** Cache shapes we don't recognize are logged once per process, not on every poll. */
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[insights] ${message}`);
}

function usageWindow(label: string, w: unknown): UsageWindow | null {
  if (!isRec(w)) return null;
  const pct = num(w.pct);
  if (pct === undefined) return null;
  const resetsAt = str(w.resetsAt);
  return resetsAt ? { label, pct, resetsAt } : { label, pct };
}

function mcpWindow(m: unknown): UsageWindow | null {
  const w = usageWindow("mcp", m);
  if (!w || !isRec(m)) return w;
  const used = num(m.used);
  const limit = num(m.limit);
  return used !== undefined && limit !== undefined && used >= 0 && limit >= 0 ? { ...w, used, limit } : w;
}

/**
 * Claude: `limits[]` (newer caches: every window in source order, incl. model-scoped ones like
 * "7d scoped" with scope "Fable") when it yields a valid entry, else the legacy named windows.
 */
function claudeWindows(data: Rec): (UsageWindow | null)[] {
  if (Array.isArray(data.limits) && data.limits.length) {
    const windows: UsageWindow[] = [];
    data.limits.forEach((l: unknown, i: number) => {
      const w = isRec(l) && typeof l.label === "string" && l.label ? usageWindow(l.label, l) : null;
      if (!w || !isRec(l)) {
        warnOnce(`shape:claude:limits`, `usage-status.json: skipped unrecognized claude.limits entry (index ${i})`);
        return;
      }
      if (typeof l.scope === "string" && l.scope) w.scope = l.scope;
      if (typeof l.active === "boolean") w.active = l.active;
      windows.push(w);
    });
    if (windows.length) return windows;
  }
  return [usageWindow("5h", data.fiveHour), usageWindow("7d", data.sevenDay), usageWindow("7d opus", data.sevenDayOpus)];
}

/**
 * DeepSeek has no usage API, only prepaid credit: the first readable entry of `balances[]` (an
 * object with a non-empty currency and a finite total; granted/toppedUp default to 0). `available`
 * is the provider's own flag: false = it says calls can't be funded.
 */
function usageBalance(data: Rec): UsageBalance | null {
  const entries = Array.isArray(data.balances) ? data.balances : [];
  for (const b of entries) {
    if (!isRec(b)) continue;
    const currency = str(b.currency);
    const total = num(b.total);
    if (!currency || total === undefined) continue;
    return { currency, total, granted: num(b.granted) ?? 0, toppedUp: num(b.toppedUp) ?? 0, available: data.available !== false };
  }
  return null;
}

function usageProvider(id: UsageProvider["id"], data: unknown, error: unknown): UsageProvider {
  const err = str(error);
  const withError = (p: UsageProvider): UsageProvider => (err ? { ...p, error: err } : p);
  // Absent = never fetched OK (or a cache from before this source existed).
  if (data === undefined) return { id, state: "error", windows: [], error: err ?? "no data" };
  const unrecognized = (what: string): UsageProvider => {
    warnOnce(`shape:${id}:${what}`, `usage-status.json: unrecognized ${id} data (${what}); reporting "na"`);
    return withError({ id, state: "na", windows: [] });
  };
  if (!isRec(data)) return unrecognized(`not an object: ${typeof data}`);
  const state = str(data.state);
  if (state === "ok") {
    // A credit provider reports money left, never windows.
    if (id === "deepseek") {
      const balance = usageBalance(data);
      return balance ? withError({ id, state: "ok", windows: [], balance }) : unrecognized("state ok without a readable balance");
    }
    const windows: (UsageWindow | null)[] =
      id === "claude"
        ? claudeWindows(data)
        : id === "openai"
          ? (Array.isArray(data.windows) ? data.windows : []).map((w: unknown) =>
              usageWindow(isRec(w) && typeof w.label === "string" ? w.label : "?", w))
          : id === "zai"
            ? [
                // coding-plan window, labelled by its length ("5h", "1d", "1w", "45m")
                usageWindow(isRec(data.fiveHour) ? (str(data.fiveHour.label) ?? "plan") : "plan", data.fiveHour),
                // MCP call quota, with its raw call counts when both are valid
                mcpWindow(data.mcp),
              ]
            : [usageWindow("month", { pct: data.usedPct })];
    const valid = windows.filter((w): w is UsageWindow => w !== null);
    // "ok" without a readable window is what the extension renders as "n/a"
    return valid.length ? withError({ id, state: "ok", windows: valid }) : unrecognized("state ok without a readable window");
  }
  const known = ["nologin", "expired", "nokey", "badkey", "na"] as const;
  const s = known.find((k) => k === state);
  return s ? withError({ id, state: s, windows: [] }) : unrecognized(`state ${JSON.stringify(state ?? null)}`);
}

/**
 * `absent`: providers with no KEY at all in this cache. That is the signature of an older pi
 * session rewriting the file from a pre-deepseek extension it still holds in memory (schemaVersion
 * 2), not of a provider the current extension has nothing to say about — which always writes a key.
 */
function parseUsage(text: string): { data: Omit<UsageInsight, "stale">; absent: UsageProvider["id"][] } | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  // Same validity rule as the extension's own reader (isCacheFile).
  if (!isRec(v) || num(v.fetchedAt) === undefined || !isRec(v.errors)) return null;
  const errors = v.errors;
  // UsageProvider.id is a closed union: providers added to the extension later are skipped (and logged).
  for (const key of Object.keys(v))
    if (!USAGE_META_KEYS.has(key) && !(USAGE_PROVIDERS as readonly string[]).includes(key))
      warnOnce(`provider:${key}`, `usage-status.json: unknown provider "${key}" skipped`);
  return {
    data: {
      available: true,
      fetchedAt: v.fetchedAt,
      nextFetchAt: num(v.nextFetchAt) ?? null,
      // fixed order; a provider absent from an older cache comes back as "error", never omitted
      providers: USAGE_PROVIDERS.map((id) => usageProvider(id, v[id], errors[id])),
    },
    absent: USAGE_PROVIDERS.filter((id) => v[id] === undefined),
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
    let parsed: { data: Omit<UsageInsight, "stale">; absent: UsageProvider["id"][] } | null;
    try {
      parsed = parseUsage(await readFile(USAGE_FILE, "utf8"));
    } catch (err) {
      return unavailable((err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt");
    }
    if (!parsed) return unavailable("corrupt");
    // Once per new cache file, not per poll: the store skips the write when nothing changed.
    rememberUsage(parsed.data.providers);
    usageCache = { mtimeMs: st.mtimeMs, size: st.size, data: parsed.data, absent: parsed.absent };
  }
  const { data: d, absent } = usageCache;
  // A key the cache doesn't carry: serve what we last read for it, said plainly. A key that IS
  // there always wins, error and "na" included — that is the extension's own answer.
  const providers = absent.length === 0 ? d.providers : d.providers.map((p) => (absent.includes(p.id) ? lastKnown(p) : p));
  return { ...d, providers, stale: d.fetchedAt !== null && Date.now() - d.fetchedAt > USAGE_STALE_MS };
}

/** Single-flight: concurrent Refresh clicks share one force-fetch. */
let usageRefreshInFlight: Promise<UsageInsight> | null = null;

/**
 * `POST /api/insights/usage/refresh`: force-refresh the shared usage cache through the
 * extension's lock protocol — the same thing /usage-refresh does in a TUI — then serve the
 * re-read file. Per-provider failures live in the cache's own `errors` and surface as each
 * provider's `error`; this rejects only when the refresh machinery itself fails (another
 * holder never publishes, or the cache can't be written).
 */
export async function refreshUsageInsight(): Promise<UsageInsight> {
  usageRefreshInFlight ??= (async () => {
    await forceRefresh();
    usageCache = null; // the file was just rewritten; drop the memo so the read below re-parses it
    return getUsageInsight();
  })().finally(() => {
    usageRefreshInFlight = null;
  });
  return usageRefreshInFlight;
}

/** The stored reading for a provider the cache didn't mention, or the "no data" answer as-is. */
function lastKnown(p: UsageProvider): UsageProvider {
  const prev = lastKnownUsage(p.id);
  return prev ? { ...prev, error: LAST_KNOWN_REASON } : p;
}

// ---------------------------------------------------------------------------
// Session JSONL facts: teams (subagents-team-v1), last worker reports (subagent-complete),
// topic-outline snapshot, compactions. One parse per (mtime, size), active branch only.

const TEAM_ENTRY = "subagents-team-v1";
/** The explain extension's completion entry; server/transcript.ts turns it into a report row. */
const EXPLAIN_ENTRY = "explain-doc";
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
  /** Every accepted topic-outline snapshot, oldest first (see addOutlineSnapshot). */
  outlines: OutlineSnapshot[];
  compactions: CompactionInfo[];
  /** The branch's rewinds, oldest first: the markers pi-web leaves when the chat goes back before a
      message. Hidden from the transcript on purpose, so this is the only way to see one. */
  rewinds: RewindInfo[];
  /** The session's own id, from the header line: the parentSessionId /explain entries carry. */
  sessionId: string | null;
  /** explain-doc entries on the active branch (the store is the other half; see explanations()). */
  explanations: ExplanationInfo[];
  /** Main-thread spend from the active branch's assistant usage, per model (a model switch adds
      a row). Workers are NOT included: they join in getSessionInsight from the live record. */
  usage: { main: ModelSpendTotal; models: ModelSpendTotal[] };
  /** Which skills the branch's prompt offered, and which were loaded: see skills.ts. */
  skills: SessionSkills;
}

const FACTS_MAX = 64;
const factsCache = new Map<string, { mtimeMs: number; size: number; facts: SessionFacts }>();

/** A mutable token/cost Σ (protocol TokenUsage minus the optional cost). */
interface ModelSpendTotal {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}
const zeroSpend = (model: string): ModelSpendTotal => ({ model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const amount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
/** Assistant usage carries cost as {total}; WorkerUsage.cost is already a number. */
type UsageLike = { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: unknown };
function addUsage(t: ModelSpendTotal, u: UsageLike | undefined | null): void {
  if (!u || typeof u !== "object") return;
  t.input += amount(u.input);
  t.output += amount(u.output);
  t.cacheRead += amount(u.cacheRead);
  t.cacheWrite += amount(u.cacheWrite);
  t.cost += amount(isRec(u.cost) ? u.cost.total : u.cost);
}
const spentSpend = (t: ModelSpendTotal): boolean => t.input + t.output + t.cacheRead + t.cacheWrite > 0;

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
      // The anchor's own clock, kept apart from `at` (the summarizer's). Optional, so a snapshot
      // from an older extension simply has neither.
      ...(isRec(t.anchor) && num(t.anchor.timestamp) ? { anchorAt: num(t.anchor.timestamp)! } : {}),
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

/** How many past summaries an insight carries. Real sessions hold 6–17 snapshots; the cap only
    bites on a pathological file, and without it every 3s insight poll would ship the whole series.
    It drops the OLDEST ones: the timeline's recent end is the part a reader works from. */
const OUTLINE_SNAPSHOTS_MAX = 200;

/** Adds one topic-outline entry to the series, validated by decodeOutline like the latest one. A
    malformed or older-version payload, one with no summary text, or a repeat of the previous
    accepted summary adds nothing: the axis should show each summary once. */
function addOutlineSnapshot(list: OutlineSnapshot[], e: Rec): void {
  const o = decodeOutline(e.data);
  const id = str(e.id);
  const timestamp = str(e.timestamp);
  if (!o || !id || !timestamp || (!o.now && !o.overall)) return;
  const prev = list[list.length - 1];
  if (prev && prev.now === o.now && prev.overall === o.overall) return;
  list.push({ id, timestamp, now: o.now, overall: o.overall, generatedAt: o.generatedAt });
}

/** One explain-doc entry's data, as server/transcript.ts explainRow reads it. */
function decodeExplanation(data: unknown): ExplanationInfo | null {
  if (!isRec(data)) return null;
  const id = str(data.id);
  const topic = str(data.topic);
  const createdAt = str(data.createdAt);
  if (!id || !topic || !createdAt) return null;
  const x: ExplanationInfo = { id, topic, summary: str(data.summary) ?? "", createdAt, parentSessionId: str(data.parentSessionId) ?? "" };
  const model = str(data.model);
  if (model) x.model = model;
  const error = str(data.error);
  const note = str(data.note);
  if (error) x.error = error;
  else if (note) x.note = note;
  return x;
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

/** The invisible custom entry a rewind appends — REWIND_ENTRY in chat-manager.ts, which owns the
    write. The literal is spelled again rather than imported: chat-manager imports THIS module, and
    the cycle would pull the pi SDK into every path that reads a session's facts, tests included. */
const REWIND_ENTRY = "pi-web-rewind";

/** One rewind marker, as chat-manager wrote it: ids and a stamp, no text (the abandoned turns are
    not on this branch). An entry missing either half can't be placed on an axis, so it is dropped. */
function decodeRewind(e: Rec): RewindInfo | null {
  const id = str(e.id);
  const timestamp = str(e.timestamp);
  if (!id || !timestamp) return null;
  const data = isRec(e.data) ? e.data : {};
  return { id, timestamp, targetId: str(data.targetId) ?? "", fromLeafId: str(data.fromLeafId) ?? "" };
}

function extractFacts(text: string): SessionFacts {
  const teams = new Map<string, RosterTeam>();
  const reports: SessionFacts["reports"] = new Map();
  let outlineData: unknown;
  const outlines: OutlineSnapshot[] = [];
  const compactions: CompactionInfo[] = [];
  const rewinds: RewindInfo[] = [];
  const explanations: ExplanationInfo[] = [];
  const main = zeroSpend("");
  const byModel = new Map<string, ModelSpendTotal>();
  const entries = parseLines(text);
  const header = entries.find((e) => e.type === "session");
  const branch = activeBranch(entries);
  for (const e of branch) {
    if (e.type === "custom" && e.customType === TEAM_ENTRY) addTeamEntry(teams, e.data);
    else if (e.type === "custom" && e.customType === "topic-outline") {
      outlineData = e.data;
      addOutlineSnapshot(outlines, e);
    }
    else if (e.type === "custom_message" && e.customType === "subagent-complete") addReport(reports, e);
    else if (e.type === "compaction") compactions.push(decodeCompaction(e));
    else if (e.type === "custom" && e.customType === REWIND_ENTRY) {
      const r = decodeRewind(e);
      if (r) rewinds.push(r);
    }
    else if (e.type === "custom" && e.customType === EXPLAIN_ENTRY) {
      const x = decodeExplanation(e.data);
      if (x) explanations.push(x);
    } else if (e.type === "message" && e.message?.role === "assistant" && isRec(e.message)) {
      // Per-model main-thread spend: assistant entries carry their own provider/model + usage.
      const m = e.message;
      if (typeof m.provider === "string" && typeof m.model === "string") {
        const ref = `${m.provider}/${m.model}`;
        const row = byModel.get(ref) ?? zeroSpend(ref);
        addUsage(row, m.usage);
        byModel.set(ref, row);
        addUsage(main, m.usage);
      }
    }
  }
  const models = [...byModel.values()].filter(spentSpend).sort((a, b) => a.model.localeCompare(b.model));
  return {
    teams: [...teams.values()],
    reports,
    outline: decodeOutline(outlineData),
    // Deduped first, then capped, so the cap counts distinct summaries.
    outlines: outlines.slice(-OUTLINE_SNAPSHOTS_MAX),
    compactions,
    rewinds,
    explanations,
    sessionId: (header ? str(header.id) : undefined) ?? null,
    usage: { main, models },
    skills: collectSkills(branch),
  };
}

const EMPTY_FACTS: SessionFacts = { teams: [], reports: new Map(), outline: null, outlines: [], compactions: [], rewinds: [], explanations: [], sessionId: null, usage: { main: zeroSpend(""), models: [] }, skills: { offered: [], used: [] } };

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

/** Token counts are advisory: a bad field is 0, a non-object usage is dropped. */
function decodeUsage(v: unknown): TokenUsage | undefined {
  if (!isRec(v)) return undefined;
  const cost = num(v.cost);
  return {
    input: count(v.input), output: count(v.output), cacheRead: count(v.cacheRead), cacheWrite: count(v.cacheWrite),
    ...(cost !== undefined && cost > 0 ? { cost } : {}),
  };
}

/** presence.workerUsage: the session-lifetime Σ. It covers workers the record no longer lists,
    so it is never recomputed from presence.workers. */
export function decodeUsageTotal(presence: Rec | undefined): TokenUsageTotal | undefined {
  if (!isRec(presence?.workerUsage)) return undefined;
  const usage = decodeUsage(presence.workerUsage);
  return usage ? { ...usage, workers: count(presence.workerUsage.workers) } : undefined;
}

function decodeWorker(w: unknown): WorkerInfo | null {
  if (!isRec(w) || typeof w.id !== "string") return null;
  const status = workerStatus(w.status);
  const out: WorkerInfo = { id: w.id, name: str(w.name) ?? w.id, status, working: !IDLE.has(status) };
  const model = str(w.model);
  const effort = str(w.effort);
  const backend = str(w.backend);
  const preview = str(w.preview);
  if (model) out.model = model;
  // The provider leads the pane's meta line: `claude code` for that backend (its own sub/route),
  // else the model's own provider from its ref or pi's cached catalogs. Unknown: no provider.
  const provider = backend === "claude-code" ? "claude code" : modelProvider(model);
  if (provider) out.provider = provider;
  if (effort) out.effort = effort;
  if (backend) out.backend = backend;
  if (preview) out.preview = preview;
  const sessionFile = str(w.sessionFile);
  const sessionId = str(w.sessionId);
  if (sessionFile) out.sessionFile = sessionFile;
  if (sessionId) out.sessionId = sessionId;
  for (const k of ["startedAt", "lastActivity", "endedAt"] as const) {
    const t = num(w[k]);
    if (t !== undefined) out[k] = t;
  }
  if (w.outcome === "success" || w.outcome === "error" || w.outcome === "aborted") out.outcome = w.outcome;
  const usage = decodeUsage(w.usage);
  if (usage) out.usage = usage;
  return out;
}

export function decodeWorkers(presence: Rec | undefined): WorkerInfo[] {
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
  const usageTotal = decodeUsageTotal(presence);
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
    embedded: pid === process.pid,
    state: sessionState(presence, session),
    workerCounts,
    workers,
    ...(usageTotal ? { usageTotal } : {}),
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
  // parent's workers): not separate sessions. This server's own chat runtimes are rpc too, but
  // they are sessions hosting agents. Stale records say nothing about "working now".
  const totals = { sessions: 0, working: 0, total: 0, teams: 0, teamWorking: 0, soloWorking: 0 };
  for (const s of sessions) {
    if (s.mode === "rpc" && !s.embedded) continue;
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

/**
 * This session's /explain artifacts: the store entries parented to it, plus any explain-doc entry
 * on its branch that the store can still serve (the recorded parentSessionId can be blank, so the
 * branch is how those are found). Deduped by id — the store wins, it is what /explain/<id> reads —
 * newest first.
 *
 * Everything here is openable: a failed run (entry carries `error`, no page was written) and an
 * entry whose store dir is gone are both left out, so the strip count and the gallery grid match
 * the pages that actually serve. A failure is shown once, as its failed thread row, and counted
 * nowhere. An entry carrying `note` DOES have a page — the run broke after writing it — so it is
 * listed, with the note, and stays linkable.
 */
async function explanations(facts: SessionFacts): Promise<ExplanationInfo[]> {
  const byId = new Map<string, ExplanationInfo>();
  if (facts.sessionId) for (const x of await listExplanations(facts.sessionId)) byId.set(x.id, x);
  for (const x of facts.explanations) {
    if (x.error) continue; // fatal: no page was written, so it is not one of this session's pages
    const stored = byId.get(x.id);
    // meta.json has no note field: the branch entry is the only place an advisory reason exists,
    // so carry it onto the store's copy rather than letting the dedupe drop it.
    if (stored) {
      if (x.note) stored.note = x.note;
    } else if (await hasPage(x.id)) {
      byId.set(x.id, { ...x }); // a copy: facts.explanations is cached per (mtime, size)
    }
  }
  return sortExplanations([...byId.values()]);
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
  const usageTotal = live ? decodeUsageTotal(presence) : undefined;
  const usage = buildUsage(facts, workers, usageTotal);
  // A worker's own transcript is the only record of what it loaded (see server/worker-skills.ts).
  // mtime-cached, because this endpoint is polled every 3s while the pane is open.
  const skillsLoaded = workers && workers.length > 0 ? await workerSkills(workers) : undefined;
  return {
    outline: live ? overlayOutline(facts.outline, presence?.outline) : facts.outline,
    ...(facts.outlines.length > 0 ? { outlines: facts.outlines } : {}),
    compactions: facts.compactions,
    ...(facts.rewinds.length > 0 ? { rewinds: facts.rewinds } : {}),
    teams: joinTeams(facts, path, workers),
    workers: workers ?? [],
    ...(hasSkills(facts.skills) ? { skills: facts.skills } : {}),
    ...(skillsLoaded ? { workerSkills: skillsLoaded } : {}),
    ...(usageTotal ? { usageTotal } : {}),
    ...(usage ? { usage } : {}),
    explanations: await explanations(facts),
  };
}

/** SessionUsage = main rows from the branch tally + worker rows from the live record (team
 *  members via teamId), or undefined while nothing was spent. The lifetime workers Σ rides along
 *  separately: it can exceed the worker rows (evicted workers). */
function buildUsage(
  facts: SessionFacts,
  workers: WorkerInfo[] | null,
  usageTotal: TokenUsageTotal | undefined,
): SessionUsage | undefined {
  const byKey = new Map<string, { t: ModelSpendTotal; origin: SpendOrigin }>();
  for (const m of facts.usage.models) byKey.set(`main:${m.model}`, { t: { ...m }, origin: "main" });
  for (const w of workers ?? []) {
    if (!w.usage) continue; // nothing spent yet / older pi-config
    const origin: SpendOrigin = w.teamId ? "team" : "subagents";
    const model = w.model || "unknown";
    const key = `${origin}:${model}`;
    const acc = byKey.get(key) ?? { t: zeroSpend(model), origin };
    addUsage(acc.t, w.usage);
    byKey.set(key, acc);
  }
  const order = { main: 0, subagents: 1, team: 2 } as const;
  const accs = [...byKey.values()].filter((a) => spentSpend(a.t));
  accs.sort((a, b) => order[a.origin] - order[b.origin] || a.t.model.localeCompare(b.t.model));
  const total = zeroSpend("");
  for (const a of accs) addUsage(total, a.t);
  if (!spentSpend(total)) return undefined;
  return {
    total: toUsage(total),
    main: toUsage(facts.usage.main),
    models: accs.map((a) => spendOf(a.t, a.origin)),
    ...(usageTotal ? { workersTotal: usageTotal } : {}),
  };
}

/** ModelSpendTotal → the wire shapes (cost only when it was reported). */
const toUsage = (t: ModelSpendTotal): TokenUsage => ({
  input: t.input,
  output: t.output,
  cacheRead: t.cacheRead,
  cacheWrite: t.cacheWrite,
  ...(t.cost > 0 ? { cost: t.cost } : {}),
});
const spendOf = (t: ModelSpendTotal, origin: SpendOrigin): ModelSpend => ({ model: t.model, origin, ...toUsage(t) });
