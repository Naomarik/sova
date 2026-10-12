import type { Driver, UnitSpec, UnitStatus } from "../project-services/drivers";

type Line = string | { t: string; text: string };

/**
 * A Driver whose units are entries in a map, for unit tests of the chat supervisor and its callers:
 * nothing is started. A test flips a unit's state (`die`, `exiting`) and reads what was asked
 * (`started`, `stopped`).
 */
export class FakeDriver implements Driver {
  readonly id = "systemd" as const;
  readonly table = new Map<string, { spec: UnitSpec; status: UnitStatus; logs: Line[] }>();
  started: UnitSpec[] = [];
  stopped: string[] = [];
  /** Make the next `start` throw this (a systemd-run failure). */
  failNextStart: string | null = null;
  /** The next started unit stays activating with no main process until `activate`. */
  slowNextStart = false;
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
    const slow = this.slowNextStart;
    this.slowNextStart = false;
    this.table.set(spec.unit, { spec, status: slow ? { state: "activating", pid: null } : { state: "active", pid: this.nextPid++ }, logs: [] });
  }
  /** A slow unit's main process is there now. */
  activate(unit: string) {
    const u = this.table.get(unit);
    if (u) u.status = { state: "active", pid: this.nextPid++ };
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
    return (this.table.get(unit)?.logs ?? []).slice(-lines).map((l) => (typeof l === "string" ? { t: "", text: l } : l));
  }
  async runOnce(): Promise<never> {
    throw new Error("the fake driver runs no waited-for units");
  }
  async units(prefix: string) {
    return [...this.table.keys()].filter((u) => u.startsWith(prefix));
  }
  /** The unit's process ends: collected at once (`--collect`), its journal left behind (a line with its time, or text alone). */
  die(unit: string, logs: Line[] = []) {
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
