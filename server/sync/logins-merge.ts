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
 *   2. A dead marker (the consumer's failed-refresh clearing) never wins and is never taken; a host
 *      holding one takes any live peer entry. An oauth entry whose ACCESS token expired is not
 *      dead (its refresh token still works: an idle laptop holds exactly this) but it is never
 *      taken from a peer either. Held locally, it gives way only to its own lineage refreshed
 *      elsewhere (`sameLineage`: rotation made its refresh token stale) or to a newer login;
 *      against a different, older login it stays, and once its consumer refreshes it on use it is
 *      live and spreads by rule 3.
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
 *
 * Pre-sync entries (loginAt 0: found already in a store on a host's first sync scan) carry no
 * login time, so between two of them nothing says which is current. Two live pre-sync entries
 * that are not provably the same login (same fingerprint, or the same OAuth account: a copied and
 * since-refreshed lineage) are a CONFLICT: neither is taken, each host keeps its own, and the user
 * picks one (`claim` re-stamps it as a login made now, which then wins everywhere, as any fresh
 * login does). Likewise a logout rules a pre-sync entry out only if it is the login that was
 * logged out, so it never deletes another host's different key; that key then stays on its own
 * host (no host takes a peer's entry older than a logout it knows of) until someone claims it.
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
  /** What was logged out, so a pre-sync entry that is a different login survives the logout. */
  of?: { fingerprint: string; account?: string; kind?: EntryKind };
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
 * `disabled` means this host has login sync turned off, `conflict` that both hosts hold a
 * different pre-sync login and the user has to pick one, `api-keys-only` that this host syncs API
 * keys only and the entry is (or would replace) an OAuth login.
 */
export type RejectReason =
  | "older"
  | "tombstoned"
  | "dead"
  | "unknown-store"
  | "local-only"
  | "clock-skew"
  | "invalid"
  | "disabled"
  | "conflict"
  | "api-keys-only";

/**
 * Which logins a host syncs. "api-keys": API keys only. The host never offers, takes, stores or
 * refreshes an OAuth (subscription) entry through sync, and ignores logouts of one; its own OAuth
 * logins stay on it, untouched by any peer.
 */
export type LoginKinds = "all" | "api-keys";

/** The mode pinned by the host's environment (a VPS unit sets SOVA_SYNC_LOGIN_KINDS=api-keys), or null. */
export function loginKindsPin(env: NodeJS.ProcessEnv = process.env): LoginKinds | null {
  const v = env.SOVA_SYNC_LOGIN_KINDS?.trim();
  return v === "api-keys" || v === "all" ? v : null;
}

/**
 * Whether a host in `kinds` mode syncs this record. The kind comes from the entry, else from what
 * its logout names; a logout that names no kind (nothing was known of the entry) is harmless and
 * counts as syncable. Claude Code's store holds only its subscription login.
 */
export function syncsRecord(kinds: LoginKinds, key: EntryKey, rec: KeyRecord | undefined): boolean {
  if (kinds === "all") return true;
  if (parseEntryKey(key)?.store !== "pi") return false;
  return rec?.meta?.kind !== "oauth" && rec?.tombstone?.of?.kind !== "oauth";
}

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
  if (!tombstone || meta.loginAt > tombstone.at) return true;
  // A pre-sync entry is ruled out only by the logout of that same login.
  return meta.loginAt === 0 && !!tombstone.of && !sameLogin(meta, tombstone.of);
}

/** Provably the same login: the same entry, or the same OAuth account (a lineage refreshed since). */
export function sameLogin(a: Pick<EntryMeta, "fingerprint" | "account">, b: { fingerprint: string; account?: string }): boolean {
  return a.fingerprint === b.fingerprint || (!!a.account && a.account === b.account);
}

/**
 * The same lineage: provably the same login, or the same login instant (a refresh keeps `loginAt`;
 * 0 says nothing, so pre-sync entries need `sameLogin`).
 */
export function sameLineage(a: EntryMeta, b: EntryMeta): boolean {
  return sameLogin(a, b) || (a.loginAt > 0 && a.loginAt === b.loginAt);
}

/** Two pre-sync entries that may be different logins: nothing says which is current. */
export function preSyncConflict(a: EntryMeta, b: EntryMeta): boolean {
  return a.loginAt === 0 && b.loginAt === 0 && !sameLogin(a, b);
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
    // Taking a peer's entry needs a login after the logout. A pre-sync entry that survived the
    // logout (a different login) stays where it is; claiming it (a login made now) spreads it.
    else if (tombstone && rm.loginAt <= tombstone.at) rejected = "tombstoned";
    else candidate = rm;
  }
  const localLive = lm !== undefined && isLive(lm, now);
  // Held but expired (not dead): still a login this host can refresh (rule 2).
  const localIdle = lm !== undefined && !lm.dead && !localLive;
  if (candidate && (localLive || localIdle) && preSyncConflict(candidate, lm!)) {
    return { action: "keep", record: withTomb(lm), rejected: "conflict" };
  }
  const wins = !candidate
    ? false
    : localLive
      ? compareEntries(candidate, lm!) > 0
      : localIdle
        ? sameLineage(candidate, lm!) || candidate.loginAt > lm!.loginAt
        : true;
  if (candidate && wins) return { action: "adopt", record: withTomb(candidate) };
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
    if (t.of !== undefined) {
      const o = t.of as { fingerprint?: unknown; account?: unknown; kind?: unknown } | null;
      if (!o || typeof o.fingerprint !== "string" || (o.account !== undefined && typeof o.account !== "string")) return false;
      if (o.kind !== undefined && o.kind !== "oauth" && o.kind !== "api_key") return false;
    }
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
