import type { PortOwner } from "../port-owner";
import { DriverError, type Driver, type OnceSpec, type RunOnceResult, type UnitSpec, type UnitStatus } from "./drivers";
import type { EngineClock, EngineDeps, Readiness } from "./engine";

/**
 * Tests only (nothing in the server imports this). A host in memory for the engine's verb decisions:
 * a driver whose units are records (no process starts), the listeners on this host's ports, the
 * readiness probes and port owner that read those listeners, and a clock that a wait steps. A unit's
 * pids are above the kernel's largest (2^22), so no real process can be one. Each `*.integration.test.ts`
 * beside a unit file keeps one real end to end case of what this fakes.
 */

/** Above any real pid (Linux's pid_max is at most 2^22). */
const FAKE_PID_BASE = 5_000_000;

/** What a started unit does: the ports it listens on at once, those it opens on the clock later, or its exit at start. */
export interface Behaviour {
  /** Ports listened on at start (default: the unit's own declared ports, `SOVA_PORT_<name>` in its env). */
  ports?: number[];
  /** Ports opened once the clock reaches start + `ms`. */
  late?: { port: number; ms: number }[];
  /** The process exits at once with this code (its ports never open). */
  exit?: number;
  /** Lines it writes at start. */
  logs?: string[];
}

interface Unit {
  spec: UnitSpec;
  pid: number | null;
  exit?: number | null;
  logs: string[];
  late: { port: number; at: number }[];
  signals: string[];
}

/** A unit's own declared ports: the engine's `SOVA_PORT_<port>` (every service's are `SOVA_PORT_<service>_<port>`). */
export const ownPorts = (spec: UnitSpec): number[] =>
  Object.entries(spec.env)
    .filter(([k]) => /^SOVA_PORT_[A-Z0-9]+$/.test(k))
    .map(([, v]) => Number(v));

export class FakeClock implements EngineClock {
  t = 1_700_000_000_000;
  constructor(private readonly onStep: () => void = () => undefined) {}
  now() {
    return this.t;
  }
  /** A wait passes at once: the time moves, then whatever was due by then happens. */
  async sleep(ms: number) {
    this.t += ms;
    this.onStep();
    await Promise.resolve();
  }
}

export class FakeDriver implements Driver {
  readonly id = "detached" as const;
  readonly units_ = new Map<string, Unit>();
  /** Every run to completion, in order. */
  readonly onceRuns: OnceSpec[] = [];
  /** What a start does, per unit (default: listen on its own ports). */
  behave: (spec: UnitSpec) => Behaviour = () => ({});
  /** A run to completion's result (default: exit 0). */
  once: (spec: OnceSpec) => Partial<RunOnceResult> | Promise<Partial<RunOnceResult>> = () => ({ code: 0 });
  /** What a signal does (default: nothing beyond its log line). */
  onSignal: (unit: string, sig: string) => void = () => undefined;
  private nextPid = FAKE_PID_BASE;
  constructor(private readonly host: FakeHost) {}

  async available() {
    return { ok: true, detail: "a fake host in memory" };
  }
  async start(spec: UnitSpec) {
    const old = this.units_.get(spec.unit);
    if (old?.pid) return;
    const b = this.behave(spec);
    const pid = ++this.nextPid;
    const u: Unit = { spec, pid, logs: [...(old?.logs ?? []), ...(b.logs ?? [])], late: [], signals: [] };
    this.units_.set(spec.unit, u);
    if (b.exit !== undefined) {
      u.pid = null;
      u.exit = b.exit;
      return;
    }
    for (const port of b.ports ?? ownPorts(spec)) this.host.listen(port, pid, spec.cwd);
    u.late = (b.late ?? []).map((l) => ({ port: l.port, at: this.host.clock.now() + l.ms }));
  }
  /** Open the late ports that are due. */
  tick() {
    for (const u of this.units_.values()) {
      if (!u.pid) continue;
      for (const l of u.late.filter((x) => x.at <= this.host.clock.now())) if (!this.host.listeners.has(l.port)) this.host.listen(l.port, u.pid, u.spec.cwd);
      u.late = u.late.filter((x) => x.at > this.host.clock.now());
    }
  }
  /** The unit's process ends on its own (a crash) with `code`; its ports close. */
  crash(unit: string, code = 1) {
    const u = this.units_.get(unit);
    if (!u?.pid) return;
    this.host.closeAll(u.pid);
    u.pid = null;
    u.exit = code;
  }
  async stop(unit: string) {
    const u = this.units_.get(unit);
    if (u?.pid) this.host.closeAll(u.pid);
    this.units_.delete(unit);
  }
  async status(unit: string): Promise<UnitStatus> {
    const u = this.units_.get(unit);
    if (!u) return { state: "missing", pid: null };
    if (u.pid) return { state: "active", pid: u.pid };
    return { state: u.exit === 0 ? "inactive" : "failed", pid: null, exit: u.exit ?? null, detail: `exited with ${u.exit}` };
  }
  async signal(unit: string, sig: string) {
    const u = this.units_.get(unit);
    if (!u?.pid) throw new DriverError(`${unit} is not running`);
    u.signals.push(sig);
    this.onSignal(unit, sig);
  }
  /** The signals `unit` got, in order. */
  signalsOf(unit: string): string[] {
    return this.units_.get(unit)?.signals ?? [];
  }
  /** Write a line to `unit`'s log. */
  log(unit: string, text: string) {
    this.units_.get(unit)?.logs.push(text);
  }
  owns(unit: string, pid: number) {
    return this.units_.get(unit)?.pid === pid;
  }
  pids(unit: string) {
    const pid = this.units_.get(unit)?.pid;
    return pid ? [pid] : [];
  }
  async logs(unit: string, lines: number) {
    return (this.units_.get(unit)?.logs ?? []).slice(-lines).map((text) => ({ t: new Date(this.host.clock.now()).toISOString(), text }));
  }
  async runOnce(spec: OnceSpec): Promise<RunOnceResult> {
    this.onceRuns.push(spec);
    const r = await this.once(spec);
    return { code: 0, timedOut: false, ms: 0, ...r };
  }
  async units(prefix: string) {
    return [...this.units_.keys()].filter((u) => u.startsWith(prefix));
  }
  /** The running units, by name. */
  running(): string[] {
    return [...this.units_.entries()].filter(([, u]) => u.pid).map(([n]) => n);
  }
}

/** A host in memory: its listeners, a driver over them, a clock. */
export class FakeHost {
  /** Port → its listener. */
  readonly listeners = new Map<number, { pid: number; cwd: string }>();
  readonly clock: FakeClock = new FakeClock(() => this.driver.tick());
  readonly driver: FakeDriver = new FakeDriver(this);
  /** Every probe asked, in order (`tcp :<port>` or `http :<port><path>`). */
  readonly probes: string[] = [];
  /** An HTTP readiness path's answer once the port listens (default: ok). */
  httpOk: (port: number, path: string) => boolean = () => true;
  readonly readiness: Readiness = {
    tcp: async (port) => {
      this.probes.push(`tcp :${port}`);
      return this.listeners.has(port);
    },
    http: async (port, path) => {
      this.probes.push(`http :${port}${path}`);
      return this.listeners.has(port) && this.httpOk(port, path);
    },
  };
  readonly portOwner = (port: number): PortOwner => this.listeners.get(port) ?? "none";

  listen(port: number, pid: number, cwd = "/") {
    this.listeners.set(port, { pid, cwd });
  }
  close(port: number) {
    this.listeners.delete(port);
  }
  closeAll(pid: number) {
    for (const [port, l] of this.listeners) if (l.pid === pid) this.listeners.delete(port);
  }
  /** The engine's deps on this host: no real process, port or container; `more` overrides any. */
  deps(more: Partial<EngineDeps> = {}): EngineDeps {
    return {
      driver: this.driver,
      portOwner: this.portOwner,
      readiness: this.readiness,
      clock: this.clock,
      pollMs: 100,
      containerExec: async () => 0,
      containerQuery: async () => ({ code: 1, stdout: "" }),
      selfCheckout: () => null,
      hostBusy: () => null,
      projectIdOf: async () => null,
      sovaPorts: async () => new Set<number>(),
      adoptedStatus: async () => ({ state: "missing", pid: null, startedAt: null, rssBytes: null }),
      scheduleRestart: async () => null,
      ...more,
    };
  }
}
