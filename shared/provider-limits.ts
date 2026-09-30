// Per-provider request limits (§app/provider-limits; server/provider-limits.ts). Their own file,
// outside protocol.ts on purpose: its hash is the mesh's compatibility fingerprint, and these are one
// host's local settings and queue, never sent between hosts.
//
// GET /api/settings/provider-limits       -> ProviderLimitsInfo (~/.pi/agent/provider-limits.json; missing →
//                                            the defaults, `stored: false`; malformed → the defaults and `error`)
// PUT /api/settings/provider-limits {limits} -> ProviderLimitsInfo (replaces the whole file. 400 bad shape;
//                                            409 while the stored file is malformed: it is never overwritten)
// GET /api/provider-limits/waiting        -> ProviderWaiting (who waits now, from the queue files)

/** Provider id → how many of its requests may run at once on this device (1..999). Absent = no limit. */
export type ProviderLimits = Record<string, number>;

export interface ProviderLimitsInfo {
  /** The limits in effect: the file's, or the defaults when it is missing or can't be read. */
  limits: ProviderLimits;
  defaults: ProviderLimits;
  /** A file exists (valid or not). */
  stored: boolean;
  /** Why the stored file can't be read; Save refuses to overwrite it. */
  error?: string;
  /** Providers whose limit a 429 has lowered for now (the Settings number is unchanged). */
  lowered: Record<string, { limit: number; until: number }>;
  min: number;
  max: number;
  file: string;
}

/** One wait: `Waiting for {provider} · {inUse} of {limit} in use`, plus `(lowered after a rate limit)`. */
export interface ProviderWait {
  provider: string;
  inUse: number;
  limit: number;
  lowered: boolean;
}

export interface ProviderWaiting {
  /** Session id (a TUI's, a hosted session's, a pi worker's own) → its wait. */
  sessions: Record<string, ProviderWait>;
}

/** The one waiting sentence (the TUI's status bar says the same, pi-config/extensions/provider-limits/gate.ts). */
export function waitingSentence(w: ProviderWait): string {
  return `Waiting for ${w.provider} · ${w.inUse} of ${w.limit} in use${w.lowered ? " (lowered after a rate limit)" : ""}`;
}
