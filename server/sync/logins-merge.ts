/**
 * The login-sync conflict rule, per credential entry: pure, no I/O, no clock of its own (every
 * decision takes `now`). The unit of sync is one provider entry of one store (`pi:openai-codex`,
 * `claude:claudeAiOauth`), never a whole file, and ordering comes from the token itself, never
 * from a file's mtime (a failed refresh or a stale host's touch would otherwise win).
 *
 * The rule, applied to the local record and one peer's record for the same key:
 *   1. Tombstones merge by the later `at`. An entry whose `loginAt` is not after the tombstone is
 *      inadmissible: a refresh keeps its lineage's `loginAt`, so a host that refreshed while it
 *      missed a logout is still logged out; only a login newer than the logout resurrects.
 *   2. A dead marker (the consumer's failed-refresh clearing) or an expired oauth entry never
 *      wins over a live one and is never taken from a peer; a host holding one pulls instead.
 *   3. Among live admissible entries the newer login wins (`loginAt`); within one lineage (the
 *      same login, refreshed) the larger `expires` wins for oauth, the newer `issuedAt` for an
 *      api key; ties fall to `issuedAt`, then `origin`, then `fingerprint`. It is one total order
 *      over (loginAt, stamp, issuedAt, origin, fingerprint), so the merge is commutative and
 *      associative among live entries: every host converges on the same winner whatever order the
 *      exchanges happen in.
 *
 * Why the login comes before the expiry: were the larger expiry to win across lineages, an older
 * lineage refreshed later would overwrite a newer login everywhere, and a logout between the two
 * logins would then remove it, leaving every host logged out although a login newer than the
 * logout existed. With the newest login first, a tombstone that rules out the winner rules out
 * every other entry too, so no order of exchanges can lose a surviving login.
 */

export type StoreId = "pi" | "claude";
export const STORE_IDS: readonly StoreId[] = ["pi", "claude"];
export type EntryKind = "oauth" | "api_key";

/** `<store>:<provider>`, e.g. `pi:openai-codex`. The provider part may itself hold colons. */
export type EntryKey = string;

export interface EntryMeta {
  kind: EntryKind;
  /** oauth: the access token's expiry in ms (pi `expires`, Claude `expiresAt`). Absent for api_key. */
  expires?: number;
  /** When the origin first observed this fingerprint (its wall clock). */
  issuedAt: number;
  /** When the login that began this lineage happened. A refresh keeps it; 0 = predates sync. */
  loginAt: number;
  /** `sha256:<hex>` of the canonical entry. Never the entry itself. */
  fingerprint: string;
  /** Host id that produced this fingerprint: the login host, or the last refresher. */
  origin: string;
  /** The consumer's own failed-refresh marker (Claude clears to empty tokens, `expiresAt: 0`). */
  dead?: boolean;
  /** A short non-secret digest of the account the entry names, when it names one (Codex `accountId`). */
  account?: string;
}

export interface Tombstone {
  at: number;
  by: string;
}

/** What a host knows about one key: the entry it holds (if any) and the newest logout it has seen. */
export interface KeyRecord {
  meta?: EntryMeta;
  tombstone?: Tombstone;
}

export type Records = Record<EntryKey, KeyRecord>;

/**
 * Why a pushed entry was not taken: `older` lost the order, `tombstoned` predates a logout, `dead`
 * is a failed-refresh marker or expired, `local-only` is a key this host keeps as device config,
 * `clock-skew` means the two clocks disagree too much to compare stamps, `invalid` failed a check,
 * `disabled` means this host has login sync turned off.
 */
export type RejectReason = "older" | "tombstoned" | "dead" | "unknown-store" | "local-only" | "clock-skew" | "invalid" | "disabled";

/** Peers whose clocks differ by more than this are not merged with: every stamp is a wall time. */
export const MAX_CLOCK_SKEW_MS = 60_000;

export function entryKey(store: StoreId, provider: string): EntryKey {
  return `${store}:${provider}`;
}

export function parseEntryKey(key: string): { store: StoreId; provider: string } | null {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) return null;
  const store = key.slice(0, colon);
  if (!(STORE_IDS as readonly string[]).includes(store)) return null;
  return { store: store as StoreId, provider: key.slice(colon + 1) };
}

/** Usable as it stands: not a dead marker, and (oauth) its access token has not expired. */
export function isLive(meta: EntryMeta, now: number): boolean {
  if (meta.dead) return false;
  if (meta.kind === "api_key") return true;
  return typeof meta.expires === "number" && meta.expires > now;
}

/** An entry survives a tombstone only if its lineage began after the logout. */
export function admissible(meta: EntryMeta, tombstone: Tombstone | undefined): boolean {
  return !tombstone || meta.loginAt > tombstone.at;
}

const cmp = (a: number | string, b: number | string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The single ordering stamp: expiry for oauth, issue time for api keys. */
const stamp = (m: EntryMeta): number => (m.kind === "oauth" ? (m.expires ?? 0) : m.issuedAt);

/** Total order over entries of one key; > 0 when `a` wins. Equal only for identical metas' keys. */
export function compareEntries(a: EntryMeta, b: EntryMeta): number {
  return (
    cmp(a.loginAt, b.loginAt) ||
    cmp(stamp(a), stamp(b)) ||
    cmp(a.issuedAt, b.issuedAt) ||
    cmp(a.origin, b.origin) ||
    cmp(a.fingerprint, b.fingerprint)
  );
}

export function laterTombstone(a: Tombstone | undefined, b: Tombstone | undefined): Tombstone | undefined {
  if (!a) return b;
  if (!b) return a;
  return (cmp(a.at, b.at) || cmp(a.by, b.by)) >= 0 ? a : b;
}

export type Resolution =
  /** Local stays as it is (it won, or the peer offered nothing usable). */
  | { action: "keep"; record: KeyRecord; rejected?: RejectReason }
  /** The peer's entry wins: fetch/write its secret, then store `record`. */
  | { action: "adopt"; record: KeyRecord }
  /** A tombstone wins over the local entry: remove it from the store. */
  | { action: "delete"; record: KeyRecord };

/**
 * Merge a peer's record for one key into the local one. `remote.meta` is taken only when live;
 * `local.meta` stays even when dead or expired, unless a live peer entry beats it or a tombstone
 * rules it out, since it is still what the store holds (pi can refresh an expired entry).
 * `rejected` explains, for a push reply, why a peer entry that was offered did not win.
 */
export function resolve(local: KeyRecord, remote: KeyRecord, now: number): Resolution {
  const tombstone = laterTombstone(local.tombstone, remote.tombstone);
  const withTomb = (meta: EntryMeta | undefined): KeyRecord => (tombstone ? { meta, tombstone } : { meta });
  const lm = local.meta && admissible(local.meta, tombstone) ? local.meta : undefined;
  const rm = remote.meta;
  let rejected: RejectReason | undefined;
  let candidate: EntryMeta | undefined;
  if (rm) {
    if (!isLive(rm, now)) rejected = "dead";
    else if (!admissible(rm, tombstone)) rejected = "tombstoned";
    else candidate = rm;
  }
  const localLive = lm !== undefined && isLive(lm, now);
  if (candidate && (!localLive || compareEntries(candidate, lm!) > 0)) {
    return { action: "adopt", record: withTomb(candidate) };
  }
  if (candidate) rejected = "older";
  if (local.meta && !lm) return { action: "delete", record: withTomb(undefined) };
  const record = withTomb(lm);
  return rejected ? { action: "keep", record, rejected } : { action: "keep", record };
}

/** Only a live, admissible entry is ever offered to a peer. */
export function advertisable(record: KeyRecord, now: number): boolean {
  return !!record.meta && isLive(record.meta, now) && admissible(record.meta, record.tombstone);
}

export interface SyncPlan {
  /** Keys whose peer entry beats ours: fetch the secret and apply. */
  pull: EntryKey[];
  /** Keys where a peer tombstone removes our entry. */
  delete: EntryKey[];
  /** Keys where ours beats (or the peer lacks) and is advertisable: push to the peer. */
  push: EntryKey[];
  /** Keys where only the tombstone is newer on our side: send the logout. */
  tombstones: EntryKey[];
}

/**
 * Compare two manifests key by key (metadata only, no secrets). Local-side effects (`pull`,
 * `delete`) are re-decided under the store's lock with `resolve` when applied, since the store
 * may have moved meanwhile; this is only which keys to act on.
 */
export function plan(local: Records, remote: Records, now: number): SyncPlan {
  const out: SyncPlan = { pull: [], delete: [], push: [], tombstones: [] };
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (!parseEntryKey(key)) continue;
    const l = local[key] ?? {};
    const r = remote[key] ?? {};
    const mine = resolve(l, r, now);
    if (mine.action === "adopt") out.pull.push(key);
    else if (mine.action === "delete") out.delete.push(key);
    const theirs = resolve(r, l, now);
    if (theirs.action === "adopt") out.push.push(key);
    else if (l.tombstone && laterTombstone(l.tombstone, r.tombstone) === l.tombstone && !sameTomb(l.tombstone, r.tombstone)) {
      out.tombstones.push(key);
    }
  }
  return out;
}

const sameTomb = (a: Tombstone | undefined, b: Tombstone | undefined) => !!a && !!b && a.at === b.at && a.by === b.by;

export function clockSkewed(peerNow: number, localNow: number, limit = MAX_CLOCK_SKEW_MS): boolean {
  return !Number.isFinite(peerNow) || Math.abs(peerNow - localNow) > limit;
}

/** Structural check for a record received from a peer; anything else is dropped unread. */
export function isKeyRecord(v: unknown): v is KeyRecord {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as KeyRecord;
  if (r.tombstone !== undefined) {
    const t = r.tombstone as Partial<Tombstone>;
    if (!t || typeof t.at !== "number" || !Number.isFinite(t.at) || typeof t.by !== "string") return false;
  }
  return r.meta === undefined || isEntryMeta(r.meta);
}

export function isEntryMeta(v: unknown): v is EntryMeta {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Partial<EntryMeta>;
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  return (
    (m.kind === "oauth" || m.kind === "api_key") &&
    (m.kind === "api_key" ? m.expires === undefined || finite(m.expires) : finite(m.expires)) &&
    finite(m.issuedAt) &&
    finite(m.loginAt) &&
    typeof m.fingerprint === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(m.fingerprint) &&
    typeof m.origin === "string" &&
    m.origin.length > 0 &&
    (m.dead === undefined || typeof m.dead === "boolean") &&
    (m.account === undefined || typeof m.account === "string")
  );
}
