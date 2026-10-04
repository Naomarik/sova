import { DetachedDriver, DriverError, realExec, SystemdDriver, type Driver, type DriverId, type Exec, type OnceSpec, type RunOnceResult, type UnitSpec, type UnitStatus } from "./drivers";

/**
 * The supervisor is an adapter (§app.project-services/supervisor): one Driver interface, one
 * adapter chosen per server. `SOVA_PROJECT_DRIVER` forces one; otherwise systemd when its user
 * manager answers, else the portable detached driver. `launchd` is a reserved slot: no adapter is
 * built for it, and forcing it leaves process verbs `unsupported`.
 */

export interface Adapter {
  id: DriverId;
  summary: string;
  /** null: reserved, not built. */
  make: ((deps: { exec: Exec }) => Driver) | null;
}

export const ADAPTERS: readonly Adapter[] = [
  { id: "systemd", summary: "systemd transient user units in sova-services.slice", make: ({ exec }) => new SystemdDriver(exec) },
  { id: "detached", summary: "portable detached sessions (any Unix)", make: () => new DetachedDriver(15_000, { restart: true }) },
  { id: "launchd", summary: "launchd agents (macOS)", make: null },
];

export interface Selection {
  id: DriverId | "none";
  /** Why this adapter, in words for doctor and status. */
  why: string;
  driver: Driver | null;
}

export interface SelectDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Runs `systemctl` for the probe and the systemd driver (tests fake it). */
  exec?: Exec;
  /** Builds the detached driver (tests give theirs). */
  detached?: () => Driver;
}

/** Choose the adapter. Never silently: `why` names the switch or the probe that decided it. */
export async function selectDriver(deps: SelectDeps = {}): Promise<Selection> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? realExec;
  const make = (a: Adapter): Driver | null => (a.id === "detached" && deps.detached ? deps.detached() : a.make ? a.make({ exec }) : null);
  const byId = (id: string) => ADAPTERS.find((a) => a.id === id);
  const forced = env.SOVA_PROJECT_DRIVER?.trim();
  if (forced) {
    const a = byId(forced);
    if (!a) return { id: "none", why: `SOVA_PROJECT_DRIVER=${forced} names no adapter (${ADAPTERS.map((x) => x.id).join(", ")})`, driver: null };
    if (!a.make) return { id: a.id, why: `forced by SOVA_PROJECT_DRIVER=${forced}, but the ${a.id} adapter (${a.summary}) is reserved and not built yet`, driver: null };
    return { id: a.id, why: `forced by SOVA_PROJECT_DRIVER=${forced}`, driver: make(a) };
  }
  const detached = byId("detached")!;
  if (env.SOVA_PROJECT_NO_SYSTEMD === "1") return { id: "detached", why: "systemd treated as absent (SOVA_PROJECT_NO_SYSTEMD=1)", driver: make(detached) };
  if (platform !== "linux") return { id: "detached", why: `no systemd on ${platform}`, driver: make(detached) };
  const systemd = byId("systemd")!;
  const sd = make(systemd)!;
  const probe = await sd.available();
  if (probe.ok) return { id: "systemd", why: "the systemd user manager answers", driver: sd };
  return { id: "detached", why: `${probe.detail}`, driver: make(detached) };
}

/**
 * The server's driver: the selection, made once at first use, behind the Driver interface. Before it
 * is made, the synchronous questions answer "nothing" (no pid is owned); every verb awaits it first.
 */
export class SelectedDriver implements Driver {
  private choice: Selection | null = null;
  private pending: Promise<Selection>;
  constructor(deps: SelectDeps = {}) {
    this.pending = selectDriver(deps).then((s) => (this.choice = s));
  }
  get id(): DriverId | "none" {
    return this.choice?.id ?? "none";
  }
  selection(): Promise<Selection> {
    return this.pending;
  }
  private async d(): Promise<Driver> {
    const s = await this.pending;
    if (!s.driver) throw new DriverError(`no supervisor: ${s.why}`);
    return s.driver;
  }
  async available() {
    const s = await this.pending;
    if (!s.driver) return { ok: false, detail: `no supervisor (${s.why})` };
    const a = await s.driver.available();
    return { ok: a.ok, detail: `${a.detail}; chosen because ${s.why}` };
  }
  async start(spec: UnitSpec) {
    return (await this.d()).start(spec);
  }
  async stop(unit: string) {
    return (await this.d()).stop(unit);
  }
  async status(unit: string): Promise<UnitStatus> {
    const s = await this.pending;
    return s.driver ? s.driver.status(unit) : { state: "missing", pid: null };
  }
  async signal(unit: string, sig: string) {
    return (await this.d()).signal(unit, sig);
  }
  owns(unit: string, pid: number) {
    return this.choice?.driver?.owns(unit, pid) ?? false;
  }
  pids(unit: string) {
    return this.choice?.driver?.pids(unit) ?? [];
  }
  async logs(unit: string, lines: number, sinceMs?: number) {
    const s = await this.pending;
    return s.driver ? s.driver.logs(unit, lines, sinceMs) : [];
  }
  async runOnce(spec: OnceSpec): Promise<RunOnceResult> {
    return (await this.d()).runOnce(spec);
  }
  async units(prefix: string) {
    const s = await this.pending;
    return s.driver ? s.driver.units(prefix) : [];
  }
  async adopt() {
    const s = await this.pending;
    await s.driver?.adopt?.();
  }
}
