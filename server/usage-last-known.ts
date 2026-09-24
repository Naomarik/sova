import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import type { UsageProvider } from "../shared/protocol";

/**
 * Last known good usage reading per provider, so an older pi session that rewrites
 * ~/.pi/agent/cache/usage-status.json with a pre-deepseek schema (its extension is still the old
 * one in memory) doesn't turn a provider we read minutes ago into "no data". Only the absence of
 * a provider KEY is treated as that older writer's signature; see server/insights.ts.
 *
 * Same directory as web-sessions.json, and derived the same way, so a throwaway
 * PI_CODING_AGENT_DIR keeps tests off ~/.pi.
 */
const FILE = join(stateRoot(), "usage-last-known.json");

/** A stored reading older than this is not worth showing; the provider reports no data instead. */
export const LAST_KNOWN_MAX_AGE_MS = 24 * 60 * 60_000;

/** `UsageProvider.error` on a reused reading: the UI already renders it as "previous reading". */
export const LAST_KNOWN_REASON = "an older pi session is rewriting the cache (run /reload in it)";

type Stored = Partial<Record<UsageProvider["id"], UsageProvider>>;
interface Store {
  version: 1;
  savedAt: number;
  providers: Stored;
}

/** Exhaustive by construction: a new UsageProvider["id"] fails to typecheck until it's listed. */
const IDS: Record<UsageProvider["id"], true> = { claude: true, openai: true, ollama: true, zai: true, deepseek: true };
const isId = (k: string): k is UsageProvider["id"] => Object.hasOwn(IDS, k);

const isRec = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Worth remembering: an ok reading that actually carries numbers. Never an error or an empty one. */
export function hasReading(p: UsageProvider): boolean {
  return p.state === "ok" && (p.windows.length > 0 || !!p.balance);
}

/**
 * What we keep: the reading itself (windows or balance, and the plan, level, limit and extra
 * usage that came with it), without whatever fetch error rode along with it.
 */
function keep(id: UsageProvider["id"], p: UsageProvider): UsageProvider {
  return {
    id,
    state: "ok",
    windows: p.windows,
    ...(p.balance ? { balance: p.balance } : {}),
    ...(typeof p.plan === "string" ? { plan: p.plan } : {}),
    ...(p.limitReached === true ? { limitReached: true } : {}),
    ...(typeof p.level === "string" ? { level: p.level } : {}),
    ...(isRec(p.extraUsage) && typeof p.extraUsage.enabled === "boolean"
      ? { extraUsage: typeof p.extraUsage.pct === "number" ? { enabled: p.extraUsage.enabled, pct: p.extraUsage.pct } : { enabled: p.extraUsage.enabled } }
      : {}),
  };
}

const empty = (): Store => ({ version: 1, savedAt: 0, providers: {} });

let store: Store | null = null;

/** Missing, unreadable or unrecognized file: start empty, never throw. */
function load(): Store {
  if (store) return store;
  try {
    const v: unknown = JSON.parse(readFileSync(FILE, "utf8"));
    if (!isRec(v) || v.version !== 1 || typeof v.savedAt !== "number" || !isRec(v.providers)) return (store = empty());
    const providers: Stored = {};
    for (const [key, p] of Object.entries(v.providers))
      if (isId(key) && isRec(p) && p.state === "ok" && Array.isArray(p.windows) && (p.windows.length > 0 || isRec(p.balance)))
        providers[key] = keep(key, p as UsageProvider);
    store = { version: 1, savedAt: v.savedAt, providers };
  } catch {
    store = empty();
  }
  return store;
}

/**
 * Remember every provider in `providers` that carries a reading, dropping nothing already stored.
 * Writes (atomically, tmp + rename) only when a stored reading actually changed, so the usage poll
 * doesn't touch the disk on every call.
 */
export function rememberUsage(providers: UsageProvider[]): void {
  const next = load();
  let changed = false;
  for (const p of providers) {
    if (!hasReading(p)) continue;
    const reading = keep(p.id, p);
    if (JSON.stringify(next.providers[p.id]) === JSON.stringify(reading)) continue;
    next.providers[p.id] = reading;
    changed = true;
  }
  if (!changed) return;
  next.savedAt = Date.now();
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, FILE);
  } catch {
    // A store we can't persist is still useful in memory for this process's lifetime.
  }
  store = next;
}

/** The stored reading for a provider, if there is one and it's younger than the cap. */
export function lastKnownUsage(id: UsageProvider["id"], now = Date.now()): UsageProvider | null {
  const s = load();
  if (now - s.savedAt > LAST_KNOWN_MAX_AGE_MS) return null;
  const p = s.providers[id];
  return p ? { ...p, windows: [...p.windows] } : null;
}

/** Tests only: forget the in-memory copy so the next read comes from disk. */
export function resetLastKnownCache(): void {
  store = null;
}
