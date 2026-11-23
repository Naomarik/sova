import { HOUR_MS, RESTART_BURST, RESTART_SEC, STABLE_RUN_SEC, startLimitIntervalSec, type Exec, type RestartFacts } from "./drivers";

/**
 * Tests only: a systemd user manager in memory on a clock the test steps. Each unit is a transient service with
 * `Restart=on-failure`: a run that ends fails (exit 3) and is started again RestartSec later, unless its start
 * limit (StartLimitBurst starts within StartLimitIntervalSec, systemd's ratelimit) refuses that start
 * (start-limit-hit). NRestarts counts each restart systemd enqueues, the refused one included, as systemd does.
 */

export interface SimLimits {
  restartMs?: number;
  burst?: number;
  intervalMs?: number;
}

type Phase = "running" | "waiting" | "failed";

export class SimUnit {
  readonly runs: { start: number; end: number | null }[] = [];
  restarts = 0;
  phase: Phase = "running";
  limitHit = false;
  readonly log: { t: number; text: string }[] = [];
  private nextStart = 0;
  private rl = { begin: Number.NEGATIVE_INFINITY, num: 0 };
  readonly restartMs: number;
  readonly burst: number;
  readonly intervalMs: number;
  /** `lengthOf(n)`: how long the n-th run (from 0) stays up before it fails; null: it never does. */
  constructor(
    at: number,
    private lengthOf: (n: number) => number | null,
    limits: SimLimits = {},
  ) {
    this.restartMs = limits.restartMs ?? RESTART_SEC * 1000;
    this.burst = limits.burst ?? RESTART_BURST;
    this.intervalMs = limits.intervalMs ?? startLimitIntervalSec() * 1000;
    this.begin(at);
  }
  private allowed(t: number): boolean {
    if (t - this.rl.begin > this.intervalMs) this.rl = { begin: t, num: 0 };
    if (this.rl.num >= this.burst) return false;
    this.rl.num++;
    return true;
  }
  private begin(t: number) {
    this.allowed(t);
    const len = this.lengthOf(this.runs.length);
    this.runs.push({ start: t, end: len === null ? null : t + len });
    this.log.push({ t, text: `run ${this.runs.length} up` });
    this.phase = "running";
  }
  /** From now on each run (the current one too, counted from now) stays up `ms`, or forever (null). */
  behave(now: number, lengthOf: (n: number) => number | null, current: number | null = lengthOf(this.runs.length - 1)) {
    this.advance(now);
    this.lengthOf = lengthOf;
    const r = this.runs.at(-1)!;
    if (this.phase === "running") r.end = current === null ? null : now + current;
  }
  advance(now: number): void {
    for (;;) {
      const r = this.runs.at(-1)!;
      if (this.phase === "running" && r.end !== null && r.end <= now) {
        this.log.push({ t: r.end, text: `run ${this.runs.length} failed: boom` });
        this.phase = "waiting";
        this.nextStart = r.end + this.restartMs;
      } else if (this.phase === "waiting" && this.nextStart <= now) {
        this.restarts++;
        if (!this.allowed(this.nextStart)) {
          this.phase = "failed";
          this.limitHit = true;
          return;
        }
        this.rl.num--; // begin() counts the start itself
        this.begin(this.nextStart);
      } else return;
    }
  }
  facts(now: number): RestartFacts {
    this.advance(now);
    const last = this.runs.at(-1)!;
    const prev = this.runs.at(-2);
    const exitAt = this.phase === "running" ? (prev?.end ?? null) : last.end;
    return { restarts: this.restarts, failing: this.phase !== "running", limitHit: this.limitHit, startAt: last.start, exitAt, exit: exitAt === null ? null : 3, burst: this.burst };
  }
  /** The failed runs by now: when each ended and how long it ran. */
  failures(now: number): { at: number; ran: number }[] {
    this.advance(now);
    return this.runs.filter((r) => r.end !== null && r.end <= now).map((r) => ({ at: r.end!, ran: r.end! - r.start }));
  }
}

/** The restart limit as the spec words it, from every failure's own facts (those from `since` on): the reference a counter must match. */
export function referenceCount(u: SimUnit, now: number, since = Number.NEGATIVE_INFINITY): { inRow: number; recent: number; rule: "in-a-row" | "in-an-hour" | "system-limit" | null } {
  let inRow = 0;
  const fails = u.failures(now).filter((f) => f.at >= since);
  for (const f of fails) inRow = (f.ran >= STABLE_RUN_SEC * 1000 ? 0 : inRow) + 1;
  const last = u.runs.at(-1)!;
  if (u.phase === "running" && now - last.start >= STABLE_RUN_SEC * 1000) inRow = 0;
  const recent = fails.filter((f) => now - f.at < HOUR_MS).length;
  const rule = u.limitHit ? "system-limit" : inRow >= RESTART_BURST ? "in-a-row" : recent >= 10 ? "in-an-hour" : null;
  return { inRow, recent, rule };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** A time as `systemctl show --timestamp=us+utc` writes it. */
export function usUtc(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(Math.floor(ms));
  const iso = d.toISOString();
  const us = String(Math.round((ms - Math.floor(ms / 1000) * 1000) * 1000)).padStart(6, "0");
  return `${DAYS[d.getUTCDay()]} ${iso.slice(0, 10)} ${iso.slice(11, 19)}.${us} UTC`;
}

/**
 * systemctl, systemd-run and journalctl over SimUnits, as the SystemdDriver calls them (`exec`). `lengthOf`
 * decides what a unit `systemd-run` starts does; `calls` keeps every call.
 */
export class FakeSystemd {
  readonly units = new Map<string, SimUnit>();
  readonly calls: string[][] = [];
  lengthOf: (unit: string) => (n: number) => number | null = () => () => null;
  constructor(private readonly now: () => number) {}
  /** Load a unit as if started outside this test's engine (an older Sova, another state root). */
  load(unit: string, u: SimUnit) {
    this.units.set(unit, u);
  }
  private block(name: string): string {
    const u = this.units.get(name);
    if (!u) return `Id=${name}.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nNRestarts=0\n`;
    const f = u.facts(this.now());
    const [active, sub, result] = u.phase === "running" ? ["active", "running", "success"] : u.phase === "waiting" ? ["activating", "auto-restart", "exit-code"] : ["failed", "failed", "start-limit-hit"];
    return [
      `Id=${name}.service`,
      "LoadState=loaded",
      `ActiveState=${active}`,
      `SubState=${sub}`,
      `MainPID=${u.phase === "running" ? 5_100_000 + u.runs.length : 0}`,
      `ExecMainStatus=${f.exit ?? 0}`,
      `ExecMainCode=${f.exitAt === null ? 0 : 1}`,
      `Result=${result}`,
      `NRestarts=${u.restarts}`,
      `ExecMainStartTimestamp=${usUtc(f.startAt)}`,
      `ExecMainExitTimestamp=${usUtc(f.exitAt)}`,
      `StartLimitBurst=${u.burst}`,
      "",
    ].join("\n");
  }
  readonly exec: Exec = async (file, args) => {
    this.calls.push([file, ...args]);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const names = args.filter((a) => a.endsWith(".service")).map((a) => a.slice(0, -".service".length));
    if (file === "systemd-run") {
      const name = args.find((a) => a.startsWith("--unit="))!.slice("--unit=".length);
      if (this.units.has(name)) return { code: 1, stdout: "", stderr: `Unit ${name}.service was already loaded or has a fragment file.` };
      const prop = (k: string) => args.find((a) => a.startsWith(`--property=${k}=`))?.split("=")[2];
      this.units.set(name, new SimUnit(this.now(), this.lengthOf(name), { restartMs: Number(prop("RestartSec") ?? RESTART_SEC) * 1000, burst: Number(prop("StartLimitBurst") ?? RESTART_BURST), intervalMs: Number(prop("StartLimitIntervalSec") ?? startLimitIntervalSec()) * 1000 }));
      return ok();
    }
    if (file === "journalctl") {
      const u = this.units.get(args[args.indexOf("-u") + 1]!.replace(/\.service$/, ""));
      const n = Number(args[args.indexOf("-n") + 1]);
      u?.advance(this.now());
      return ok((u?.log ?? []).slice(-n).map((l) => JSON.stringify({ __REALTIME_TIMESTAMP: String(Math.round(l.t * 1000)), MESSAGE: l.text })).join("\n"));
    }
    if (file !== "systemctl") return { code: 127, stdout: "", stderr: `no ${file}` };
    const verb = args[1];
    if (verb === "show") return names.length ? ok(names.map((n) => this.block(n)).join("\n")) : ok("Version=260\n");
    if (verb === "stop") {
      for (const n of names) this.units.delete(n);
      return ok();
    }
    if (verb === "reset-failed") {
      for (const n of names) if (this.units.get(n)?.phase === "failed") this.units.delete(n);
      return ok();
    }
    if (verb === "list-units") {
      const prefix = args.at(-1)!.replace(/\*$/, "");
      return ok([...this.units.keys()].filter((n) => n.startsWith(prefix)).map((n) => `${n}.service loaded active running ${n}`).join("\n"));
    }
    return ok();
  };
}
