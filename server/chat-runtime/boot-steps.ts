// A chat process's start-up trail (§app.chat-processes/boot-log): the step it is in, while it starts
// (launch → its hello says ready) and while it opens its chat (`open` → `opened`). Pure: the clock,
// the processor time, the beat timer and /proc are injected, so a test drives every line.
//
// Lines go to the chat's own log (its unit's journal), which the supervisor reads back on a death. None
// may read as an exit to it: announcedExit's `[chat-runtime] exit <cause> (pid <n>)` and exitOfLog's
// systemd lines (server/chat-runtime/supervisor.ts). Step and program names are Sova's own words or
// cut to [\w.+-], so no line can.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FrameOf } from "../../shared/chat-runtime-wire";

export type BootPhase = FrameOf<"boot">["phase"];

/** What a trail reads of the world: wall time and this process's processor time, both in ms. */
export interface BootClock {
  now(): number;
  cpuMs(): number;
}

export const realClock: BootClock = {
  now: () => Date.now(),
  cpuMs: () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
  },
};

/** A repeating timer, unref'd: the beat never keeps a process alive. */
export type Every = (ms: number, fn: () => void) => () => void;
const realEvery: Every = (ms, fn) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

/** How often a phase that lasts says where it is. */
export const BEAT_MS = 10_000;

export interface BootTrailOptions {
  phase: BootPhase;
  /** When the phase began (the process's start, for `starting`), on the clock's scale. */
  since: number;
  log: (line: string) => void;
  /** Each step as it is entered and at each beat, for the server (dropped when no server is linked). */
  send?: (frame: FrameOf<"boot">) => void;
  clock?: BootClock;
  every?: Every;
  beatMs?: number;
}

const s = (ms: number, digits = 1) => `${(Math.max(0, ms) / 1000).toFixed(digits)} s`;

/** One phase's trail: `step` as each step begins, `finish` when it is over. */
export class BootTrail {
  readonly phase: BootPhase;
  private readonly since: number;
  private readonly cpuAt: number;
  private readonly clock: BootClock;
  private readonly o: BootTrailOptions;
  /** Each step's name and when it began, in order. */
  private readonly steps: { name: string; at: number }[] = [];
  private stopBeat: (() => void) | null;
  private over = false;

  constructor(o: BootTrailOptions) {
    this.o = o;
    this.phase = o.phase;
    this.since = o.since;
    this.clock = o.clock ?? realClock;
    // A start's processor time is the process's own from its launch; an open's, its own share.
    this.cpuAt = o.phase === "starting" ? 0 : this.clock.cpuMs();
    this.stopBeat = (o.every ?? realEvery)(o.beatMs ?? BEAT_MS, () => this.beat());
  }

  get done(): boolean {
    return this.over;
  }

  /** Enter step `name` (after the phase is over: nothing). */
  step = (name: string): void => {
    if (this.over) return;
    const last = this.steps.at(-1);
    if (last?.name === name) return;
    this.steps.push({ name, at: this.clock.now() });
    this.report();
  };

  /** The step it is in, how long it has been there and how long the phase has lasted; null before the first. */
  current(): FrameOf<"boot"> | null {
    const last = this.steps.at(-1);
    if (!last) return null;
    const now = this.clock.now();
    return { t: "boot", phase: this.phase, step: last.name, stepMs: Math.max(0, now - last.at), totalMs: Math.max(0, now - this.since) };
  }

  /** Send where it is now (a server that just took control hears it at once). */
  report(): void {
    const f = this.current();
    if (f && !this.over) this.o.send?.(f);
  }

  /** The phase is over: one summary line when it succeeded, and no beat from now on. */
  finish(ok = true): void {
    if (this.over) return;
    this.over = true;
    this.stopBeat?.();
    this.stopBeat = null;
    if (ok) this.o.log(this.summary());
  }

  /** `ready in 1.42 s (chat code 0.61 s, …, other 0.05 s; cpu 1.1 s)`; `opened in …` for an open. */
  summary(): string {
    const now = this.clock.now();
    const per = new Map<string, number>();
    const other = this.steps.length ? this.steps[0]!.at - this.since : now - this.since;
    this.steps.forEach((st, i) => {
      const end = this.steps[i + 1]?.at ?? now;
      per.set(st.name, (per.get(st.name) ?? 0) + (end - st.at));
    });
    const parts = [...per].map(([name, ms]) => `${name} ${s(ms, 2)}`);
    // Time before the first step, when it shows at this precision.
    if (other >= 5) parts.push(`other ${s(other, 2)}`);
    return `[chat-runtime] ${this.phase === "starting" ? "ready" : "opened"} in ${s(now - this.since, 2)} (${parts.join(", ")}; cpu ${this.cpu()})`;
  }

  /** `<step> for 38.9 s (40.3 s since start, cpu 0.8 s)`. */
  stuckText(): string {
    const f = this.current();
    const where = f ? `${f.step} for ${s(f.stepMs)}` : "no step yet";
    return `${where} (${s(this.clock.now() - this.since)} since ${this.phase === "starting" ? "start" : "open"}, cpu ${this.cpu()})`;
  }

  private cpu(): string {
    return s(this.clock.cpuMs() - this.cpuAt);
  }

  private beat(): void {
    if (this.over) return;
    this.o.log(`[chat-runtime] still ${this.phase}: ${this.stuckText()}`);
    this.report();
  }
}

/** One child program of this process: its name (no arguments), pid and how long it has run. */
export interface ChildProgram {
  pid: number;
  name: string;
  upMs: number | null;
}

/** Ticks per second of /proc's start times: USER_HZ, 100 on every Linux Sova runs on. */
const USER_HZ = 100;
const MAX_CHILDREN = 8;

/**
 * The programs this process started and that haven't been seen to end (Linux, best-effort, cheap: a
 * few small /proc reads). Never throws; anything unreadable is left out. Elsewhere: null.
 */
export function childPrograms(o: { root?: string; pid?: number | "self"; platform?: string } = {}): ChildProgram[] | null {
  if ((o.platform ?? process.platform) !== "linux") return null;
  const root = o.root ?? "/proc";
  const self = join(root, String(o.pid ?? "self"));
  const read = (p: string): string | null => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  const pids = new Set<number>();
  let tasks: string[] = [];
  try {
    tasks = readdirSync(join(self, "task"));
  } catch {
    return [];
  }
  for (const t of tasks) for (const p of (read(join(self, "task", t, "children")) ?? "").split(/\s+/)) if (/^\d+$/.test(p)) pids.add(Number(p));
  const uptime = Number((read(join(root, "uptime")) ?? "").split(/\s+/)[0]);
  const out: ChildProgram[] = [];
  for (const pid of [...pids].sort((x, y) => x - y).slice(0, MAX_CHILDREN)) {
    const argv0 = (read(join(root, String(pid), "cmdline")) ?? "").split("\0")[0] ?? "";
    let name = basename(argv0);
    if (!name) {
      // A program that set no command line (a kernel-side name only): its comm.
      name = (read(join(root, String(pid), "comm")) ?? "").trim();
    }
    name = name.replace(/[^\w.+-]/g, "_").slice(0, 60) || "?";
    // stat: "pid (comm) state ..."; comm may hold spaces and parens, so fields count from the last ")".
    const stat = read(join(root, String(pid), "stat")) ?? "";
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(fields[19]); // field 22 overall
    const upMs = Number.isFinite(uptime) && Number.isFinite(startTicks) && stat ? Math.max(0, Math.round((uptime - startTicks / USER_HZ) * 1000)) : null;
    out.push({ pid, name, upMs });
  }
  return out;
}

/** `; child programs: claude pid 123 up 39 s, git pid 130 up 2 s` (each at most 120 characters); "" off Linux. */
export function childProgramsText(children: ChildProgram[] | null): string {
  if (children === null) return "";
  if (!children.length) return "; no child programs";
  return `; child programs: ${children.map((c) => `${c.name} pid ${c.pid}${c.upMs === null ? "" : ` up ${Math.round(c.upMs / 1000)} s`}`.slice(0, 120)).join(", ")}`;
}

/** The line a stop in the middle of a phase leaves: the step, and what the process was waiting on. */
export function stoppedText(signal: string, trail: BootTrail, children: ChildProgram[] | null): string {
  return `[chat-runtime] ${signal} while ${trail.phase}: stuck in ${trail.stuckText()}${childProgramsText(children)}`;
}
