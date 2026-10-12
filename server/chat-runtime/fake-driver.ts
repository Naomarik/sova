import type { Driver, UnitSpec, UnitStatus } from "../project-services/drivers";

/**
 * A Driver whose units are entries in a map, for unit tests of the chat supervisor and its callers:
 * nothing is started. A test flips a unit's state (`die`, `exiting`) and reads what was asked
 * (`started`, `stopped`).
 */
export class FakeDriver implements Driver {
  readonly id = "systemd" as const;
  readonly table = new Map<string, { spec: UnitSpec; status: UnitStatus; logs: string[] }>();
  started: UnitSpec[] = [];
  stopped: string[] = [];
  /** Make the next `start` throw this (a systemd-run failure). */
  failNextStart: string | null = null;
  private nextPid = 1000;
  async available() {
    return { ok: true, detail: "fake driver" };
  }
  async start(spec: UnitSpec) {
    if (this.failNextStart) {
      const msg = this.failNextStart;
      this.failNextStart = null;
      throw new Error(msg);
    }
    const old = this.table.get(spec.unit);
    if (old && (old.status.state === "active" || old.status.state === "activating")) throw new Error(`Unit ${spec.unit}.service was already loaded`);
    this.started.push(spec);
    this.table.set(spec.unit, { spec, status: { state: "active", pid: this.nextPid++ }, logs: [] });
  }
  async stop(unit: string) {
    this.stopped.push(unit);
    this.table.delete(unit);
  }
  async status(unit: string): Promise<UnitStatus> {
    return this.table.get(unit)?.status ?? { state: "missing", pid: null };
  }
  async signal() {}
  owns() {
    return false;
  }
  pids() {
    return [];
  }
  async logs(unit: string, lines: number) {
    return (this.table.get(unit)?.logs ?? []).slice(-lines).map((text) => ({ t: "", text }));
  }
  async runOnce(): Promise<never> {
    throw new Error("the fake driver runs no waited-for units");
  }
  async units(prefix: string) {
    return [...this.table.keys()].filter((u) => u.startsWith(prefix));
  }
  /** The unit's process ends: collected at once (`--collect`), its journal left behind. */
  die(unit: string, logs: string[] = []) {
    const u = this.table.get(unit);
    if (!u) return;
    u.status = { state: "missing", pid: null };
    u.logs = logs;
  }
  /** The unit is stopping (deactivating reads as active to the supervisor) until `die`. */
  exiting(unit: string) {
    const u = this.table.get(unit);
    if (u) u.status = { ...u.status, state: "active", detail: "deactivating/stop-sigterm" };
  }
}
