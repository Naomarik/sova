import { agentRoot } from "./state-root";
// The provider-limits extension's own file and gate (node builtins only): the shape, the strict
// parse, the atomic write, the defaults a missing file stands for, and the queue files. See CLAUDE.md.
import {
  acquireSlot,
  DEFAULT_PROVIDER_LIMITS,
  MAX_LIMIT,
  MIN_LIMIT,
  parseProviderLimits,
  queueSnapshot,
  readLowered,
  readProviderLimits,
  waitingBySession,
  whileHolding,
  writeProviderLimits,
  type Slot,
} from "../pi-config/extensions/provider-limits/gate.ts";
import type { ProviderLimitsInfo, ProviderWaiting } from "../shared/provider-limits";

/** One of `provider`'s request slots for a call a session makes outside its stream (a codemode script's model
    call, §chat.mode-menu/codemode): an interactive request of that session, waiting in the queue while the
    provider is full; null when the provider has no limit. */
export function claimSessionSlot(provider: string, opts: { sessionId?: string; signal?: AbortSignal }, agentDir = agentRoot()): Promise<Slot | null> {
  return acquireSlot(provider, { agentDir, kind: "interactive", ...opts });
}

/** Run `fn` as holding `provider`'s slot, so a gated request inside it never claims a second. */
export const holdingSlot = whileHolding;

// Settings → Models' "At once" field (§app.provider-limits/setting) and the web's waiting state
// (§app.provider-limits/waiting-shown). The file (~/.pi/agent/provider-limits.json) is read by every
// process's gate at each request, so a save applies to the next request anywhere on the device.

export function providerLimitsInfo(agentDir = agentRoot(), now = Date.now()): ProviderLimitsInfo {
  const stored = readProviderLimits(agentDir);
  const limits = stored.state === "ok" ? { ...stored.value.limits } : { ...DEFAULT_PROVIDER_LIMITS };
  const lowered: ProviderLimitsInfo["lowered"] = {};
  for (const [provider, limit] of Object.entries(limits)) {
    const l = readLowered(agentDir, provider, now);
    if (l && l.limit < limit) lowered[provider] = { limit: l.limit, until: l.until };
  }
  return {
    limits,
    defaults: { ...DEFAULT_PROVIDER_LIMITS },
    stored: stored.state !== "absent",
    ...(stored.state === "malformed" ? { error: stored.errors.join("; ") } : {}),
    lowered,
    min: MIN_LIMIT,
    max: MAX_LIMIT,
    file: stored.file,
  };
}

export type ProviderLimitsSaveOutcome = { status: 200; body: ProviderLimitsInfo } | { status: 400 | 409; body: { error: string } };

/** Replace the whole file (PUT `{limits}`). A stored file that can't be read is never overwritten (409). */
export function saveProviderLimits(body: unknown, agentDir = agentRoot()): ProviderLimitsSaveOutcome {
  const stored = readProviderLimits(agentDir);
  if (stored.state === "malformed")
    return { status: 409, body: { error: `${stored.file} can't be read (${stored.errors.join("; ")}), so it wasn't overwritten; fix or delete it first` } };
  const limits = body && typeof body === "object" && !Array.isArray(body) ? (body as { limits?: unknown }).limits : undefined;
  const parsed = parseProviderLimits({ version: 1, limits });
  if (!parsed.ok) return { status: 400, body: { error: parsed.errors.join("; ") } };
  try {
    writeProviderLimits(agentDir, parsed.value);
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
  return { status: 200, body: providerLimitsInfo(agentDir) };
}

let cache: { at: number; dir: string; value: ProviderWaiting } | null = null;
const CACHE_MS = 750;

/** Who waits now, by session id, from the queue files (read-only; cached briefly, since every open tab polls it). */
export function providerWaiting(agentDir = agentRoot(), now = Date.now()): ProviderWaiting {
  if (cache && cache.dir === agentDir && now - cache.at < CACHE_MS) return cache.value;
  const value: ProviderWaiting = { sessions: Object.fromEntries(waitingBySession(queueSnapshot(agentDir, now))) };
  cache = { at: now, dir: agentDir, value };
  return value;
}
