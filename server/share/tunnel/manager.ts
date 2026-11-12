import { existsSync, mkdirSync, readFileSync, rmSync, watch as fsWatch } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import type { TunnelKey, TunnelMode, TunnelState, TunnelStatus } from "../../../shared/public-links";
import { DetachedDriver, realExec, SystemdDriver, type Driver } from "../../project-services/drivers";
import { stateHash } from "../../project-services/store";
import { verifyPublicUrl } from "../front";
import { resolveCloudflared, onCloudflaredChanged, type CloudflaredFound } from "./binary";
import { readTunnels, writeTunnels, type TunnelRecord } from "./state";
import {
  cloudflaredArgv,
  detachedArgv,
  envFileOf,
  exitFileOf,
  exitReason,
  FORBIDDEN_TARGETS,
  keyOfRecordId,
  logsDirOf,
  maskSecrets,
  parseExitLine,
  pidFileOf,
  plainPath,
  procsDirOf,
  recordIdOf,
  TUNNEL_SLICE,
  TUNNEL_STOP_SEC,
  tunnelsDir,
  tunnelsFile,
  tunnelUnitOf,
  tunnelUnitPrefix,
  unitProperties,
  writeHook,
  hookPath,
} from "./units";

/**
 * The tunnel manager (§mesh.tunnel/lifetime). Sova's Cloudflare tunnels run as units of their own
 * (systemd transient user units in sova-tunnels.slice, or detached sessions), so they outlive Sova;
 * this module starts, reattaches, checks and stops them.
 *
 * Rule: events invalidate, demands read. Nothing here runs on a timer to ask a tunnel's state. It
 * learns of a tunnel connecting (`<unit>.pid`, written by cloudflared) and ending (`<unit>.exit`,
 * written by the unit's stop hook) from one fs.watch on the tunnels folder, armed only while a
 * tunnel is recorded. A check (loopback GET /ready, /quicktunnel) runs only on demand and at most
 * once a window per tunnel; systemctl runs only to start, stop, or when a tunnel doesn't answer.
 * The only timers: a failing start's retries (30 s, 2 min, 10 min) and the waits inside one start.
 */

export const CHECK_WINDOW_MS = 60_000;
export const START_WAIT_MS = 20_000;
/** How long a started tunnel may take to connect before the start counts as failed. */
export const CONNECT_MAX_MS = 60_000;
export const AUTO_RESTARTS_PER_HOUR = 3;
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const HOUR = 3_600_000;
const SECOND_LOOK_MS = 5_000;
const VERIFY_TRIES = 3;
const VERIFY_GAP_MS = 2_000;
const LOG_LINES = 12;

export type DriverId = "systemd" | "detached";
export type MetricsAnswer = { status: number; body: unknown } | null;
export interface Timer {
  cancel(): void;
}

export interface TunnelDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A one-shot timer that never keeps the process alive. */
  setTimer(fn: () => void, ms: number): Timer;
  /** Which driver new tunnels run under (asked once, at the first start). */
  chooseDriver(): Promise<DriverId>;
  driver(id: DriverId, mode: TunnelMode): Driver;
  resolveCloudflared(): Promise<CloudflaredFound>;
  /** Binds the share listener and answers its loopback port; `recorded` must be bound exactly. Idempotent. */
  shareTarget(recorded: number | null): Promise<number>;
  /** Preview tunnels' target; defaults to shareTarget. */
  previewTarget?(appPort: number, recorded: number | null): Promise<number>;
  /** The share tunnel is still wanted (a live link, or route account): decides restarts on its own. */
  shareWanted(): boolean;
  previewWanted(appPort: number): boolean;
  /** Which mode the share tunnel runs in (the route). */
  shareMode(): TunnelMode;
  /** The Account tunnel's token and address, null when none is saved. */
  account(): { token: string; publicUrl: string } | null;
  /** One loopback GET on cloudflared's metrics port; null when nothing answers. */
  metrics(port: number, path: string): Promise<MetricsAnswer>;
  freePort(): Promise<number>;
  verify(origin: string): Promise<{ ok: boolean; error?: string }>;
  /** Watch the tunnels folder; the callback gets a file name. */
  watch(dir: string, onFile: (name: string) => void): { close(): void };
  /** Env the unit runs with (never the token: that is added for Account only). */
  unitEnv(found: CloudflaredFound & { ok: true }): Record<string, string>;
  dir(): string;
  hash(): string;
  log(line: string): void;
}

interface Entry {
  key: TunnelKey;
  id: string;
  unit: string;
  rec: TunnelRecord | null;
  state: TunnelState;
  mode: TunnelMode;
  reason?: string;
  detail?: string[];
  /** The last address and when it ended, once this tunnel has had one. */
  previous?: { origin: string; endedAt: number };
  checkedAt: number;
  /** An event came since the last check: the next demand checks again. */
  dirty: boolean;
  /** When /ready first answered 503 in a row of checks. */
  downSince?: number;
  starting?: Promise<TunnelStatus>;
  /** Resolves the start in progress at a `.pid` (true) or `.exit` (false) event. */
  waiter?: (connected: boolean) => void;
  stopping: boolean;
  /** A stop came during the start: the start ends without a retry. */
  aborted: boolean;
  retryAt: number;
  retry?: Timer;
  autoRestarts: number[];
  /** The port its last run forwarded to: a restart binds exactly that one (a link's tunnel may still point at it). */
  lastTarget: number | null;
  /** Serialises check/stop on this tunnel. */
  chain: Promise<unknown>;
}

const sameOrigin = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const hostOf = (origin: string): string => new URL(origin).hostname.toLowerCase();

export class TunnelManager {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(s: TunnelStatus) => void>();
  private watcher: { close(): void } | null = null;
  private driverId: Promise<DriverId> | null = null;
  private unsubCloudflared: (() => void) | null = null;

  constructor(private deps: TunnelDeps) {}

  configure(more: Partial<TunnelDeps>): void {
    this.deps = { ...this.deps, ...more };
  }

  // ---- reads (memory only) ----------------------------------------------------------------------

  status(key: TunnelKey): TunnelStatus {
    const e = this.entries.get(recordIdOf(key));
    if (!e) return { key, mode: key.kind === "share" ? this.safeShareMode() : "quick", state: "stopped", origin: null, epoch: null };
    return this.statusOf(e);
  }

  running(): TunnelStatus[] {
    return [...this.entries.values()].filter((e) => e.rec || e.starting || e.state === "needs-cloudflared" || e.state === "failed").map((e) => this.statusOf(e));
  }

  previewHosts(): ReadonlyMap<string, number> {
    const m = new Map<string, number>();
    for (const e of this.entries.values())
      if (e.key.kind === "preview" && e.rec?.origin && (e.state === "up" || e.state === "degraded")) m.set(hostOf(e.rec.origin), e.key.port);
    return m;
  }

  recordedTargetPort(key: TunnelKey): number | null {
    const e = this.entries.get(recordIdOf(key));
    if (e?.rec) return e.rec.targetPort;
    const r = readTunnels(tunnelsFile(this.deps.dir()));
    return r.kind === "ok" ? (r.file.tunnels[recordIdOf(key)]?.targetPort ?? null) : null;
  }

  onChanged(cb: (s: TunnelStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---- ensure / start ---------------------------------------------------------------------------

  /** The tunnel, started when it isn't running; checked (within the window) when it is. Never downloads. */
  async ensure(key: TunnelKey, opts: { waitMs?: number; by?: string } = {}): Promise<TunnelStatus> {
    const e = this.entry(key);
    if (e.starting) return this.raceWait(e.starting, e, opts.waitMs);
    if (e.rec) {
      const s = await this.check(key);
      if (s.state === "up" || s.state === "degraded" || s.state === "starting") return s;
      // The check found it gone and did not start it again (not wanted): the caller wants it.
      if (e.starting) return this.raceWait(e.starting, e, opts.waitMs);
    }
    return this.raceWait(this.begin(e, opts.by ?? "operator"), e, opts.waitMs);
  }

  /** Stop, then start again (a new Account token: the unit's env is only written at start). */
  async restart(key: TunnelKey, why: string): Promise<TunnelStatus> {
    await this.stop(key, why);
    return this.ensure(key, { by: why });
  }

  private raceWait(p: Promise<TunnelStatus>, e: Entry, waitMs = START_WAIT_MS): Promise<TunnelStatus> {
    let t: Timer | undefined;
    const timeout = new Promise<TunnelStatus>((ok) => {
      t = this.deps.setTimer(() => ok(this.statusOf(e)), waitMs);
    });
    return Promise.race([p, timeout]).finally(() => t?.cancel());
  }

  private begin(e: Entry, by: string): Promise<TunnelStatus> {
    e.retry?.cancel();
    e.retry = undefined;
    const p = this.start(e, by).finally(() => {
      if (e.starting === p) e.starting = undefined;
    });
    e.starting = p;
    return p;
  }

  private async start(e: Entry, by: string): Promise<TunnelStatus> {
    const deps = this.deps;
    const mode: TunnelMode = e.key.kind === "share" ? this.safeShareMode() : "quick";
    e.mode = mode;
    const account = mode === "account" ? deps.account() : null;
    if (mode === "account" && !account) return this.settle(e, "failed", "no-token");
    const found = await deps.resolveCloudflared();
    if (!found.ok) {
      this.armCloudflared();
      return this.settle(e, "needs-cloudflared", found.reason);
    }
    e.aborted = false;
    this.set(e, "starting");
    let driverId = await this.chooseDriver();
    const dir = deps.dir();
    const hook = writeHook(dir);
    if (driverId === "systemd" && !plainPath(hook)) driverId = "detached";
    const old = e.rec;
    let targetPort: number;
    try {
      targetPort = e.key.kind === "preview" && deps.previewTarget ? await deps.previewTarget(e.key.port, old?.targetPort ?? e.lastTarget) : await deps.shareTarget(old?.targetPort ?? e.lastTarget);
    } catch (err) {
      return this.failStart(e, `The share listener couldn't be opened: ${(err as Error).message}`);
    }
    if (FORBIDDEN_TARGETS.has(targetPort)) return this.failStart(e, `A tunnel never forwards to port ${targetPort}.`);
    e.lastTarget = targetPort;
    const metricsPort = await deps.freePort();
    const unit = e.unit;
    rmSync(pidFileOf(unit, dir), { force: true });
    rmSync(exitFileOf(unit, dir), { force: true });
    const now = deps.now();
    // Recorded before it starts: a crash between the two leaves a record to clean up, never an unknown unit.
    e.rec = {
      mode,
      unit,
      driver: driverId,
      metricsPort,
      targetPort,
      origin: old?.origin ?? null,
      connectorId: null,
      epoch: old?.epoch ?? null,
      startedAt: now,
      startedBy: by,
      ...(e.previous ? { previous: e.previous } : {}),
      autoRestarts: e.autoRestarts.filter((t) => now - t < HOUR),
    };
    this.persist();
    this.armWatch();
    const argv = cloudflaredArgv({ cloudflared: found.path, mode, targetPort, metricsPort, pidfile: pidFileOf(unit, dir) });
    const env = { ...deps.unitEnv(found), ...(account ? { TUNNEL_TOKEN: account.token } : {}) };
    const connected = new Promise<boolean>((ok) => {
      e.waiter = ok;
    });
    try {
      await deps.driver(driverId, mode).start({ unit, argv: driverId === "detached" ? detachedArgv(hook, unit, argv) : argv, cwd: dir, env });
    } catch (err) {
      e.waiter = undefined;
      await this.killUnit(e);
      await this.dropUnit(e);
      return this.failStart(e, `cloudflared couldn't be started: ${(err as Error).message}`);
    }
    // Written before the watch saw it (a fast connect), or arriving later.
    if (existsSync(pidFileOf(unit, dir))) e.waiter?.(true);
    if (e.aborted) e.waiter?.(false);
    let timer: Timer | undefined;
    const ok = await Promise.race([connected, new Promise<boolean | null>((r) => (timer = deps.setTimer(() => r(null), CONNECT_MAX_MS)))]);
    timer?.cancel();
    e.waiter = undefined;
    if (ok !== true) {
      const detail = await this.unitLog(e);
      const ended = ok === false ? this.readExit(e) : null;
      await this.killUnit(e);
      await this.dropUnit(e);
      return this.failStart(e, ended ? exitReason(ended) : "cloudflared didn't reach Cloudflare in time.", detail);
    }
    return this.connected(e, account?.publicUrl ?? null);
  }

  /** After the `.pid` event: read the address, check it from outside once, record a new epoch when it changed. */
  private async connected(e: Entry, accountUrl: string | null): Promise<TunnelStatus> {
    const deps = this.deps;
    const rec = e.rec!;
    const ready = await deps.metrics(rec.metricsPort, "/ready");
    const connectorId = typeof (ready?.body as { connectorId?: unknown } | undefined)?.connectorId === "string" ? ((ready!.body as { connectorId: string }).connectorId) : null;
    let origin = accountUrl;
    if (rec.mode === "quick") {
      const q = await deps.metrics(rec.metricsPort, "/quicktunnel");
      const host = (q?.body as { hostname?: unknown } | undefined)?.hostname;
      origin = typeof host === "string" && /^[a-z0-9.-]+$/i.test(host) ? `https://${host.toLowerCase()}` : null;
      if (!origin) {
        const detail = await this.unitLog(e);
        await this.killUnit(e);
        await this.dropUnit(e);
        return this.failStart(e, "cloudflared didn't say its address.", detail);
      }
    }
    const now = deps.now();
    if (!sameOrigin(rec.origin, origin)) {
      if (rec.origin) e.previous = { origin: rec.origin, endedAt: now };
      rec.epoch = now;
      delete rec.verifiedAt;
    } else if (rec.epoch === null) rec.epoch = now;
    rec.origin = origin;
    rec.connectorId = connectorId;
    if (e.previous) rec.previous = e.previous;
    this.persist();
    let verified: { ok: boolean; error?: string } = { ok: false, error: "unchecked" };
    if (origin && !rec.verifiedAt) {
      for (let i = 0; i < VERIFY_TRIES; i++) {
        if (i) await deps.sleep(VERIFY_GAP_MS);
        verified = await deps.verify(origin);
        if (verified.ok || !e.rec) break;
      }
      if (!e.rec) return this.statusOf(e); // stopped meanwhile
      if (verified.ok) rec.verifiedAt = deps.now();
      this.persist();
    }
    e.retryAt = 0;
    e.checkedAt = deps.now();
    e.dirty = false;
    e.downSince = undefined;
    return rec.verifiedAt ? this.settle(e, "up") : this.settle(e, "degraded", `The new address didn't answer from outside yet${verified.error ? ` (${verified.error})` : ""}.`);
  }

  private failStart(e: Entry, reason: string, detail?: string[]): TunnelStatus {
    if (e.aborted) {
      e.aborted = false;
      return this.settle(e, "stopped", undefined);
    }
    const s = this.settle(e, "failed", reason, detail);
    this.scheduleRetry(e);
    return s;
  }

  /** A failing start is tried again after 30 s, 2 min, 10 min while it is still wanted; then left to the next demand. */
  private scheduleRetry(e: Entry): void {
    const delay = RETRY_DELAYS_MS[e.retryAt];
    if (delay === undefined || !this.wanted(e.key)) return;
    e.retryAt++;
    e.retry?.cancel();
    e.retry = this.deps.setTimer(() => {
      e.retry = undefined;
      if (!e.starting && !e.rec && this.wanted(e.key)) void this.begin(e, "retry");
    }, delay);
  }

  // ---- check (on demand) ------------------------------------------------------------------------

  /** The on-demand check: a Map read inside the window when no event came; else one loopback look. */
  check(key: TunnelKey): Promise<TunnelStatus> {
    const e = this.entries.get(recordIdOf(key));
    if (!e) return Promise.resolve(this.status(key));
    if (e.starting || !e.rec) return Promise.resolve(this.statusOf(e));
    if (!e.dirty && this.deps.now() - e.checkedAt < CHECK_WINDOW_MS) return Promise.resolve(this.statusOf(e));
    return this.serial(e, () => this.probe(e));
  }

  private serial<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const p = e.chain.then(fn, fn);
    e.chain = p.catch(() => {});
    return p;
  }

  private async probe(e: Entry, second = false): Promise<TunnelStatus> {
    const rec = e.rec;
    if (!rec || e.starting) return this.statusOf(e);
    if (!e.dirty && !second && this.deps.now() - e.checkedAt < CHECK_WINDOW_MS) return this.statusOf(e);
    const look = await this.look(rec);
    e.checkedAt = this.deps.now();
    e.dirty = false;
    if (look === "up") {
      e.downSince = undefined;
      return rec.verifiedAt || rec.mode === "account" ? this.settle(e, "up") : this.settle(e, "degraded", e.reason ?? "The address didn't answer from outside yet.");
    }
    if (look === "down") {
      // Alive, no edge connection (network down, or Cloudflare dropped it while the computer slept).
      e.downSince ??= this.deps.now();
      if (!second) {
        this.settle(e, "degraded", "The tunnel isn't connected to Cloudflare right now.");
        await this.deps.sleep(SECOND_LOOK_MS);
        return this.probe(e, true);
      }
      if (rec.mode === "quick" && this.deps.now() - e.downSince >= 2 * CHECK_WINDOW_MS && this.wanted(e.key)) {
        await this.stopUnit(e, "down too long");
        void this.begin(e, "check");
        return this.statusOf(e);
      }
      return this.settle(e, "degraded", "The tunnel isn't connected to Cloudflare right now.");
    }
    // Nothing answers, or another tunnel does: ask the service manager once.
    const st = await this.deps
      .driver(rec.driver, rec.mode)
      .status(rec.unit)
      .catch(() => ({ state: "missing" as const, pid: null }));
    const alive = st.state === "active" || st.state === "activating";
    if (look === "silent" && alive && !existsSync(exitFileOf(rec.unit, this.deps.dir()))) {
      return this.settle(e, "degraded", rec.mode === "account" && st.state === "activating" ? "The tunnel is starting again." : "The tunnel doesn't answer.");
    }
    if (alive) await this.killUnit(e);
    await this.ended(e, this.readExit(e), "check");
    return this.statusOf(e);
  }

  /** One loopback look: up (the recorded connector and, Free, host), down (503), silent (no answer), other (another tunnel). */
  private async look(rec: TunnelRecord): Promise<"up" | "down" | "silent" | "other"> {
    const ready = await this.deps.metrics(rec.metricsPort, "/ready");
    if (!ready) return "silent";
    const cid = (ready.body as { connectorId?: unknown } | null)?.connectorId;
    if (rec.connectorId && typeof cid === "string" && cid !== rec.connectorId) return "other";
    if (ready.status === 503) return "down";
    if (ready.status !== 200) return "other";
    if (rec.mode === "quick") {
      const q = await this.deps.metrics(rec.metricsPort, "/quicktunnel");
      const host = (q?.body as { hostname?: unknown } | null)?.hostname;
      if (!rec.origin || typeof host !== "string" || !sameOrigin(`https://${host}`, rec.origin)) return "other";
    }
    return "up";
  }

  // ---- events -----------------------------------------------------------------------------------

  private onFile(name: string): void {
    const m = /^(.+)\.(pid|exit)$/.exec(name);
    if (!m) return;
    const e = [...this.entries.values()].find((x) => x.unit === m[1]);
    if (!e) return;
    if (m[2] === "pid") {
      if (!existsSync(pidFileOf(e.unit, this.deps.dir()))) return;
      if (e.waiter) e.waiter(true);
      else e.dirty = true; // an Account unit systemd restarted: the next demand reads it again
      return;
    }
    const exit = this.readExit(e);
    if (!exit) return;
    if (e.waiter) return e.waiter(false);
    if (e.stopping || !e.rec) return;
    if (e.starting) {
      e.dirty = true; // ended while its start was finishing: the next demand looks again
      return;
    }
    if (exit.at + 1000 < e.rec.startedAt) return; // an older run's
    void this.serial(e, () => this.ended(e, exit, "exit"));
  }

  /** The tunnel's unit ended (its exit event, or a check that found it gone). */
  private async ended(e: Entry, exit: ReturnType<typeof parseExitLine>, from: "exit" | "check" | "adopt"): Promise<void> {
    const rec = e.rec;
    if (!rec) return;
    const deps = this.deps;
    // An Account unit under systemd is restarted by systemd itself, with the same address.
    if (from === "exit" && rec.mode === "account" && rec.driver === "systemd") {
      e.dirty = true;
      rmSync(exitFileOf(rec.unit, deps.dir()), { force: true });
      this.settle(e, "degraded", "The tunnel is starting again.");
      return;
    }
    const detail = await this.unitLog(e);
    const now = deps.now();
    if (rec.origin && rec.mode === "quick") e.previous = { origin: rec.origin, endedAt: exit?.at ?? now };
    await this.dropUnit(e);
    const wanted = this.wanted(e.key);
    const reason = exit ? exitReason(exit) : "The tunnel is gone.";
    if (wanted) {
      const recent = e.autoRestarts.filter((t) => now - t < HOUR);
      // From an exit event: within the hourly budget. From a demand: always (it is the demand).
      if (from !== "exit" || recent.length < AUTO_RESTARTS_PER_HOUR) {
        if (from === "exit") e.autoRestarts = [...recent, now];
        deps.log(`tunnel ${e.id}: ${reason} Starting it again.`);
        this.settle(e, "stopped", reason, detail);
        void this.begin(e, from === "exit" ? "restart" : from);
        return;
      }
      deps.log(`tunnel ${e.id}: ${reason} Restart budget spent; starting again on the next demand.`);
    }
    this.settle(e, exit && exit.result !== "success" ? "failed" : "stopped", reason, detail);
  }

  // ---- stop -------------------------------------------------------------------------------------

  async stop(key: TunnelKey, why: string): Promise<void> {
    const e = this.entries.get(recordIdOf(key));
    if (!e) return;
    e.retry?.cancel();
    e.retry = undefined;
    e.retryAt = 0;
    if (e.starting) {
      e.aborted = true;
      e.waiter?.(false);
      await e.starting.catch(() => {});
      e.aborted = false;
    }
    await this.serial(e, async () => {
      if (!e.rec) {
        if (e.state !== "stopped") this.settle(e, "stopped", undefined);
        return;
      }
      if (e.rec.origin && e.rec.mode === "quick") e.previous = { origin: e.rec.origin, endedAt: this.deps.now() };
      await this.stopUnit(e, why);
      this.settle(e, "stopped", undefined);
    });
  }

  private async stopUnit(e: Entry, why: string): Promise<void> {
    const rec = e.rec;
    if (!rec) return;
    e.stopping = true;
    try {
      this.deps.log(`tunnel ${e.id}: stopping (${why})`);
      await this.deps.driver(rec.driver, rec.mode).stop(rec.unit).catch((err) => this.deps.log(`tunnel ${e.id}: stop failed: ${(err as Error).message}`));
      await this.dropUnit(e);
    } finally {
      e.stopping = false;
    }
  }

  /** Stop the unit's processes through its driver, keeping the record (the caller drops it). */
  private async killUnit(e: Entry): Promise<void> {
    const rec = e.rec;
    if (!rec) return;
    e.stopping = true;
    try {
      await this.deps.driver(rec.driver, rec.mode).stop(rec.unit).catch((err) => this.deps.log(`tunnel ${e.id}: stop failed: ${(err as Error).message}`));
    } finally {
      e.stopping = false;
    }
  }

  /** Forget the unit: record, pid, exit and env files. */
  private async dropUnit(e: Entry): Promise<void> {
    const dir = this.deps.dir();
    const unit = e.unit;
    for (const f of [pidFileOf(unit, dir), exitFileOf(unit, dir), envFileOf(unit, dir)]) rmSync(f, { force: true });
    if (e.rec?.driver === "detached") rmSync(`${procsDirOf(dir)}/${unit}.json`, { force: true });
    e.rec = null;
    this.persist();
    if (![...this.entries.values()].some((x) => x.rec)) this.disarmWatch();
  }

  // ---- adopt ------------------------------------------------------------------------------------

  /** Once, at a server start: reattach each recorded tunnel. No tunnels.json: nothing runs at all. */
  async adopt(): Promise<void> {
    const dir = this.deps.dir();
    const r = readTunnels(tunnelsFile(dir));
    if (r.kind === "missing") return;
    if (r.kind === "broken") {
      this.deps.log(`tunnels.json can't be read (${r.reason}): stopping this state root's tunnel units`);
      await this.stopStray();
      writeTunnels({}, tunnelsFile(dir));
      return;
    }
    for (const [id, rec] of Object.entries(r.file.tunnels)) {
      const key = keyOfRecordId(id)!;
      const e = this.entry(key);
      e.rec = rec;
      e.lastTarget = rec.targetPort;
      e.mode = rec.mode;
      e.autoRestarts = rec.autoRestarts;
      if (rec.previous) e.previous = rec.previous;
    }
    this.armWatch();
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => e.rec)
        .map((e) =>
          this.serial(e, async () => {
            const rec = e.rec!;
            const exit = this.readExit(e);
            if (exit && exit.at + 1000 >= rec.startedAt) return this.ended(e, exit, "adopt");
            const look = await this.look(rec);
            e.checkedAt = this.deps.now();
            if (look === "up") return void this.settle(e, rec.verifiedAt || rec.mode === "account" ? "up" : "degraded", rec.verifiedAt || rec.mode === "account" ? undefined : "The address didn't answer from outside yet.");
            if (look === "down") return void this.settle(e, "degraded", "The tunnel isn't connected to Cloudflare right now.");
            const st = await this.deps.driver(rec.driver, rec.mode).status(rec.unit).catch(() => ({ state: "missing" as const, pid: null }));
            if (look === "silent" && (st.state === "active" || st.state === "activating")) {
              // Still connecting (no pidfile yet), or an Account unit between restarts: its events tell the rest.
              e.dirty = true;
              return void this.settle(e, "degraded", "The tunnel doesn't answer yet.");
            }
            if (st.state === "active" || st.state === "activating") await this.killUnit(e);
            return this.ended(e, exit, "adopt");
          }),
        ),
    );
  }

  /** A tunnels.json that can't be read: every unit of this state root's prefix is stopped, by name. */
  private async stopStray(): Promise<void> {
    const prefix = tunnelUnitPrefix(this.deps.hash());
    for (const id of ["systemd", "detached"] as const) {
      if (id === "systemd" && (await this.chooseDriver()) !== "systemd") continue;
      const d = this.deps.driver(id, "quick");
      for (const unit of await d.units(prefix).catch(() => [] as string[])) await d.stop(unit).catch(() => {});
    }
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private entry(key: TunnelKey): Entry {
    const id = recordIdOf(key);
    let e = this.entries.get(id);
    if (!e) {
      e = { key, id, unit: tunnelUnitOf(key, this.deps.hash()), rec: null, state: "stopped", mode: "quick", checkedAt: 0, dirty: false, stopping: false, aborted: false, retryAt: 0, autoRestarts: [], lastTarget: null, chain: Promise.resolve() };
      this.entries.set(id, e);
    }
    return e;
  }

  private wanted(key: TunnelKey): boolean {
    try {
      return key.kind === "share" ? this.deps.shareWanted() : this.deps.previewWanted(key.port);
    } catch {
      return false;
    }
  }

  private safeShareMode(): TunnelMode {
    try {
      return this.deps.shareMode();
    } catch {
      return "quick";
    }
  }

  private chooseDriver(): Promise<DriverId> {
    this.driverId ??= this.deps.chooseDriver().catch(() => "detached" as const);
    return this.driverId;
  }

  private readExit(e: Entry) {
    try {
      return parseExitLine(readFileSync(exitFileOf(e.unit, this.deps.dir()), "utf8"));
    } catch {
      return null;
    }
  }

  private async unitLog(e: Entry): Promise<string[] | undefined> {
    const rec = e.rec;
    if (!rec) return undefined;
    const lines = await this.deps
      .driver(rec.driver, rec.mode)
      .logs(rec.unit, LOG_LINES)
      .catch(() => []);
    const text = lines.map((l) => l.text).filter((t) => t.trim() && !/^(Started|Stopped|Stopping|Deactivated|Consumed|Main process exited|Failed with result)/.test(t));
    return text.length ? maskSecrets(text.slice(-LOG_LINES)) : undefined;
  }

  private persist(): void {
    const tunnels: Record<string, TunnelRecord> = {};
    for (const e of this.entries.values())
      if (e.rec) tunnels[e.id] = { ...e.rec, autoRestarts: e.autoRestarts.filter((t) => this.deps.now() - t < HOUR), ...(e.previous ? { previous: e.previous } : {}) };
    writeTunnels(tunnels, tunnelsFile(this.deps.dir()));
  }

  private armWatch(): void {
    if (this.watcher) return;
    const dir = this.deps.dir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.watcher = this.deps.watch(dir, (name) => this.onFile(name));
  }

  private disarmWatch(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** While a tunnel waits for cloudflared: a download retries it (no timer). */
  private armCloudflared(): void {
    if (this.unsubCloudflared) return;
    this.unsubCloudflared = onCloudflaredChanged(() => {
      this.unsubCloudflared?.();
      this.unsubCloudflared = null;
      for (const e of this.entries.values()) if (e.state === "needs-cloudflared" && this.wanted(e.key)) void this.begin(e, "cloudflared");
    });
  }

  private set(e: Entry, state: TunnelState, reason?: string, detail?: string[]): void {
    const changed = e.state !== state || e.reason !== reason;
    e.state = state;
    e.reason = reason;
    e.detail = detail;
    if (changed) this.fire(e);
  }

  private settle(e: Entry, state: TunnelState, reason?: string, detail?: string[]): TunnelStatus {
    const before = `${e.state}|${e.reason}|${e.rec?.origin ?? ""}|${e.rec?.epoch ?? ""}`;
    e.state = state;
    e.reason = reason;
    e.detail = detail;
    if (before !== `${state}|${reason}|${e.rec?.origin ?? ""}|${e.rec?.epoch ?? ""}`) this.fire(e);
    return this.statusOf(e);
  }

  private fire(e: Entry): void {
    const s = this.statusOf(e);
    for (const cb of this.listeners)
      try {
        cb(s);
      } catch (err) {
        this.deps.log(`tunnel listener failed: ${(err as Error).message}`);
      }
  }

  private statusOf(e: Entry): TunnelStatus {
    const live = !!e.rec && e.state !== "stopped" && e.state !== "failed";
    return {
      key: e.key,
      mode: e.mode,
      state: e.state,
      origin: live ? (e.rec?.origin ?? null) : null,
      epoch: live ? (e.rec?.epoch ?? null) : null,
      ...(e.previous ? { previous: e.previous } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
      ...(e.detail?.length ? { detail: e.detail } : {}),
    };
  }

  /** Tests only. */
  hasWatch(): boolean {
    return !!this.watcher;
  }
}

// ---- real deps ----------------------------------------------------------------------------------

/** Where tunnels run: detached with SOVA_TUNNEL_DRIVER=detached (tests), off Linux, or with no user manager. */
export async function chooseTunnelDriver(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<DriverId> {
  if (env.SOVA_TUNNEL_DRIVER?.trim() === "detached" || platform !== "linux") return "detached";
  return (await new SystemdDriver().available()).ok ? "systemd" : "detached";
}

/** The driver a tunnel of `mode` runs under. */
export function tunnelDriver(id: DriverId, mode: TunnelMode, dir = tunnelsDir(), env: NodeJS.ProcessEnv = process.env): Driver {
  if (id === "detached") return new DetachedDriver(TUNNEL_STOP_SEC * 1000, { restart: false, procsDir: () => procsDirOf(dir), logsDir: () => logsDirOf(dir) });
  return new SystemdDriver(realExec, {
    slice: env.SOVA_TUNNEL_SLICE?.trim() || TUNNEL_SLICE,
    timeoutStopSec: TUNNEL_STOP_SEC,
    restart: false,
    envFile: (unit) => envFileOf(unit, dir),
    properties: (unit) => unitProperties(mode, unit, hookPath(dir)),
  });
}

async function loopbackGet(port: number, path: string): Promise<MetricsAnswer> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3_000), headers: { accept: "application/json" } });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => (port ? ok(port) : fail(new Error("no free port"))));
    });
  });
}

export function realTunnelDeps(env: NodeJS.ProcessEnv = process.env): TunnelDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    },
    chooseDriver: () => chooseTunnelDriver(env),
    driver: (id, mode) => tunnelDriver(id, mode, tunnelsDir(), env),
    resolveCloudflared,
    shareTarget: async () => {
      throw new Error("the share listener isn't wired to the tunnel manager");
    },
    shareWanted: () => false,
    previewWanted: () => false,
    shareMode: () => "quick",
    account: () => null,
    metrics: loopbackGet,
    freePort: freeLoopbackPort,
    verify: (origin) => (env.SOVA_TUNNEL_VERIFY?.trim() === "off" ? Promise.resolve({ ok: true }) : verifyPublicUrl(origin)),
    watch: (dir, onFile) => {
      const w = fsWatch(dir, { persistent: false }, (_ev, f) => {
        if (f) onFile(String(f));
      });
      w.on("error", () => {});
      return { close: () => w.close() };
    },
    unitEnv: (found) => {
      const out: Record<string, string> = { PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: env.HOME || homedir() };
      // The test stand-in's switches reach it only when SOVA_CLOUDFLARED names it.
      if (found.source === "env") for (const [k, v] of Object.entries(env)) if (k.startsWith("FAKE_CF_") && v !== undefined) out[k] = v;
      return out;
    },
    dir: () => tunnelsDir(),
    hash: () => stateHash(),
    log: (line) => console.log(`[tunnels] ${line}`),
  };
}

// ---- the server's one manager -------------------------------------------------------------------

let manager: TunnelManager | null = null;
const theManager = (): TunnelManager => (manager ??= new TunnelManager(realTunnelDeps()));

/** Wiring, at server start (each part gives its own deps; a later call adds to the earlier ones). */
export const configureTunnels = (deps: Partial<TunnelDeps>): void => theManager().configure(deps);
export const ensureTunnel = (key: TunnelKey, opts?: { waitMs?: number; by?: string }): Promise<TunnelStatus> => theManager().ensure(key, opts);
export const tunnelStatus = (key: TunnelKey): TunnelStatus => theManager().status(key);
export const checkTunnel = (key: TunnelKey): Promise<TunnelStatus> => theManager().check(key);
export const stopTunnel = (key: TunnelKey, why: string): Promise<void> => theManager().stop(key, why);
export const restartTunnel = (key: TunnelKey, why: string): Promise<TunnelStatus> => theManager().restart(key, why);
export const adoptTunnels = (): Promise<void> => theManager().adopt();
export const onTunnelChanged = (cb: (s: TunnelStatus) => void): (() => void) => theManager().onChanged(cb);
export const previewTunnelHosts = (): ReadonlyMap<string, number> => theManager().previewHosts();
export const runningTunnels = (): TunnelStatus[] => theManager().running();
export const recordedTargetPort = (key: TunnelKey): number | null => theManager().recordedTargetPort(key);
/** Tests only: a fresh manager. */
export const resetTunnelsForTest = (deps?: TunnelDeps): TunnelManager => (manager = new TunnelManager(deps ?? realTunnelDeps()));
