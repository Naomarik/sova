import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LINK_WARNINGS,
  REGISTRY_LIMITS,
  SHARE_PORT_DEFAULT,
  SNAPSHOT_MAX_BYTES,
  type LinkWarningCode,
  type RegistryLink,
  type RegistrySnapshot,
} from "../../shared/public-links";
import { meshApi } from "../mesh";
import { stateRoot } from "../state-root";
import { currentTarget, forgetKinds, type GatewayTarget, pushSnapshot, refreshGateway, routeSetting, routesKind, stillCurrent, viaGatewayPeer } from "./gateway-client";
import { onShareLinksChanged, type ShareLinksChange } from "./links-events";
import { validateSnapshot } from "./registry-validation";
import { SHARE_DIST } from "./routes";

/**
 * A routed host's registry push (§mesh.public/registry, push side): the whole live link set, as
 * hashes, sent to the `via` gateway on every link change, when this host starts routed, when the
 * gateway comes up, and every RETRY_MS while a snapshot is still owed. `seq` grows by one per
 * snapshot built and is persisted with the outbox (<stateRoot>/share-gateway-outbox.json, 0600),
 * so it keeps growing across restarts. The outbox holds no snapshot, only that one is owed: a
 * retry always sends the live set as it is then, under a new seq.
 *
 * A change's answer (awaitShareLinks) comes from the ack for the exact snapshot that carried it,
 * from the gateway still selected, at the same endpoint. The store writes a mint's link and emits at
 * once, but listeners run later (a microtask), after other mints, revokes or rotations may have
 * landed; so a listener only joins a batch, and the batch is read after every change already
 * emitted has joined it (setImmediate). Its candidates, per kind, are the live hashes this push
 * has never seen before; every hash live while nothing was published (not routed) or when the
 * route changed counts as seen, so a mint whose link vanished can never borrow another's. Each mint wrote exactly one new hash, so fewer new hashes than mints
 * means a minted link vanished before it could be sent (revoked, rotated): every mint of that kind
 * in the batch then answers with a warning. Otherwise a mint is confirmed only when every candidate
 * of its kind was in the snapshot sent and none is among the ack's collisions. Anything else (a
 * candidate left out or revoked before the send, a collision, no answer, a reply that doesn't
 * parse, a refusal, the gateway or its endpoint changed or gone) answers with a warning, never as
 * confirmed, and the outbox keeps sending. An answer for a target no longer selected settles
 * nothing: the new target gets its own snapshot and its own ack.
 */

export const RETRY_MS = 60_000;
/** How often a routed host asks its gateway again (hello and info), so shareState's reachable
    and accepting don't go stale between pushes. */
export const REFRESH_MS = 60_000;

interface Outbox {
  v: 1;
  /** The last seq built (0: none yet). */
  seq: number;
  /** A snapshot is owed to the gateway. */
  dirty: boolean;
}

export const outboxFile = (): string => join(stateRoot(), "share-gateway-outbox.json");

function readOutbox(): Outbox {
  const file = outboxFile();
  if (!existsSync(file)) return { v: 1, seq: 0, dirty: false };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Outbox;
    if (raw?.v === 1 && Number.isSafeInteger(raw.seq) && raw.seq >= 0 && typeof raw.dirty === "boolean") return { v: 1, seq: raw.seq, dirty: raw.dirty };
  } catch {
    // unreadable: kept aside below
  }
  // Kept for a look, and started again from 0, owed (a gateway ahead of us is caught up with below).
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, aside);
  } catch {
    // it stays; the next write replaces it
  }
  console.warn(`[share] the registry outbox was unreadable (kept as ${aside}); starting its seq again`);
  return { v: 1, seq: 0, dirty: true };
}

function writeOutbox(o: Outbox): void {
  const file = outboxFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(o)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

interface StoredLink {
  hash?: unknown;
  expiresAt?: unknown;
  revokedAt?: unknown;
}

function storeLinks(name: string): StoredLink[] {
  try {
    const raw = JSON.parse(readFileSync(join(stateRoot(), name), "utf8"));
    return Array.isArray(raw?.links) ? raw.links : [];
  } catch {
    return [];
  }
}

/** This host's live links (not revoked, not expired), from the three link stores, newest expiry
    first. Session links (kind `s`) are here whatever the gateway routes: snapshotOf leaves them
    out for a gateway that doesn't list `s`. */
function liveLinks(now: number): RegistryLink[] {
  const latest = now + REGISTRY_LIMITS.maxExpiryAheadMs;
  const seen = new Set<string>();
  const out: RegistryLink[] = [];
  const add = (rows: StoredLink[], kind: "h" | "i" | "s" | "p") => {
    for (const l of rows) {
      if (!l || typeof l.hash !== "string" || !REGISTRY_LIMITS.hash.test(l.hash) || l.revokedAt || seen.has(l.hash)) continue;
      const exp = typeof l.expiresAt === "string" ? Date.parse(l.expiresAt) : NaN;
      if (!Number.isFinite(exp) || exp <= now || exp > latest) continue;
      seen.add(l.hash);
      out.push({ h: l.hash, exp, kind });
    }
  };
  add(storeLinks("baton-links.json"), "h");
  add(storeLinks("person-links.json"), "i");
  add(storeLinks("session-shares.json"), "s");
  add(storeLinks("preview-links.json"), "p");
  return out.sort((a, b) => b.exp - a.exp);
}

function shareAssets(): string[] {
  try {
    return readdirSync(join(SHARE_DIST, "assets"))
      .filter((n) => REGISTRY_LIMITS.asset.test(n) && !n.includes(".."))
      .sort()
      .slice(0, REGISTRY_LIMITS.maxAssets);
  } catch {
    return []; // no share build: the gateway serves its own
  }
}

let lastOmitted = 0;

/** The snapshot of `live` under `seq`: past maxLinks or SNAPSHOT_MAX_BYTES, the links expiring
    soonest are left out (logged whenever the number left out changes; a mint whose own link is
    left out is answered with a warning). */
function snapshotOf(live: RegistryLink[], seq: number, kinds: ReadonlySet<RegistryLink["kind"]>): RegistrySnapshot {
  const port = routeSetting()?.ingressPort ?? SHARE_PORT_DEFAULT;
  // An `s` or `p` row goes only to a target that itself stated that kind: an older gateway rejects
  // the whole snapshot (an unknown kind is bad-snapshot), blocking that update: none of its new h
  // and i links would land (the rows it already holds stay).
  const routes = live.filter((l) => kinds.has(l.kind));
  const snap: RegistrySnapshot = { v: 1, seq, links: routes.slice(0, REGISTRY_LIMITS.maxLinks), assets: shareAssets(), ingressPort: port };
  const all = snap.links.length;
  const size = Buffer.byteLength(JSON.stringify(snap));
  if (size > SNAPSHOT_MAX_BYTES) {
    // Rows are near enough the same size: cut to the estimate, then trim until it fits.
    snap.links = snap.links.slice(0, Math.floor((all * SNAPSHOT_MAX_BYTES) / size));
    while (snap.links.length && Buffer.byteLength(JSON.stringify(snap)) > SNAPSHOT_MAX_BYTES) snap.links.pop();
  }
  const omitted = routes.length - snap.links.length;
  if (omitted !== lastOmitted) {
    lastOmitted = omitted;
    if (omitted) console.warn(`[share] the registry snapshot has room for ${snap.links.length} links: ${omitted} expiring soonest are left out, and won't open through the gateway`);
  }
  return snap;
}

/** The row kinds a target gets: `h` and `i` always, `s` and `p` only once it stated them itself. */
function kindsFor(target: GatewayTarget | null): Set<RegistryLink["kind"]> {
  const out = new Set<RegistryLink["kind"]>(["h", "i"]);
  for (const k of ["s", "p"] as const) if (routesKind(target, k)) out.add(k);
  return out;
}

/** Whether the current via target itself stated that it routes links of `kind` (GatewayInfo.kinds
    lists it, from its own info since it became the target); h and i always. */
export function gatewayRoutes(kind: RegistryLink["kind"]): boolean {
  return routesKind(currentTarget(), kind);
}

/** Whether the current via target routes session links (kind `s`). */
export function gatewayRoutesSessions(): boolean {
  return gatewayRoutes("s");
}

/** The snapshot this host would send now under `seq` (checked with validateSnapshot before any send). */
export function buildSnapshot(seq: number, now = Date.now()): RegistrySnapshot {
  return snapshotOf(liveLinks(now), seq, kindsFor(currentTarget()));
}

// ---- the send loop --------------------------------------------------------------------------------

type Answer = void | { warning: string };

interface Pending {
  /** The first seq whose snapshot carries this change. */
  carrying: number;
  /** A mint's candidates: its batch's never-seen live hashes of its kind (none for a revoke). */
  candidates: Set<string>;
  /** A mint whose link vanished before its batch was read, or one with no candidate: never confirmed. */
  lost: boolean;
  settle: (a: Answer) => void;
}

let started = false;
let outbox: Outbox = { v: 1, seq: 0, dirty: false };
/** Every hash this push has seen live since it started. */
let seen = new Set<string>();
/** Changes heard, waiting for their batch to be read. */
let batch: { change: ShareLinksChange; resolve: (a: Answer) => void }[] = [];
let batchScheduled = false;
let pending: Pending[] = [];
let inflight: Promise<void> | null = null;
let again = false;
let retry: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
let upHooked = false;
let refresher: NodeJS.Timeout | null = null;
/** Bumped by stop: a loop still awaiting a push from before it settles nothing and sends no more. */
let generation = 0;

function warning(code: LinkWarningCode, label: string): { warning: string } {
  return { warning: LINK_WARNINGS[code].replaceAll("{gateway}", label || "the gateway") };
}

function persist(): void {
  try {
    writeOutbox(outbox);
  } catch (err) {
    console.warn(`[share] could not write the registry outbox: ${(err as Error).name}`);
  }
}

function setDirty(dirty: boolean): void {
  if (outbox.dirty !== dirty) {
    outbox.dirty = dirty;
    persist();
  }
  if (dirty && !retry && started) {
    retry = setInterval(() => void kick(), RETRY_MS);
    retry.unref();
  } else if (!dirty && retry) {
    clearInterval(retry);
    retry = null;
  }
}

/** Answer the changes this seq's snapshot carries (every one, with `upTo` Infinity). */
function settle(upTo: number, answer: (p: Pending) => Answer): void {
  const due = pending.filter((p) => p.carrying <= upTo);
  pending = pending.filter((p) => p.carrying > upTo);
  for (const p of due) p.settle(answer(p));
}

async function sendLoop(): Promise<void> {
  const gen = generation;
  let caughtUp = false;
  let skewRetried = false;
  do {
    again = false;
    const target = currentTarget();
    const peer = target?.peer;
    if (!target || !peer) {
      // No longer routed, or the gateway is no peer: nothing a waiting mint sent is confirmed.
      settle(Infinity, () => warning("unconfirmed", ""));
      setDirty(false);
      return;
    }
    if (outbox.seq >= Number.MAX_SAFE_INTEGER - 1) {
      console.warn("[share] the registry seq is exhausted; remove share-gateway-outbox.json to start again");
      settle(Infinity, () => warning("unconfirmed", peer.label));
      return;
    }
    outbox.seq += 1;
    outbox.dirty = true;
    persist();
    const seq = outbox.seq;
    const now = Date.now();
    const live = liveLinks(now);
    // The capability evidence this snapshot is built on, judged again right before it is sent.
    const kinds = kindsFor(target);
    const snap = snapshotOf(live, seq, kinds);
    const carriesSessions = snap.links.some((l) => l.kind === "s" || l.kind === "p");
    const check = validateSnapshot(JSON.parse(JSON.stringify(snap)), { now });
    if (!check.ok) {
      console.warn(`[share] the registry snapshot failed its own check (${check.why}); not sent`);
      settle(seq, () => warning("unconfirmed", peer.label));
      setDirty(true);
      return;
    }
    const { withdrawn, answered, ack } = await pushSnapshot(target, snap, () => [...kinds].every((k) => routesKind(target, k)));
    if (gen !== generation) return;
    if (withdrawn || !stillCurrent(target)) {
      // The target changed (another gateway, its entry or endpoint edited, or gone) before the
      // send went out or before its answer came: that settles nothing; send to the target now.
      again = true;
      continue;
    }
    if (ack?.ok && ack.seq > seq && !caughtUp && ack.seq < Number.MAX_SAFE_INTEGER - 1) {
      // The gateway holds a newer seq than ours (our outbox was lost): catch up and send again,
      // once per run (a gateway that keeps moving ahead falls through to "not covered").
      caughtUp = true;
      outbox.seq = ack.seq;
      persist();
      again = true;
      continue;
    }
    if (ack?.ok && ack.seq === seq) {
      const sent = new Set(snap.links.map((l) => l.h));
      const collided = new Set(ack.collisions ?? []);
      settle(seq, (p) => (!p.lost && [...p.candidates].every((h) => sent.has(h) && !collided.has(h)) ? undefined : warning("unconfirmed", peer.label)));
      if (!again && !pending.length) setDirty(false);
      continue;
    }
    if (ack && !ack.ok && ack.error === "bad-snapshot" && carriesSessions && !skewRetried) {
      // Refused whole while it carried session rows: its `s` support is no longer believed, and
      // the compatible h/i set goes again at once (once per run), so h/i publication isn't held.
      skewRetried = true;
      forgetKinds();
      console.warn("[share] the gateway refused a snapshot with session or preview links; sending without them until it states their kinds again");
      again = true;
      continue;
    }
    // No answer, a reply that isn't an ack, a refusal, or an ack for another seq: warn, keep it owed.
    const code: LinkWarningCode = ack && !ack.ok && (ack.error === "not-accepted" || ack.error === "not-gateway") ? "not-accepted" : answered ? "unconfirmed" : "unreachable";
    settle(seq, () => warning(code, peer.label));
    setDirty(true);
    if (!again) return;
  } while (again);
}

/** Send the live set now, or once more after the send in flight. Resolves when the loop is idle. */
function kick(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  const run: Promise<void> = sendLoop()
    .catch((err) => {
      console.warn(`[share] registry push failed: ${(err as Error)?.name ?? "error"}`);
      setDirty(true);
      settle(Infinity, () => warning("unconfirmed", viaGatewayPeer()?.label ?? ""));
    })
    .finally(() => {
      if (inflight !== run) return; // stopped meanwhile
      inflight = null;
      // A change that arrived as the loop was finishing is still owed a send.
      if (again && started) void kick();
    });
  inflight = run;
  return run;
}

/** Mark every live hash seen: links that exist while nothing is published (not routed, or before
    a route change) are nobody's candidates later, so a mint that vanished can never borrow one. */
function seeAll(): void {
  for (const l of liveLinks(Date.now())) seen.add(l.h);
}

/** The links-changed listener: join the batch; the answer comes from the covering ack. */
function onChange(change: ShareLinksChange): Answer | Promise<Answer> {
  if (!started) return undefined;
  if (!viaGatewayPeer()) {
    seeAll(); // minted while not routed: never a later mint's candidate
    return undefined;
  }
  return new Promise<Answer>((resolve) => {
    batch.push({ change, resolve });
    if (!batchScheduled) {
      batchScheduled = true;
      // After every listener call already queued: each change emitted so far joins this batch.
      setImmediate(readBatch);
    }
  });
}

/** Read the batch's live set once, work out each change's candidates, and send. */
function readBatch(): void {
  batchScheduled = false;
  const events = batch;
  batch = [];
  const peer = started ? viaGatewayPeer() : null;
  if (!peer) {
    for (const e of events) e.resolve(warning("unconfirmed", ""));
    return;
  }
  const fresh = { h: new Set<string>(), i: new Set<string>(), s: new Set<string>(), p: new Set<string>() };
  const liveNow = liveLinks(Date.now());
  const liveSet = new Set(liveNow.map((l) => l.h));
  // A mint that names its hashes owns exactly those: they are nobody else's fresh candidates.
  const named = new Set(events.flatMap((e) => (e.change.cause === "mint" ? (e.change.hashes ?? []) : [])));
  for (const l of liveNow) {
    if (seen.has(l.h) || l.kind === "x") continue;
    seen.add(l.h);
    if (!named.has(l.h)) fresh[l.kind].add(l.h);
  }
  for (const h of named) seen.add(h);
  const mints = { h: 0, i: 0, s: 0, p: 0 };
  for (const e of events) if (e.change.cause === "mint" && !e.change.hashes) mints[e.change.kind] += 1;
  const carrying = outbox.seq + 1;
  for (const e of events) {
    const k = e.change.kind;
    const mint = e.change.cause === "mint";
    let candidates: Set<string>;
    let lost: boolean;
    if (mint && e.change.hashes) {
      // Every hash this mint returned must still be live now, then sent and accepted.
      candidates = new Set(e.change.hashes);
      lost = candidates.size === 0 || [...candidates].some((h) => !liveSet.has(h));
    } else {
      candidates = mint ? fresh[k] : new Set<string>();
      lost = mint && (fresh[k].size < mints[k] || candidates.size === 0);
    }
    pending.push({ carrying, candidates, lost, settle: e.resolve });
  }
  void kick();
}

/** Send the live set to the via gateway now (tests await it; start and the gateway's `up` call it). */
export function pushNow(): Promise<void> {
  return started ? kick() : Promise.resolve();
}

/** The setting or the gateway changed: a routed host sends its set to its (new) gateway; a host
    no longer routed answers every waiting mint with a warning. */
export function registryRouteChanged(): void {
  if (!started) return;
  // Whatever is live now predates the new route: only links minted from here on are candidates.
  seeAll();
  if (viaGatewayPeer()) void refreshThenPush();
  void kick();
}

/** Ask the gateway again; when it now lists `s` or `p` and didn't before, those links are owed. */
async function refreshThenPush(): Promise<void> {
  const before = [gatewayRoutes("s"), gatewayRoutes("p")];
  await refreshGateway();
  if (started && ((!before[0] && gatewayRoutes("s")) || (!before[1] && gatewayRoutes("p")))) {
    setDirty(true);
    void kick();
  }
}

export function startRegistryPush(): void {
  if (started) return;
  started = true;
  outbox = readOutbox();
  seen = new Set(liveLinks(Date.now()).map((l) => l.h));
  unsubscribe = onShareLinksChanged(onChange);
  if (!upHooked) {
    upHooked = true;
    // meshApi hooks can't be removed, so it's added once and checks `started` itself.
    meshApi.onPeerUp((peerId) => {
      if (started && viaGatewayPeer()?.id === peerId) {
        // A gateway that came back is asked again; what it last stated stays in effect (the
        // preview address reads it) until that answer replaces it, and the push follows it.
        void refreshThenPush().finally(() => void kick());
      }
    });
  }
  if (outbox.dirty) setDirty(true);
  refresher = setInterval(() => {
    if (viaGatewayPeer()) void refreshThenPush();
  }, REFRESH_MS);
  refresher.unref();
  if (viaGatewayPeer()) {
    void refreshThenPush();
    void kick();
  }
}

export function stopRegistryPush(): void {
  if (!started) return;
  started = false;
  generation += 1;
  inflight = null;
  again = false;
  unsubscribe?.();
  unsubscribe = null;
  if (retry) clearInterval(retry);
  retry = null;
  if (refresher) clearInterval(refresher);
  refresher = null;
  for (const e of batch.splice(0)) e.resolve(warning("unconfirmed", viaGatewayPeer()?.label ?? ""));
  settle(Infinity, () => warning("unconfirmed", viaGatewayPeer()?.label ?? ""));
}
