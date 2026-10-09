import { groupByAccount, type ClaudeLoginIdentity } from "../../pi-config/extensions/claude-code/accounts.ts";

/**
 * The pool document (§app.claude-logins/pool): what every device knows about the pool of Claude
 * logins, with no secret in it. Pure: no I/O, no clock of its own.
 *
 * Merge rule, per field, so that edits made on two devices to different fields (or logins) both
 * survive and every exchange order converges (commutative, associative, idempotent):
 * - every `Reg` field: the later `at` wins; ties fall to `by`, then to the value's JSON.
 * - `holder`: the larger `seq` wins (ties: `at`, then `device`, then held over free). Only the
 *   device that durably has a login's credentials for the new holder ever advances `seq`, so the
 *   winner is always a device that has them.
 * - logins: the union; a login's `addedAt`/`identity` come from whichever record has the older
 *   `addedAt` (the adder's), identity filled in from the other when absent.
 * A peer's document passes `plausible` first, so no stamp far ahead of this clock, and no holder
 * counter far ahead of ours, ever wins (one forged document could otherwise outrank every real edit).
 */

export interface Reg<T> {
  value: T;
  at: number;
  by: string;
}
export interface PoolHolder {
  /** The device that has the login's credentials. */
  device: string;
  /** true: kept by that device (the keeper) for lending, never run; false: that device uses it. */
  free: boolean;
  seq: number;
  /** When this holder began (the writer's clock). */
  at: number;
}
export interface PoolStanding {
  kind: "limit" | "auth";
  /** limit: out until then (ms epoch). */
  until?: number;
  window?: string;
}
export interface PoolUsage {
  /** Percent used of the 5-hour window, and when it resets. */
  fiveHour?: number;
  fiveHourResetsAt?: number;
  /** Percent used of the weekly window, and when it resets. */
  sevenDay?: number;
  sevenDayResetsAt?: number;
}
export interface PoolLogin {
  addedAt: number;
  identity: ClaudeLoginIdentity | null;
  label: Reg<string | null>;
  enabled: Reg<boolean>;
  pin: Reg<string | null>;
  standing: Reg<PoolStanding | null>;
  /** "Return" pressed: the holder seq it was pressed at; the holder at that seq returns it after its turn. */
  returnAsk: Reg<number | null>;
  usage: Reg<PoolUsage | null>;
  removed: Reg<boolean>;
  holder: PoolHolder;
}
export interface PoolDoc {
  version: 1;
  keeper: Reg<string | null>;
  /** The one list's order: the order the keeper lends in (ids not listed follow by age). */
  order: Reg<string[]>;
  logins: Record<string, PoolLogin>;
}

const LOGIN_ID_RE = /^l-[0-9a-f]{8}$/;
const DEVICE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const reg = <T>(value: T, at: number, by: string): Reg<T> => ({ value, at, by });
export const emptyDoc = (): PoolDoc => ({ version: 1, keeper: reg(null, 0, ""), order: reg([], 0, ""), logins: {} });

const cmp = (x: number | string, y: number | string) => (x < y ? -1 : x > y ? 1 : 0);
/** > 0 when `a` wins. */
export function compareReg<T>(a: Reg<T>, b: Reg<T>): number {
  return cmp(a.at, b.at) || cmp(a.by, b.by) || cmp(JSON.stringify(a.value) ?? "", JSON.stringify(b.value) ?? "");
}
export const mergeReg = <T>(a: Reg<T>, b: Reg<T>): Reg<T> => (compareReg(a, b) >= 0 ? a : b);
/** > 0 when `a` wins. */
export function compareHolder(a: PoolHolder, b: PoolHolder): number {
  return cmp(a.seq, b.seq) || cmp(a.at, b.at) || cmp(a.device, b.device) || cmp(a.free ? 0 : 1, b.free ? 0 : 1);
}
export const mergeHolder = (a: PoolHolder, b: PoolHolder): PoolHolder => (compareHolder(a, b) >= 0 ? a : b);

export function mergeLogin(a: PoolLogin, b: PoolLogin): PoolLogin {
  const first = a.addedAt <= b.addedAt ? a : b;
  const other = first === a ? b : a;
  return {
    addedAt: first.addedAt,
    identity: first.identity ?? other.identity,
    label: mergeReg(a.label, b.label),
    enabled: mergeReg(a.enabled, b.enabled),
    pin: mergeReg(a.pin, b.pin),
    standing: mergeReg(a.standing, b.standing),
    returnAsk: mergeReg(a.returnAsk, b.returnAsk),
    usage: mergeReg(a.usage, b.usage),
    removed: mergeReg(a.removed, b.removed),
    holder: mergeHolder(a.holder, b.holder),
  };
}

export function mergeDocs(a: PoolDoc, b: PoolDoc): PoolDoc {
  const logins: Record<string, PoolLogin> = { ...a.logins };
  for (const [id, login] of Object.entries(b.logins)) logins[id] = logins[id] ? mergeLogin(logins[id]!, login) : login;
  return { version: 1, keeper: mergeReg(a.keeper, b.keeper), order: mergeReg(a.order, b.order), logins };
}

// ---- a peer's implausible stamps -----------------------------------------------------------------

/** How far ahead of this device's clock a peer's stamp may be. */
export const MAX_POOL_SKEW_MS = 60 * 60_000;
/** How far above ours a peer's holder counter may be for a login we know (handovers advance it by one). */
export const MAX_SEQ_STEP = 10_000;
/** The largest holder counter taken for a login new to this device. */
const MAX_NEW_SEQ = 2 ** 32;

const REG_FIELDS = ["label", "enabled", "pin", "standing", "returnAsk", "usage", "removed"] as const;
/** A new login's field before anyone set it (what `newPoolLogin` leaves unset). */
const UNSET: { [K in (typeof REG_FIELDS)[number]]: PoolLogin[K]["value"] } = { label: null, enabled: true, pin: null, standing: null, returnAsk: null, usage: null, removed: false };

/**
 * A peer's document with what no real edit could have written replaced, field by field, before it
 * is merged: any `Reg` or holder stamped more than `MAX_POOL_SKEW_MS` ahead of `now`, and a holder
 * counter more than `MAX_SEQ_STEP` above ours (above 2^32 for a login new here). Such a field reads
 * as ours (unset, for a new login; a new login whose holder is ignored is not taken yet), so the
 * merge with ours keeps ours. Once `now` passes a stamp, the same edit is taken: a peer merely
 * ahead of time loses nothing. `ignored` names each field (`keeper`, `<login id>.<field>`).
 */
export function plausible(theirs: PoolDoc, ours: PoolDoc, now: number): { doc: PoolDoc; ignored: string[] } {
  const ignored: string[] = [];
  const limit = now + MAX_POOL_SKEW_MS;
  const keep = <T>(name: string, their: Reg<T>, our: Reg<T>): Reg<T> => {
    if (their.at <= limit) return their;
    ignored.push(name);
    return our;
  };
  const logins: Record<string, PoolLogin> = {};
  for (const [id, login] of Object.entries(theirs.logins)) {
    const our = ours.logins[id];
    const badHolder = login.holder.at > limit || login.holder.seq > (our ? our.holder.seq + MAX_SEQ_STEP : MAX_NEW_SEQ);
    if (badHolder) ignored.push(`${id}.holder`);
    if (badHolder && !our) continue;
    const next: PoolLogin = { ...login, holder: badHolder ? our!.holder : login.holder };
    for (const f of REG_FIELDS) {
      (next as unknown as Record<string, Reg<unknown>>)[f] = keep(`${id}.${f}`, login[f] as Reg<unknown>, (our ? our[f] : reg(UNSET[f], 0, "")) as Reg<unknown>);
    }
    logins[id] = next;
  }
  return { doc: { version: 1, keeper: keep("keeper", theirs.keeper, ours.keeper), order: keep("order", theirs.order, ours.order), logins }, ignored };
}

/** Same content (the merge's fixed point): no write, no push. */
export const sameDoc = (a: PoolDoc, b: PoolDoc): boolean => canonical(a) === canonical(b);
export function canonical(doc: PoolDoc): string {
  const logins = Object.keys(doc.logins).sort().map((id) => [id, doc.logins[id]]);
  return JSON.stringify([doc.keeper, doc.order, logins]);
}

// ---- parsing (a peer's document, or the file) --------------------------------------------------

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const shortStr = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function parseReg<T>(v: unknown, value: (x: unknown) => x is T): Reg<T> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!isTime(r.at) || typeof r.by !== "string" || r.by.length > 64 || !value(r.value)) return null;
  return { value: r.value, at: r.at, by: r.by };
}
const nullableDevice = (x: unknown): x is string | null => x === null || (typeof x === "string" && DEVICE_RE.test(x));
const nullableLabel = (x: unknown): x is string | null => x === null || shortStr(x, 80);
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const nullableTime = (x: unknown): x is number | null => x === null || isTime(x);
function isStanding(x: unknown): x is PoolStanding | null {
  if (x === null) return true;
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const s = x as Record<string, unknown>;
  return (s.kind === "limit" || s.kind === "auth") && (s.until === undefined || isTime(s.until)) && (s.window === undefined || shortStr(s.window, 64));
}
function isUsage(x: unknown): x is PoolUsage | null {
  if (x === null) return true;
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const u = x as Record<string, unknown>;
  return ["fiveHour", "sevenDay", "fiveHourResetsAt", "sevenDayResetsAt"].every((k) => u[k] === undefined || (typeof u[k] === "number" && Number.isFinite(u[k])));
}
const isOrder = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 256 && x.every((id) => typeof id === "string" && LOGIN_ID_RE.test(id));

function parseIdentity(v: unknown): ClaudeLoginIdentity | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: ClaudeLoginIdentity = {};
  for (const key of ["accountUuid", "email", "orgUuid", "orgName", "plan", "rateLimitTier"] as const) {
    const value = (v as Record<string, unknown>)[key];
    if (shortStr(value)) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function parseHolder(v: unknown): PoolHolder | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const h = v as Record<string, unknown>;
  if (typeof h.device !== "string" || !DEVICE_RE.test(h.device) || typeof h.free !== "boolean" || !Number.isSafeInteger(h.seq) || (h.seq as number) < 0 || !isTime(h.at)) return null;
  return { device: h.device, free: h.free, seq: h.seq as number, at: h.at };
}

export function parseLogin(v: unknown): PoolLogin | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const l = v as Record<string, unknown>;
  const holder = parseHolder(l.holder);
  const label = parseReg(l.label, nullableLabel);
  const enabled = parseReg(l.enabled, isBool);
  const pin = parseReg(l.pin, nullableDevice);
  const standing = parseReg(l.standing, isStanding);
  const returnAsk = parseReg(l.returnAsk, nullableTime);
  const usage = parseReg(l.usage, isUsage);
  const removed = parseReg(l.removed, isBool);
  if (!holder || !isTime(l.addedAt) || !label || !enabled || !pin || !standing || !returnAsk || !usage || !removed) return null;
  return { addedAt: l.addedAt, identity: parseIdentity(l.identity), label, enabled, pin, standing, returnAsk, usage, removed, holder };
}

/** A document as a peer (or the file) has it: null when its shape is wrong. Bad logins are dropped. */
export function parseDoc(v: unknown): PoolDoc | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if (d.version !== 1) return null;
  const keeper = parseReg(d.keeper, nullableDevice);
  const order = parseReg(d.order, isOrder);
  if (!keeper || !order || !d.logins || typeof d.logins !== "object" || Array.isArray(d.logins)) return null;
  const logins: Record<string, PoolLogin> = {};
  for (const [id, raw] of Object.entries(d.logins as Record<string, unknown>)) {
    if (!LOGIN_ID_RE.test(id)) continue;
    const login = parseLogin(raw);
    if (login) logins[id] = login;
  }
  return { version: 1, keeper, order, logins };
}

/** A new login's record: held by `device` (it signed in there). */
export function newPoolLogin(opts: { addedAt: number; identity: ClaudeLoginIdentity | null; label?: string; enabled: boolean; device: string; free?: boolean; seq?: number; now: number }): PoolLogin {
  const by = opts.device;
  const at = opts.now;
  return {
    addedAt: opts.addedAt,
    identity: opts.identity,
    label: reg(opts.label ?? null, at, by),
    enabled: reg(opts.enabled, at, by),
    pin: reg(null, 0, ""),
    standing: reg(null, 0, ""),
    returnAsk: reg(null, 0, ""),
    usage: reg(null, 0, ""),
    removed: reg(false, 0, ""),
    holder: { device: opts.device, free: opts.free ?? false, seq: opts.seq ?? 1, at },
  };
}

/** The pool's order: `order` first (known, not removed), then the rest by age; each account's logins together. */
export function poolOrder(doc: PoolDoc): string[] {
  const live = Object.entries(doc.logins).filter(([, l]) => !l.removed.value);
  const ids = live.sort((a, b) => a[1].addedAt - b[1].addedAt || cmp(a[0], b[0])).map(([id]) => id);
  const listed = doc.order.value.filter((id) => ids.includes(id));
  return groupByAccount([...listed, ...ids.filter((id) => !listed.includes(id))], (id) => doc.logins[id]?.identity?.accountUuid);
}

/** A login's standing now: a limit shared by its whole account (any login of it limited until later). */
export function standingNow(doc: PoolDoc, id: string, now: number): PoolStanding | null {
  const login = doc.logins[id];
  if (!login) return null;
  const own = login.standing.value;
  if (own?.kind === "auth") return own;
  if (own?.kind === "limit" && (own.until ?? 0) > now) return own;
  const account = login.identity?.accountUuid;
  if (!account) return null;
  for (const other of Object.values(doc.logins)) {
    const s = other.standing.value;
    if (other !== login && other.identity?.accountUuid === account && s?.kind === "limit" && (s.until ?? 0) > now) return s;
  }
  return null;
}
