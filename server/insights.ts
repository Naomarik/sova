import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { agentRoot } from "./state-root";
import type {
  AgentsInsight,
  SessionWorktreeInfo,
  WorktreeReadiness,
  CompactionInfo,
  ExplanationInfo,
  LiveAgentSession,
  OutlineSnapshot,
  OutlineTopic,
  RewindInfo,
  SessionHiddenWorkers,
  SessionInsight,
  SessionOutline,
  SessionSkills,
  TeamDuty,
  TeamEvent,
  TeamInfo,
  TeamMember,
  ClaudeLoginRow,
  ClaudePoolInfo,
  ClaudePoolLogin,
  UsageClaudeLogin,
  UsageInsight,
  UsageBalance,
  UsageProvider,
  UsageWindow,
  WorkerInfo,
  WorkerStatus,
} from "../shared/protocol";
import type { HEntry } from "../shared/harness";
import type { LinkedAgentInfo } from "../shared/mesh-links";
// The usage-status extension's fetch/cache core. Part of the sanctioned pi-config import
// surface (node builtins only, like extensions/mode/state.ts) — see CLAUDE.md.
import { claudeLoginIds, forceRefresh } from "../pi-config/extensions/usage-status/fetch.ts";
// Ollama's declared reset day (usage-windows.json), the same sanctioned surface (builtins only).
import { monthlyWindow, readUsageWindows, setOllamaResetDay } from "../pi-config/extensions/usage-status/windows.ts";
import { ownClaudeLoginUnreadable, readAuthStatus, readClaudeLoginAuth } from "./auth-status";
import { ClaudeAccountsService } from "./claude-accounts";
import { hasPage, listExplanations, sortExplanations } from "./explanations";
import { readLiveRecords, type RawLiveRecord, workerCountsOf } from "./live";
import { modelProvider, sharedWorkerWindowResolver } from "./models";
import { resolveSessionPath } from "./paths";
import { collectSkills, hasSkills, skillLinesOf } from "./skills";
import { branchOf, parsePi, rawOf } from "./harness/pi/reader";
import { REWIND } from "./harness/state-kinds";
import { stateView } from "./harness/state-view";
import { describeWorktrees, worktreesOf } from "./worktrees-state";
import { goneWorkOf, REMOVED_EMPTY, treeReadinessOf } from "./merge-readiness";
import { LAST_KNOWN_REASON, lastKnownUsage, rememberUsage } from "./usage-last-known";
import { workerSkills } from "./worker-skills";
import { defaultAdapters } from "./worker-adapters";
import { WorkerRestorer, workersFromRecords } from "./worker-restore";
import { claudeSpawnModels, WorkerContextReader, withWorkerContext } from "./worker-context";
import { handoverSuccessor, retireReason, TEAM_EVENT_TYPE, teamEventOf } from "./reports";
import { LEGACY_REGISTRY_ENTRY_TYPE, readWorkerManifests, WORKER_MANIFEST_ENTRY_TYPE, type WorkerTranscriptAdapters } from "../pi-config/extensions/subagents/worker-transcript.ts";

// Read-only views over what the user's pi extensions leave on disk (sources and shapes:
// docs/insights-research.md "Data sources"). The one writer is the shared usage cache: through
// the extension's own lock protocol, refreshUsageInsight force-refreshes it and the server's
// poller (server/usage-poll.ts) refreshes it when due. Every
// source is untrusted JSON: anything malformed is skipped, and a missing source yields an
// empty payload.

type Rec = Record<string, any>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** A worker's `modes` (sessions schema WorkerEntry): short lower-case names, else nothing at all. */
const workerModesOf = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.length <= 8 && v.every((m) => typeof m === "string" && m.length <= 32 && /^[a-z][a-z0-9-]*$/.test(m)) ? [...v] : undefined;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// ---------------------------------------------------------------------------
// Usage: ~/.pi/agent/cache/usage-status.json (written by the usage-status extension)

const USAGE_FILE = join(agentRoot(), "cache", "usage-status.json");
/** This server's poller (server/usage-poll.ts) and TUI pis refresh the cache every few minutes;
    older than this means none of them is (the poller is failing or off, and no TUI is open). */
const USAGE_STALE_MS = 10 * 60_000;

/** One added Claude login's reading from the cache's `claudeAccounts`. */
interface ClaudeAccountReading {
  usage: UsageProvider;
  fetchedAt?: number;
  skipped?: "auth";
}
/** `ownFetchedAt`: when `claude` (Claude Code's own login) was read — the cache's `claudeFetchedAt`,
    else the file's `fetchedAt` (an older writer fetched it with the file). */
type ParsedUsage = { data: Omit<UsageInsight, "stale">; absent: UsageProvider["id"][]; ownFetchedAt: number; claudeAccounts?: Record<string, ClaudeAccountReading> };

let usageCache: ({ mtimeMs: number; size: number } & ParsedUsage) | null = null;

const USAGE_PROVIDERS = ["claude", "openai", "ollama", "zai", "deepseek"] as const satisfies readonly UsageProvider["id"][];
const USAGE_META_KEYS = new Set(["schemaVersion", "fetchedAt", "nextFetchAt", "errors", "claudeAccounts", "claudeFetchedAt", "claudeNextFetchAt"]);
const LOGIN_ID = /^l-[0-9a-f]{8}$/;

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

/** An OpenAI window: its own length (`seconds`, additive in the cache) gives its start. */
function openAiWindow(w: unknown): UsageWindow | null {
  const out = usageWindow(isRec(w) && typeof w.label === "string" ? w.label : "?", w);
  const seconds = isRec(w) ? num(w.seconds) : undefined;
  const end = out?.resetsAt ? Date.parse(out.resetsAt) : NaN;
  if (!out || seconds === undefined || seconds <= 0 || Number.isNaN(end)) return out;
  return { ...out, startsAt: new Date(end - seconds * 1000).toISOString() };
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

/**
 * What a provider's ok reading carries besides its windows, each only when valid: OpenAI's
 * `plan` and `limitReached`, Z.ai's `level`, Claude's `extraUsage` (`pct` optional, as the
 * extension renders "on" without one).
 */
function usageExtras(id: UsageProvider["id"], data: Rec): Pick<UsageProvider, "plan" | "limitReached" | "level" | "extraUsage"> {
  if (id === "openai") {
    const plan = str(data.plan);
    return { ...(plan ? { plan } : {}), ...(data.limitReached === true ? { limitReached: true } : {}) };
  }
  if (id === "zai") {
    const level = str(data.level);
    return level ? { level } : {};
  }
  if (id === "claude" && isRec(data.extraUsage) && typeof data.extraUsage.enabled === "boolean") {
    const pct = num(data.extraUsage.pct);
    return { extraUsage: pct === undefined ? { enabled: data.extraUsage.enabled } : { enabled: data.extraUsage.enabled, pct } };
  }
  return {};
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
          ? (Array.isArray(data.windows) ? data.windows : []).map(openAiWindow)
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
    return valid.length ? withError({ id, state: "ok", windows: valid, ...usageExtras(id, data) }) : unrecognized("state ok without a readable window");
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
/** `claudeAccounts` (usage-status fetch.ts ClaudeAccountUsage by login id), each entry read like the claude provider; anything unreadable is skipped. */
function parseClaudeAccounts(v: unknown): Record<string, ClaudeAccountReading> | undefined {
  if (!isRec(v)) return undefined;
  const out: Record<string, ClaudeAccountReading> = {};
  for (const [id, a] of Object.entries(v)) {
    if (!LOGIN_ID.test(id) || !isRec(a)) {
      warnOnce("shape:claudeAccounts", `usage-status.json: skipped unrecognized claudeAccounts entry`);
      continue;
    }
    const fetchedAt = num(a.fetchedAt);
    out[id] = {
      usage: a.data === undefined ? { id: "claude", state: "error", windows: [], error: str(a.error) ?? "not read yet" } : usageProvider("claude", a.data, a.error),
      ...(fetchedAt !== undefined ? { fetchedAt } : {}),
      ...(a.skipped === "auth" ? { skipped: "auth" as const } : {}),
    };
  }
  return out;
}

function parseUsage(text: string): ParsedUsage | null {
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
    ownFetchedAt: num(v.claudeFetchedAt) ?? v.fetchedAt,
    ...(v.claudeAccounts !== undefined ? { claudeAccounts: parseClaudeAccounts(v.claudeAccounts) } : {}),
  };
}

/**
 * The Usage page's Claude logins: every login on this host (its order), with its identity, its
 * standing and whether a new chat would run on it; `default`'s reading is the provider card's
 * (`claude`), an added login's is its `claudeAccounts` entry. A login the cache has no entry for
 * yet reads "not read yet". While the pool is on (`pool`), every login of the pool comes first, in
 * the pool's order, each with where it is; one held elsewhere (or kept free) reads the figures its
 * holder published, or "not read yet". The page folds them into one card per account.
 */
export function claudeLoginCards(
  rows: ClaudeLoginRow[],
  inUse: string,
  own: UsageProvider,
  ownFetchedAt: number | null,
  accounts: Record<string, ClaudeAccountReading> | undefined,
  auth: Record<string, UsageProvider["auth"]>,
  pool?: ClaudePoolInfo,
): UsageClaudeLogin[] {
  const here = rows.map((r): UsageClaudeLogin => {
    const reading = r.id === "default" ? { usage: own, ...(ownFetchedAt !== null ? { fetchedAt: ownFetchedAt } : {}) } : accounts?.[r.id];
    let usage: UsageProvider = reading?.usage ?? { id: "claude", state: "error", windows: [], error: "not read yet" };
    const a = r.id === "default" ? undefined : auth[r.id];
    if (a) usage = { ...usage, auth: a };
    const i = r.identity;
    return {
      id: r.id,
      ...(r.label ? { label: r.label } : {}),
      ...(i?.email ? { email: i.email } : {}),
      ...(i?.accountUuid ? { accountUuid: i.accountUuid } : {}),
      ...(i?.orgName ? { orgName: i.orgName } : {}),
      ...(i?.planLabel ? { planLabel: i.planLabel } : {}),
      ...(r.addedAt !== undefined ? { addedAt: r.addedAt } : {}),
      enabled: r.enabled,
      signedIn: r.signedIn,
      standing: r.standing,
      inUse: r.id === inUse,
      usage,
      ...(reading?.fetchedAt !== undefined ? { fetchedAt: reading.fetchedAt } : {}),
    };
  });
  if (!pool) return here;
  const pooled = pool.logins.map((l): UsageClaudeLogin => {
    const holder = { label: l.holder.label, self: l.holder.device === pool.self && !l.holder.free, free: l.holder.free, stuck: l.holder.stuck };
    const mine = here.find((c) => c.id === l.id);
    if (mine) {
      const { label: _, ...rest } = mine;
      return { ...rest, ...(l.label ? { label: l.label } : {}), holder };
    }
    return { ...poolReading(l), holder };
  });
  return [...pooled, ...here.filter((c) => !pool.logins.some((l) => l.id === c.id))];
}

/** A pool login this device does not use: its identity, the pool's standing and its holder's published figures. */
function poolReading(l: ClaudePoolLogin): Omit<UsageClaudeLogin, "holder"> {
  const u = l.usage;
  const at = (ms: number | undefined) => (ms !== undefined ? { resetsAt: new Date(ms).toISOString() } : {});
  const windows: UsageWindow[] = [
    ...(u?.fiveHour !== undefined ? [{ label: "5h", pct: u.fiveHour, ...at(u.fiveHourResetsAt) }] : []),
    ...(u?.sevenDay !== undefined ? [{ label: "7d", pct: u.sevenDay, ...at(u.sevenDayResetsAt) }] : []),
  ];
  const i = l.identity;
  return {
    id: l.id,
    ...(l.label ? { label: l.label } : {}),
    ...(i?.email ? { email: i.email } : {}),
    ...(i?.accountUuid ? { accountUuid: i.accountUuid } : {}),
    ...(i?.orgName ? { orgName: i.orgName } : {}),
    ...(i?.planLabel ? { planLabel: i.planLabel } : {}),
    addedAt: l.addedAt,
    enabled: l.enabled,
    // Its holder has its credentials; whether they still work is its standing.
    signedIn: true,
    standing: l.standing,
    inUse: false,
    usage: windows.length ? { id: "claude", state: "ok", windows } : { id: "claude", state: "error", windows: [], error: "not read yet" },
    ...(windows.length && u ? { fetchedAt: u.at } : {}),
  };
}

let claudeAccountsService: ClaudeAccountsService | null = null;

/** This host's Claude logins (and, with the pool on, the pool's), or undefined when the registry can't be listed at all. */
async function readClaudeLogins(own: UsageProvider, ownFetchedAt: number | null, accounts: Record<string, ClaudeAccountReading> | undefined): Promise<UsageClaudeLogin[] | undefined> {
  try {
    claudeAccountsService ??= new ClaudeAccountsService();
    const service = claudeAccountsService;
    const info = service.info();
    const rows = info.logins;
    const auth: Record<string, UsageProvider["auth"]> = {};
    for (const r of rows) if (r.id !== "default") auth[r.id] = await readClaudeLoginAuth(service.dirOf(r.id));
    return claudeLoginCards(rows, service.inUse(), own, ownFetchedAt, accounts, auth, info.pool);
  } catch (err) {
    warnOnce("claude-logins", `Claude logins unreadable for the Usage page: ${(err as Error).message}`);
    return undefined;
  }
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
    let parsed: ParsedUsage | null;
    try {
      parsed = parseUsage(await readFile(USAGE_FILE, "utf8"));
    } catch (err) {
      return unavailable((err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt");
    }
    if (!parsed) return unavailable("corrupt");
    // Once per new cache file, not per poll: the store skips the write when nothing changed.
    rememberUsage(parsed.data.providers);
    // A file without `claudeAccounts` (an older pi rewrote it) keeps the last readings of the
    // logins still held here, never one handed back (its pre-reset reading would outlive it).
    const claudeAccounts = parsed.claudeAccounts ?? carriedClaudeAccounts(usageCache?.claudeAccounts, claudeLoginIds());
    usageCache = { mtimeMs: st.mtimeMs, size: st.size, data: parsed.data, absent: parsed.absent, ownFetchedAt: parsed.ownFetchedAt, ...(claudeAccounts ? { claudeAccounts } : {}) };
  }
  const { data: d, absent, ownFetchedAt, claudeAccounts } = usageCache;
  // A key the cache doesn't carry: serve what we last read for it, said plainly. A key that IS
  // there always wins, error and "na" included — that is the extension's own answer.
  const read = absent.length === 0 ? d.providers : d.providers.map((p) => (absent.includes(p.id) ? lastKnown(p) : p));
  // Sign-in facts come from the credential files, per request (memoized there), never from the cache.
  const auth = await readAuthStatus();
  // Ollama's month is derived from the declared day now, never cached: a changed day or a month
  // rollover shows at once (§app.insights/usage-reset-day).
  const ollamaResetDay = readUsageWindows(agentRoot()).ollama?.resetDay ?? null;
  const providers = read.map((p) => withDeclaredReset(auth[p.id] ? { ...p, auth: auth[p.id] } : p, ollamaResetDay, Date.now()));
  const own = providers.find((p) => p.id === "claude");
  const claudeLogins = own ? await readClaudeLogins(own, ownFetchedAt, claudeAccounts) : undefined;
  // macOS only: Claude Code's own login in neither its file nor a readable keychain (§app.claude-logins/macos-keychain).
  const ownUnreadable = await ownClaudeLoginUnreadable();
  return { ...d, providers, ...(claudeLogins ? { claudeLogins } : {}), ollamaResetDay, ...(ownUnreadable ? { claudeOwnLoginUnreadable: true as const } : {}), stale: d.fetchedAt !== null && Date.now() - d.fetchedAt > USAGE_STALE_MS };
}

/**
 * `PUT /api/insights/usage/reset-day` `{provider: "ollama", day: 1..31 | null}`: writes the declared
 * day through the extension's writer, then serves usage with it. `error` for a body it refuses.
 */
export async function setUsageResetDay(body: unknown): Promise<UsageInsight | { error: string }> {
  if (!isRec(body) || body.provider !== "ollama") return { error: 'provider must be "ollama"' };
  const day = body.day;
  if (day !== null && !(typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31)) return { error: "day must be a whole day from 1 to 31, or null" };
  setOllamaResetDay(day, agentRoot());
  return getUsageInsight();
}

/**
 * Ollama's `month` window with the span the declared reset day gives it at `now` (`startsAt`,
 * `resetsAt`, `declared: true`); any other provider, or no day, as it is.
 */
export function withDeclaredReset(p: UsageProvider, resetDay: number | null, now: number): UsageProvider {
  if (p.id !== "ollama" || resetDay === null) return p;
  const span = monthlyWindow(resetDay, now);
  return { ...p, windows: p.windows.map((w) => (w.label === "month" ? { ...w, ...span, declared: true as const } : w)) };
}

/**
 * The logins' readings a cache without `claudeAccounts` carries over from the last one read: only
 * those of logins in `held` (this host's added logins now); undefined when none is left.
 */
export function carriedClaudeAccounts(prev: Record<string, ClaudeAccountReading> | undefined, held: readonly string[]): Record<string, ClaudeAccountReading> | undefined {
  const kept = Object.entries(prev ?? {}).filter(([id]) => held.includes(id));
  return kept.length ? Object.fromEntries(kept) : undefined;
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

/** True while a Refresh Usage is in flight: the server's poller skips its tick meanwhile. */
export function usageRefreshBusy(): boolean {
  return usageRefreshInFlight !== null;
}

/** The poller just rewrote the cache: drop the memo so the next read re-parses it. */
export function invalidateUsageMemo(): void {
  usageCache = null;
}

/** The stored reading for a provider the cache didn't mention, or the "no data" answer as-is. */
function lastKnown(p: UsageProvider): UsageProvider {
  const prev = lastKnownUsage(p.id);
  return prev ? { ...prev, error: LAST_KNOWN_REASON, lastKnown: true } : p;
}

// ---------------------------------------------------------------------------
// Session JSONL facts: teams (subagents-team-v1), last worker reports (subagent-complete),
// topic-outline snapshot, compactions. One parse per (mtime, size), active branch only.

const TEAM_ENTRY = "subagents-team-v1";
/** The durable per-worker records the protocol fold reads (readWorkerManifests). */
const WORKER_RECORD_TYPES: ReadonlySet<unknown> = new Set([WORKER_MANIFEST_ENTRY_TYPE, LEGACY_REGISTRY_ENTRY_TYPE]);
/** The explain extension's completion entry; server/transcript.ts turns it into a report row. */
const EXPLAIN_ENTRY = "explain-doc";
const TEAM_ID = /^team_\d+$/;

interface RosterTeam {
  id: string;
  name: string;
  objective: string;
  createdAt: number;
  members: Omit<TeamMember, "worker" | "lastReport" | "retired">[];
}
interface SessionFacts {
  teams: RosterTeam[];
  reports: Map<string, NonNullable<TeamMember["lastReport"]>>;
  outline: SessionOutline | null;
  /** Every accepted topic-outline snapshot, oldest first (see addOutlineSnapshot). */
  outlines: OutlineSnapshot[];
  compactions: CompactionInfo[];
  /** The branch's rewinds, oldest first: the markers Sova leaves when the chat goes back before a
      message. Hidden from the transcript on purpose, so this is the only way to see one. */
  rewinds: RewindInfo[];
  /** The session's own id, from the header line: the parentSessionId /explain entries carry. */
  sessionId: string | null;
  /** explain-doc entries on the active branch (the store is the other half; see explanations()). */
  explanations: ExplanationInfo[];
  /** Which skills the branch's prompt offered, and which were loaded: see skills.ts. */
  skills: SessionSkills;
  /** The durable worker records (registry/manifest entries) on EVERY branch, in file order, and
      the ones on the active branch: what worker-restore.ts rebuilds workers from when nothing
      publishes them live. Only these entries are kept, never the whole file. */
  workerRecords: { all: Rec[]; active: Rec[] };
  /** subagents-team-event-v1 entries on the active branch, oldest first. */
  teamEvents: TeamEvent[];
  /** The branch's tracked worktrees: its newest usable `worktrees` entry (worktrees extension). */
  worktrees?: ReturnType<typeof worktreesOf>;
  /** The settled state each worker's manifest records on the active branch say it reached: the
      only trace of a member whose report went to its coordinator instead of this session. */
  settled: Map<string, NonNullable<TeamMember["lastReport"]>>;
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
  // Both optional and additive: a value we don't know is ignored, never the member (the member
  // still shows, as it did before the field existed).
  const duty: TeamDuty | undefined = m.duty === "coordinator" || m.duty === "monitor" ? m.duty : undefined;
  const successorOf = typeof m.successorOf === "string" && WORKER_ID.test(m.successorOf) ? m.successorOf : undefined;
  return {
    workerId,
    role,
    orchestrator: m.orchestrator === true,
    backend,
    ...(model ? { model } : {}),
    ownedPaths: strings(m.ownedPaths),
    addedAt,
    ...(duty ? { duty } : {}),
    ...(successorOf ? { successorOf } : {}),
  };
}

const WORKER_ID = /^ag_\d+$/;

function addTeamEntry(teams: Map<string, RosterTeam>, data: unknown): void {
  if (!isRec(data) || data.version !== 1) return;
  if (data.op === "eject") {
    // The member released its seat; the first eject stands, like the extension's fold.
    const at = num(data.at);
    const member = teams.get(str(data.teamId) ?? "")?.members.find((m) => m.workerId === str(data.workerId));
    if (member && at !== undefined && member.ejectedAt === undefined) member.ejectedAt = at;
    return;
  }
  if (!Array.isArray(data.members)) return;
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

function addReport(reports: SessionFacts["reports"], e: { content: unknown; at?: unknown }): void {
  const text = contentText(e.content);
  const at = str(e.at) ?? "";
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
      // The end of the topic's claimed section. Optional twice over: older snapshots have no range.
      ...(isRec(t.range) && isRec(t.range.to) && num(t.range.to.timestamp) ? { sectionAt: num(t.range.to.timestamp)! } : {}),
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
function addOutlineSnapshot(list: OutlineSnapshot[], e: { id: unknown; at?: unknown; data: unknown }): void {
  const o = decodeOutline(e.data);
  const id = str(e.id);
  const timestamp = str(e.at);
  if (!o || !id || !timestamp || (!o.now && !o.overall)) return;
  const prev = list[list.length - 1];
  if (prev && prev.now === o.now && prev.overall === o.overall) return;
  list.push({ id, timestamp, now: o.now, overall: o.overall, generatedAt: o.generatedAt });
}

/** One explain-doc entry's data, as server/transcript.ts explainRow reads it. */
function decodeExplanation(data: unknown): ExplanationInfo | null {
  if (!isRec(data)) return null;
  // A running entry (appended at spawn, before the page exists) is not an explanation yet: the
  // strip and its count list openable pages only. hasPage() in explanations() would drop it too;
  // rejecting it here makes the intent explicit and keeps the count honest even if that store
  // check changes. The run's final entry (same id) carries no status and flows through as before.
  if (data.status === "running") return null;
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
  if (data.status === "interrupted") x.status = "interrupted";
  return x;
}

function decodeCompaction(e: Extract<HEntry, { kind: "compaction" }>): CompactionInfo {
  const details = isRec(e.details) ? e.details : {};
  return {
    id: str(e.id) ?? "",
    timestamp: str(e.at) ?? "",
    tokensBefore: num(e.tokensBefore) ?? null,
    summary: str(e.summary) ?? "",
    readFiles: strings(details.readFiles),
    modifiedFiles: strings(details.modifiedFiles),
  };
}

/** One rewind marker, as chat-manager wrote it: ids and a stamp, no text (the abandoned turns are
    not on this branch). An entry missing either half can't be placed on an axis, so it is dropped. */
function decodeRewind(e: { id: unknown; at?: unknown; data: unknown }): RewindInfo | null {
  const id = str(e.id);
  const timestamp = str(e.at);
  if (!id || !timestamp) return null;
  const data = isRec(e.data) ? e.data : {};
  return { id, timestamp, targetId: str(data.targetId) ?? "", fromLeafId: str(data.fromLeafId) ?? "" };
}

/** A manifest fold's end or last settle as a member's last report: what `subagent-complete` would
    have said, for a member whose completion was routed to its coordinator. "running" says nothing
    settled; "lost" (its host died mid-turn) reads as interrupted. */
function settledStates(records: Rec[]): SessionFacts["settled"] {
  const out: SessionFacts["settled"] = new Map();
  let fold;
  try {
    fold = readWorkerManifests(records);
  } catch {
    return out;
  }
  for (const m of fold.manifests.values()) {
    if (!m.status || m.status === "running") continue;
    const at = m.endedAt ?? m.settledAt ?? m.at;
    if (!Number.isFinite(at) || at <= 0) continue;
    out.set(m.workerId, {
      status: m.status === "lost" ? "interrupted" : m.status,
      ...(m.taskOutcome ? { outcome: m.taskOutcome } : {}),
      at: new Date(at).toISOString(),
    });
  }
  return out;
}

export function extractFacts(text: string): SessionFacts {
  const teams = new Map<string, RosterTeam>();
  const reports: SessionFacts["reports"] = new Map();
  let outlineData: unknown;
  const outlines: OutlineSnapshot[] = [];
  const compactions: CompactionInfo[] = [];
  const rewinds: RewindInfo[] = [];
  const explanations: ExplanationInfo[] = [];
  const teamEvents: TeamEvent[] = [];
  const { header, entries } = parsePi(text);
  const branch = branchOf(entries);
  const isWorkerRecord = (h: HEntry) => h.kind === "state" && WORKER_RECORD_TYPES.has(h.key);
  const branchIds = new Set(branch.map((h) => h.id));
  const records = entries.filter(isWorkerRecord);
  // State folds (worker records, team events, worktrees) still read the raw entries until state moves.
  const raw = (hs: readonly HEntry[]): Rec[] => hs.map(rawOf);
  for (const h of branch) {
    if (h.kind === "state" && h.key === TEAM_ENTRY) addTeamEntry(teams, h.data);
    else if (h.kind === "state" && h.key === TEAM_EVENT_TYPE) {
      const ev = teamEventOf({ id: h.id ?? undefined, data: h.data });
      if (ev) teamEvents.push(ev);
    }
    else if (h.kind === "state" && h.key === "topic-outline") {
      outlineData = h.data;
      addOutlineSnapshot(outlines, h);
    }
    else if (h.kind === "note" && !h.inMessage && h.noteType === "subagent-complete") addReport(reports, h);
    else if (h.kind === "compaction") compactions.push(decodeCompaction(h));
    else if (h.kind === "state" && h.key === EXPLAIN_ENTRY) {
      const x = decodeExplanation(h.data);
      if (x) explanations.push(x);
    }
  }
  // The rewind markers on the branch (the registry's REWIND, which chat-manager's rewind writes), oldest first.
  for (const r of stateView(branch).list(REWIND)) {
    const x = decodeRewind(r);
    if (x) rewinds.push(x);
  }
  const allRecords = raw(records);
  const activeRecords = raw(records.filter((h) => branchIds.has(h.id)));
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
    skills: collectSkills(skillLinesOf(branch)),
    workerRecords: { all: allRecords, active: activeRecords },
    teamEvents,
    settled: settledStates(activeRecords),
    worktrees: worktreesOf(raw(branch)),
  };
}

/** Each worker's resolved cwd, from its durable records (the live record deliberately carries none). */
function workerCwds(records: Rec[]): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const m of readWorkerManifests(records).manifests.values()) if (m.spec?.cwd) out.set(m.workerId, m.spec.cwd);
  } catch {
    // Unreadable records: no cwds, so no worker counts toward a worktree.
  }
  return out;
}

const EMPTY_FACTS: SessionFacts = { teams: [], reports: new Map(), outline: null, outlines: [], compactions: [], rewinds: [], explanations: [], sessionId: null, skills: { offered: [], used: [] }, workerRecords: { all: [], active: [] }, teamEvents: [], settled: new Map() };

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
const WORKER_STATUSES = new Set<WorkerStatus>(["starting", "running", "waiting", "stopping", "done", "error", "killed", "restored"]);
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
/** Settled statuses, same set working-subagent-count.ts treats as not working. A restored worker
    has no process at all, so it is idle too. */
const IDLE = new Set<WorkerStatus>(["waiting", "done", "error", "killed", "restored"]);

function workerStatus(v: unknown): WorkerStatus {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (WORKER_STATUSES.has(s as WorkerStatus)) return s as WorkerStatus;
  return WORKER_ALIASES[s] ?? "running"; // schema: unknown ⇒ running
}

/** `hosted`: the record is one of this server's own runtimes, the only place Sova can resume a
    restored worker. Anyone else's `resumable` (a TUI's) is dropped. */
function decodeWorker(w: unknown, hosted: boolean): WorkerInfo | null {
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
  const modes = workerModesOf(w.modes);
  if (modes) out.modes = modes;
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
  // The record's own usage fields are the TUI's; what a worker spent is the usage ledger's.
  // Absent turns stay unknown.
  if (typeof w.turns === "number" && Number.isSafeInteger(w.turns) && w.turns >= 0) out.turns = w.turns;
  const interrupted = num(w.interruptedAt);
  if (interrupted !== undefined) out.interruptedAt = interrupted;
  if (hosted && w.resumable === true) out.resumable = true;
  return out;
}

export function decodeWorkers(presence: Rec | undefined, hosted = false): WorkerInfo[] {
  if (!Array.isArray(presence?.workers)) return [];
  return presence.workers.map((w: unknown) => decodeWorker(w, hosted)).filter((w: WorkerInfo | null): w is WorkerInfo => w !== null);
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

function lastOf<T>(list: readonly T[], pick: (x: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (pick(list[i]!)) return list[i];
  return undefined;
}

/** The newer of two last reports; a tie keeps the first (the report that reached this session). */
function newerReport(a: TeamMember["lastReport"], b: TeamMember["lastReport"]): TeamMember["lastReport"] {
  if (!a || !b) return a ?? b;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

export function joinTeams(facts: Pick<SessionFacts, "teams" | "reports" | "teamEvents" | "settled">, parentPath: string, workers: WorkerInfo[] | null): TeamInfo[] {
  const byId = new Map((workers ?? []).map((w) => [w.id, w]));
  return facts.teams.map((t) => {
    const events = facts.teamEvents.filter((e) => e.teamId === t.id);
    const members: TeamMember[] = t.members.map((m) => {
      const worker = byId.get(m.workerId) ?? null;
      if (worker) worker.teamId = t.id;
      // A subagent-complete that reached this session, or — for a member that reported to its
      // coordinator — the settled state its own records carry, whichever is newer.
      const report = newerReport(facts.reports.get(m.workerId), facts.settled.get(m.workerId));
      // Older files have no successorOf: the handover event that named this member says it.
      const handover = m.successorOf ? undefined : lastOf(events, (e) => handoverSuccessor(e)?.workerId === m.workerId);
      const successorOf = m.successorOf ?? handover?.workerId;
      const retire = lastOf(events, (e) => e.kind === "retire" && e.workerId === m.workerId);
      const reason = retire ? retireReason(retire) : undefined;
      return {
        ...m,
        worker,
        ...(report ? { lastReport: report } : {}),
        ...(successorOf ? { successorOf } : {}),
        ...(retire ? { retired: { at: retire.at, ...(reason ? { reason } : {}) } } : {}),
      };
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
      ...(members.some((m) => m.duty === "coordinator") ? { coordinated: true as const } : {}),
      ...(events.length > 0 ? { events } : {}),
    };
  });
}

async function liveSession({ sessionFile, pid, rec }: RawLiveRecord): Promise<LiveAgentSession | null> {
  const session = isRec(rec.session) ? rec.session : null;
  if (!session) return null;
  const presence = isRec(rec.presence) ? rec.presence : undefined;
  const heartbeat = num(rec.heartbeat) ?? 0;
  const age = Date.now() - heartbeat;
  const workers = decodeWorkers(presence, pid === process.pid);
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
    embedded: pid === process.pid,
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
 * listed, with the note, and stays linkable. A running entry (spawned, no page yet) never
 * reaches here: decodeExplanation drops it.
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

/** The adapters restored workers are read with; tests swap them (setWorkerAdapters). */
let adapters: () => WorkerTranscriptAdapters = defaultAdapters;
const restorer = new WorkerRestorer(() => adapters());
/** Live workers' context fill, off their transcripts' tails (mtime-gated: polled every 3s). */
const contextReader = new WorkerContextReader();
export function setWorkerAdapters(next: WorkerTranscriptAdapters | null): void {
  adapters = next ? () => next : defaultAdapters;
}

/** The Agents tab's linked members (server/mesh/links.ts, registered by server/index.ts). */
type LinksOf = (sessionId: string, path: string) => Promise<LinkedAgentInfo[]>;
let linksOf: LinksOf | null = null;
export function setInsightLinks(fn: LinksOf | null): void {
  linksOf = fn;
}
async function linkRows(sessionId: string | null, path: string): Promise<Pick<SessionInsight, "links">> {
  if (!sessionId || !linksOf) return {};
  const links = await linksOf(sessionId, path).catch(() => []);
  return links.length ? { links } : {};
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
  // Nothing publishes this session's workers: rebuild them from its own durable records, all
  // restored or ended, none working (worker-restore.ts).
  const resolveWindow = await sharedWorkerWindowResolver();
  const restored = live || facts.workerRecords.all.length === 0 ? null : await restorer.restore(facts.workerRecords.all, facts.workerRecords.active, resolveWindow);
  const workers = live
    ? withWorkerContext(decodeWorkers(presence, live.pid === process.pid), contextReader, resolveWindow, claudeSpawnModels(facts.workerRecords.all))
    : restored && restored.workers.length > 0 ? restored.workers : null;
  // The record lists at most 40 of the workers it counts: the pane offers the rest on request.
  const counted = live ? workerCountsOf(live.rec)?.total : undefined;
  const workerTotal = workers && counted !== undefined && counted > workers.length ? counted : undefined;
  // What the session spent is the usage ledger's (/api/usage/session), never counted here.
  const teams = joinTeams(facts, path, workers);
  // A worker's own transcript is the only record of what it loaded (see server/worker-skills.ts).
  // mtime-cached, because this endpoint is polled every 3s while the pane is open.
  const skillsLoaded = workers && workers.length > 0 ? await workerSkills(workers) : undefined;
  return {
    outline: live ? overlayOutline(facts.outline, presence?.outline) : facts.outline,
    ...(facts.outlines.length > 0 ? { outlines: facts.outlines } : {}),
    compactions: facts.compactions,
    ...(facts.rewinds.length > 0 ? { rewinds: facts.rewinds } : {}),
    teams,
    workers: workers ?? [],
    ...(workerTotal !== undefined ? { workerTotal } : {}),
    ...(hasSkills(facts.skills) ? { skills: facts.skills } : {}),
    ...(skillsLoaded ? { workerSkills: skillsLoaded } : {}),
    explanations: await explanations(facts),
    ...(await worktreeRows(facts, workers, path)),
    ...(await linkRows(facts.sessionId, path)),
  };
}

/** The active branch's workers the live record doesn't list (SessionHiddenWorkers). Read only
    when the pane asks: the facts are the insight's own parse, cached per (mtime, size), and no
    worker transcript is opened. `path` must already be validated. Never throws. */
export async function getHiddenWorkers(path: string): Promise<SessionHiddenWorkers> {
  const facts = await sessionFacts(path);
  let live: RawLiveRecord | undefined;
  try {
    live = readLiveRecords({ includeOwn: true }).find((r) => r.sessionFile === path);
  } catch {
    live = undefined;
  }
  // Without a live record the insight already lists every worker on the branch.
  if (!live) return { workers: [], listed: 0, total: 0 };
  const listed = decodeWorkers(isRec(live.rec.presence) ? live.rec.presence : undefined);
  let workers: WorkerInfo[] = [];
  try {
    workers = workersFromRecords(facts.workerRecords.all, facts.workerRecords.active, new Set(listed.map((w) => w.id)), await sharedWorkerWindowResolver());
  } catch {
    workers = []; // unreadable records: nothing more to offer
  }
  return { workers, listed: listed.length, total: listed.length + workers.length };
}

async function worktreeRows(facts: SessionFacts, workers: WorkerInfo[] | null, path: string): Promise<Pick<SessionInsight, "worktrees">> {
  if (!facts.worktrees?.trees.length) return {};
  const cwds = workerCwds(facts.workerRecords.all);
  const rows = await describeWorktrees(facts.worktrees, facts.sessionId, (workers ?? []).map((w) => ({ status: w.status, cwd: cwds.get(w.id) })));
  // Each row's merge readiness, as the session list last read it (§chat.worktrees/readiness).
  if (!rows) return {};
  const trees = facts.worktrees.trees;
  return {
    worktrees: await Promise.all(
      rows.map(async (r) => {
        const row = withReadiness(r, treeReadinessOf(path, r.path));
        if (row.exists || row.status !== "active") return row;
        // Its folder is gone: the same answer readiness gives, from the row's readiness when it has one.
        const rd = row.readiness;
        if (rd && (rd.state === "merged" || rd.state === "removed")) return { ...row, gone: goneOfReadiness(rd) };
        const t = trees.find((x) => x.path === r.path);
        const g = t ? await goneWorkOf(t, trees.filter((x) => x !== t).map((x) => x.path)).catch(() => null) : null;
        return { ...row, gone: g ?? ("unknown" as const) };
      }),
    ),
  };
}

const goneOfReadiness = (rd: WorktreeReadiness): NonNullable<SessionWorktreeInfo["gone"]> =>
  rd.state === "merged" ? "merged" : rd.why === "not merged" ? "unmerged" : rd.why === REMOVED_EMPTY ? "empty" : "unknown";

const withReadiness = (row: SessionWorktreeInfo, readiness: WorktreeReadiness | undefined): SessionWorktreeInfo => (readiness ? { ...row, readiness } : row);

/** A session's team members with a standing duty (monitor, coordinator), by worker id: attention
    signals never judge them stuck (server/attention-signals.ts), since they poll on purpose. */
export async function teamDuties(path: string): Promise<Map<string, TeamDuty>> {
  const out = new Map<string, TeamDuty>();
  for (const t of (await sessionFacts(path)).teams) for (const m of t.members) if (m.duty) out.set(m.workerId, m.duty);
  return out;
}
