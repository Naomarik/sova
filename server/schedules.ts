import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { playbookTurnText } from "../shared/playbooks";
import { keyOf, type ListedProfile } from "../shared/profiles";
import type { PlaybookCatalog, PlaybookInfo, PlaybookSchedule, ScheduleFire, ScheduleInfo, SessionSummary } from "../shared/protocol";
import {
  DEFAULT_TASK,
  LIMIT_RESET,
  LIMIT_RESET_INSTRUCTION,
  MAX_FIRES_PER_DAY,
  MERGE_READY,
  mergeReadyReason,
  dayKey,
  fireHead,
  hostZone,
  lateText,
  nextFire,
  pinSource,
  scheduleOf,
  scheduleText,
  wakeInstruction,
  type ReadyBranch,
  type ScheduleHeader,
} from "../shared/schedules";
import type { BoardRow } from "./merge-board";
import { singletonHolder } from "./session-profile";
import { stateRoot } from "./state-root";

/**
 * Playbook schedules (§chat/schedules): the one keeper that fires them, the store of what the user
 * approved, and each schedule's state for the Playbooks dialog and the Overseer's permits panel.
 *
 * A schedule is a project playbook's `when:` line (shared/schedules.ts parses it). The keeper ticks
 * every 30 s, re-reads each approved schedule's header, and fires what is due: a wake of the
 * profile's live One at a time session, or a new session, with a `[schedule sN]` message. It also
 * watches this host's Claude logins, and on a limit's reset continues the schedule's sessions that
 * stopped at it (§chat.schedules/limit-reset), and wakes it when a branch in its project turns
 * ready to merge on Sova's merge board (§chat.schedules/merge-ready). Nothing fires unapproved, and an approval is pinned
 * to the `when:` and `tz:` lines and the linked profile's identity and powers.
 *
 * Everything that touches sessions, profiles, logins or the clock is injected (`KeeperDeps`), so the
 * rules are testable; server/index.ts wires the real ones.
 */

export const MAX_APPROVED = 20;
export const UNOPENED_PAUSE = 10;
export const MAX_LATE_MS = 3600_000;
export const DEFAULT_TICK_MS = 30_000;
export const PAUSED_UNOPENED = `Paused after ${UNOPENED_PAUSE} runs nobody opened.`;
export const CHANGED = "Changed since you approved it";
/** A branch fires again no sooner than this after it last fired (§chat.schedules/merge-ready). */
export const MERGE_READY_QUIET_MS = 30 * 60_000;
/** A branch remembered this long after it was last seen ready, then forgotten. */
const MERGE_READY_FORGET_MS = 7 * 24 * 3600_000;
/** How many fires each schedule keeps (the panel shows the last few; the pause counts back 10). */
const KEEP_FIRES = 30;

export interface StoredFire {
  /** The keeper's clock. */
  at: number;
  /** The real clock, for "opened since" (the seen store is real time). */
  real: number;
  trigger: string;
  kind: ScheduleFire["kind"];
  sessionId?: string;
  path?: string;
}

export interface StoredSchedule {
  id: string;
  root: string;
  playbook: string;
  approved?: { pin: string; at: number };
  /** Only the automatic pause is stored; every other pause is read from the files each time. */
  paused?: { reason: string; at: number };
  next?: { at: number; trigger: string };
  fires: StoredFire[];
  day?: { key: string; n: number };
  /** merge-ready: each worktree path that fired, with its branch, when (keeper clock), and `out`
      once it was seen not ready since (§chat.schedules/merge-ready). */
  ready?: Record<string, { branch: string; at: number; out?: true }>;
}

export type LoginState = "ready" | "limited" | "auth";
export interface LoginSeen {
  state: LoginState;
  name?: string;
  /** Limited: when the limit began, and when it ends. */
  since?: number;
  until?: number;
}

export interface ScheduleStore {
  version: 1;
  seq: number;
  schedules: StoredSchedule[];
  logins: Record<string, LoginSeen>;
}

export const schedulesFile = () => join(stateRoot(), "schedules.json");
export const scheduleRunsFile = () => join(stateRoot(), "schedule-runs.jsonl");

export function readStore(file: string): ScheduleStore {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ScheduleStore>;
    if (raw?.version !== 1 || !Array.isArray(raw.schedules)) throw new Error("not a store");
    return {
      version: 1,
      seq: typeof raw.seq === "number" ? raw.seq : 0,
      schedules: raw.schedules.filter((s) => s && typeof s.id === "string" && typeof s.root === "string" && typeof s.playbook === "string").map((s) => ({ ...s, fires: Array.isArray(s.fires) ? s.fires : [] })),
      logins: raw.logins && typeof raw.logins === "object" ? raw.logins : {},
    };
  } catch {
    return { version: 1, seq: 0, schedules: [], logins: {} };
  }
}

function writeStore(file: string, store: ScheduleStore): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The pin an approval records: a hash of what it covers (§chat.schedules/approval). */
export function pinOf(header: Pick<ScheduleHeader, "tz"> & { triggers: NonNullable<ScheduleHeader["triggers"]> }, profile: ListedProfile): string {
  const src = pinSource(header, { key: profile.key, remove: profile.remove, grant: profile.grant, singleton: profile.singleton, overseerMayStart: profile.overseerMayStart });
  return createHash("sha256").update(src).digest("hex").slice(0, 16);
}

/** One login as the keeper sees it at a tick. */
export interface LoginNow {
  id: string;
  name: string;
  state: LoginState;
  since?: number;
  until?: number;
}

export type SendResult = { ok: true } | { ok: false; error: string };

export interface KeeperDeps {
  file: string;
  logFile: string;
  /** The keeper's clock (sped up under SOVA_SCHEDULE_SPEED for tests). */
  now(): number;
  /** The real clock (the seen store, login standings). */
  realNow(): number;
  /** A fire this much late or more says so ("Late by"); on time otherwise. */
  lateAfterMs: number;
  readPlaybook(root: string, id: string): Promise<{ info: PlaybookInfo; fields: Record<string, string> } | null>;
  findProfile(id: string, root: string): Promise<ListedProfile | null>;
  sessions(): Promise<SessionSummary[]>;
  /** The session runs a turn or holds a queued message. */
  busy(path: string): boolean;
  /** Free slots of the running-at-once cap. */
  freeSlots(): number;
  /** Count a session this keeper started or woke toward that cap. */
  started(path: string): void;
  wake(path: string, text: string): Promise<SendResult>;
  create(root: string, profile: { source: ListedProfile["source"]; id: string }, text: string, title: string): Promise<{ ok: true; id: string; path: string } | { ok: false; error: string }>;
  /** When the user last looked at a session (real ms; 0 = never). */
  seenAt(sessionId: string): number;
  logins(): LoginNow[];
  /** A login's name when it is no longer listed (its standing was cleared). */
  loginName?(id: string): string;
  /** The session's branch ends in a failed turn: when, and the Claude login it ran on (recorded). */
  lastTurn(path: string): Promise<{ failed: boolean; at: number; login?: string } | null>;
  /** Sova's merge board (§chat.worktrees/merge-board): `pending` sessions not read yet, and the
      rows in a project. Absent: merge-ready never fires. */
  board?(): Promise<{ pending: number; rowsIn(root: string): BoardRow[] } | null>;
  /** Tell the Overseer (under Brief Me only). */
  brief?(text: string): void;
  zone?(): string;
}

/** What a schedule is now, read from its files and the store. */
interface Evaluated {
  pb: { info: PlaybookInfo; fields: Record<string, string> } | null;
  header: ScheduleHeader | null;
  profile: ListedProfile | null;
  pin?: string;
  view: PlaybookSchedule;
}

const iso = (t: number) => new Date(t).toISOString();

export class ScheduleKeeper {
  private chain: Promise<unknown> = Promise.resolve();
  /** An active merge-ready schedule was seen (the first tick reads the board to find out). */
  private wantsBoard = true;
  constructor(readonly deps: KeeperDeps) {}

  /** Every store change runs here, one at a time: a tick's awaits never interleave with an approve. */
  private locked<T>(fn: (store: ScheduleStore) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const store = readStore(this.deps.file);
      const out = await fn(store);
      writeStore(this.deps.file, store);
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private log(s: Pick<StoredSchedule, "id" | "root" | "playbook">, trigger: string, outcome: string, extra: { why?: string; session?: string } = {}): void {
    try {
      mkdirSync(dirname(this.deps.logFile), { recursive: true });
      appendFileSync(this.deps.logFile, `${JSON.stringify({ at: iso(this.deps.realNow()), id: s.id, playbook: s.playbook, root: s.root, trigger, outcome, ...extra })}\n`);
    } catch (err) {
      console.warn("[schedules] log not written:", err instanceof Error ? err.message : String(err));
    }
  }

  private zone(h: ScheduleHeader | null): string {
    return h?.tz ?? (this.deps.zone ?? hostZone)();
  }

  /** The schedule's state now (§chat.schedules/approval): its files first, then what the store holds. */
  private async evaluate(s: Pick<StoredSchedule, "root" | "playbook"> & Partial<StoredSchedule>): Promise<Evaluated> {
    const pb = await this.deps.readPlaybook(s.root, s.playbook);
    const header = pb ? scheduleOf(pb.fields) : null;
    const out: Evaluated = { pb, header, profile: null, view: { when: header?.when ?? "", state: "invalid" } };
    if (!pb || !header) {
      out.view.reason = !pb ? `The playbook ${s.playbook} is gone from ${basename(s.root)}.` : "The playbook no longer has a when: line.";
      if (s.approved) out.view.state = "paused";
      return out;
    }
    Object.assign(out.view, header.profile ? { profile: header.profile } : {}, header.tz ? { tz: header.tz } : {});
    if (header.error || !header.triggers) {
      out.view.reason = header.error;
      return out;
    }
    out.view.text = scheduleText(header.triggers);
    const profile = await this.deps.findProfile(header.profile!, s.root);
    if (!profile) {
      out.view.reason = `No profile "${header.profile}" for ${basename(s.root)}.`;
      if (s.approved) out.view.state = "paused";
      return out;
    }
    out.profile = profile;
    out.view.profileLabel = profile.label;
    out.pin = pinOf({ tz: header.tz, triggers: header.triggers }, profile);
    out.view.pin = out.pin;
    const profileNeeds = profile.approval === "needed" ? `Its profile ${profile.label} needs your approval first (Settings → Profiles).` : undefined;
    if (!s.approved) {
      out.view.state = "needs-approval";
      if (profileNeeds) out.view.reason = profileNeeds;
      return out;
    }
    out.view.state = "paused";
    if (s.approved.pin !== out.pin) out.view.reason = CHANGED;
    else if (profileNeeds) out.view.reason = profileNeeds;
    else if (s.paused) out.view.reason = s.paused.reason;
    else {
      out.view.state = "active";
      if (s.next) out.view.next = iso(s.next.at);
    }
    return out;
  }

  private register(store: ScheduleStore, root: string, playbook: string): { s: StoredSchedule; fresh: boolean } {
    const found = store.schedules.find((x) => x.root === root && x.playbook === playbook);
    if (found) return { s: found, fresh: false };
    const s: StoredSchedule = { id: `s${++store.seq}`, root, playbook, fires: [] };
    store.schedules.push(s);
    this.log(s, "", "found");
    return { s, fresh: true };
  }

  private info(s: StoredSchedule, ev: Evaluated): ScheduleInfo {
    return {
      ...ev.view,
      id: s.id,
      root: s.root,
      projectName: basename(s.root),
      playbook: s.playbook,
      title: ev.pb?.info.title ?? s.playbook,
      fires: s.fires.slice(-5).map((f) => ({ at: iso(f.at), trigger: f.trigger, kind: f.kind, ...(f.sessionId ? { sessionId: f.sessionId } : {}) })),
    };
  }

  /** Every schedule Sova knows of, with its state (the permits panel, GET /api/schedules). */
  list(): Promise<ScheduleInfo[]> {
    return this.locked(async (store) => {
      const out: ScheduleInfo[] = [];
      for (const s of store.schedules) out.push(this.info(s, await this.evaluate(s)));
      return out;
    });
  }

  /**
   * The Playbooks catalog with each project schedule's state, registering the ones Sova hadn't seen
   * (they read Needs approval). `root`: the catalog's project.
   */
  decorate(catalog: PlaybookCatalog, root: string | null): Promise<PlaybookCatalog> {
    const scheduled = catalog.playbooks.filter((p) => p.source === "project" && p.schedule && p.schedule.state !== "not-project");
    if (!root || !scheduled.length) return Promise.resolve(catalog);
    return this.locked(async (store) => {
      for (const p of scheduled) {
        const { s, fresh } = this.register(store, root, p.id);
        if (fresh) this.announce(s, p);
        const ev = await this.evaluate(s);
        p.schedule = { ...ev.view, id: s.id };
      }
      return catalog;
    });
  }

  private announce(s: StoredSchedule, p: PlaybookInfo): void {
    if (p.schedule?.state === "invalid") return;
    this.deps.brief?.(`The playbook ${p.title} in ${basename(s.root)} wants to run on a schedule (${p.schedule?.text ?? p.schedule?.when}). It fires only once the user approves it in the Playbooks dialog or on your permits chip.`);
  }

  /**
   * Find schedules in the projects of `roots` (the keeper's discovery): new ones read Needs approval;
   * an unapproved one whose playbook no longer declares a schedule is forgotten.
   */
  discover(roots: readonly string[], list: (root: string) => Promise<PlaybookInfo[]>): Promise<void> {
    return this.locked(async (store) => {
      for (const root of new Set(roots)) {
        const pbs = await list(root).catch(() => [] as PlaybookInfo[]);
        for (const p of pbs) {
          if (!p.schedule || p.schedule.state === "not-project") continue;
          const { s, fresh } = this.register(store, root, p.id);
          if (fresh) this.announce(s, p);
        }
      }
      const keep: StoredSchedule[] = [];
      for (const s of store.schedules) {
        if (!s.approved && roots.includes(s.root) && !(await this.deps.readPlaybook(s.root, s.playbook).then((pb) => pb && scheduleOf(pb.fields)))) continue;
        keep.push(s);
      }
      store.schedules = keep;
    });
  }

  /** POST /api/schedules/approve: the user's click, for exactly the pin they were shown. */
  approve(root: string, playbook: string, pin: string): Promise<{ ok: true; schedule: ScheduleInfo } | { ok: false; status: 404 | 409; error: string }> {
    return this.locked(async (store) => {
      const existing = store.schedules.find((x) => x.root === root && x.playbook === playbook);
      const ev = await this.evaluate(existing ?? { root, playbook });
      if (!ev.pb || !ev.header) return { ok: false as const, status: 404 as const, error: ev.view.reason ?? `No schedule in ${playbook}.` };
      if (!ev.pin || !ev.profile || !ev.header.triggers) return { ok: false as const, status: 409 as const, error: ev.view.reason ?? "This schedule can't be approved." };
      if (ev.pin !== pin) return { ok: false as const, status: 409 as const, error: "The schedule or its profile changed since it was shown. Look at it again, then approve." };
      if (ev.profile.approval === "needed") return { ok: false as const, status: 409 as const, error: `Its profile ${ev.profile.label} needs your approval first (Settings → Profiles).` };
      const others = store.schedules.filter((x) => x.approved && !(x.root === root && x.playbook === playbook)).length;
      if (others >= MAX_APPROVED) return { ok: false as const, status: 409 as const, error: `Sova runs at most ${MAX_APPROVED} schedules. Revoke one first.` };
      const { s } = this.register(store, root, playbook);
      const now = this.deps.now();
      s.approved = { pin, at: now };
      delete s.paused;
      s.next = nextFire(ev.header.triggers, now, this.zone(ev.header)) ?? undefined;
      if (!s.next) delete s.next;
      this.log(s, "", "approved");
      return { ok: true as const, schedule: this.info(s, await this.evaluate(s)) };
    });
  }

  /** POST /api/schedules/revoke: the approval goes at once; the file's schedule reads Needs approval. */
  revoke(id: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
    return this.locked(async (store) => {
      const s = store.schedules.find((x) => x.id === id);
      if (!s) return { ok: false as const, status: 404 as const, error: `No schedule ${id}.` };
      if (!s.approved) return { ok: false as const, status: 409 as const, error: `${id} is not approved.` };
      delete s.approved;
      delete s.paused;
      delete s.next;
      this.log(s, "", "revoked");
      return { ok: true as const };
    });
  }

  /** New sessions this schedule started that nobody opened since, counted back from its newest fire
      to its approval (approving again starts the count over). */
  unopenedRun(s: StoredSchedule): number {
    let n = 0;
    for (let i = s.fires.length - 1; i >= 0; i--) {
      const f = s.fires[i]!;
      if (s.approved && f.at < s.approved.at) break;
      if (f.kind !== "new") continue; // a wake of a running session neither counts nor breaks the run
      if (f.sessionId && this.deps.seenAt(f.sessionId) > f.real) break;
      n++;
    }
    return n;
  }

  private record(s: StoredSchedule, fire: Omit<StoredFire, "at" | "real">, tz: string): void {
    const at = this.deps.now();
    s.fires.push({ at, real: this.deps.realNow(), ...fire });
    if (s.fires.length > KEEP_FIRES) s.fires.splice(0, s.fires.length - KEEP_FIRES);
    const key = dayKey(at, tz);
    s.day = s.day?.key === key ? { key, n: s.day.n + 1 } : { key, n: 1 };
    if (fire.path) this.deps.started(fire.path);
  }

  private dayFull(s: StoredSchedule, tz: string): boolean {
    return s.day?.key === dayKey(this.deps.now(), tz) && s.day.n >= MAX_FIRES_PER_DAY;
  }

  /** One fire of an active schedule (§chat.schedules/fire): a time, or a merge-ready transition with its own reason. */
  private async fire(s: StoredSchedule, ev: Evaluated, trigger: string, lateMs: number | undefined, reason?: string): Promise<void> {
    const tz = this.zone(ev.header);
    const skip = (why: string) => this.log(s, trigger, "skipped", { why });
    if (this.dayFull(s, tz)) return skip(`it fired ${MAX_FIRES_PER_DAY} times today`);
    const last = [...s.fires].reverse().find((f) => f.path);
    if (last?.path && this.deps.busy(last.path)) return skip("the last run is still going");
    if (this.unopenedRun(s) >= UNOPENED_PAUSE) {
      s.paused = { reason: PAUSED_UNOPENED, at: this.deps.now() };
      return this.log(s, trigger, "paused", { why: PAUSED_UNOPENED });
    }
    if (this.deps.freeSlots() <= 0) return skip("the running-at-once limit was reached");
    const pb = ev.pb!.info;
    const profile = ev.profile!;
    const head = fireHead(s.id, trigger, pb.id, reason ?? ev.header!.task ?? DEFAULT_TASK, lateMs);
    if (profile.singleton) {
      const holder = singletonHolder(keyOf(profile), await this.deps.sessions());
      if (holder) {
        if (holder.live) return skip(`${profile.label} is open in a terminal`);
        const r = await this.deps.wake(holder.path, `${head}\n${wakeInstruction(pb.title, pb.dir, pb.entry)}`);
        if (!r.ok) return this.log(s, trigger, "refused", { why: r.error, session: holder.id });
        this.record(s, { trigger, kind: "wake", sessionId: holder.id, path: holder.path }, tz);
        return this.log(s, trigger, "fired", { session: holder.id });
      }
    }
    const r = await this.deps.create(s.root, { source: profile.source, id: profile.id }, `${head}\n\n${playbookTurnText(pb, "")}`, `${pb.title} (scheduled)`);
    if (!r.ok) return this.log(s, trigger, "refused", { why: r.error });
    this.record(s, { trigger, kind: "new", sessionId: r.id, path: r.path }, tz);
    this.log(s, trigger, "fired", { session: r.id });
  }

  /** The limit resets since the last tick (§chat.schedules/limit-reset), recording what each login is now. */
  private resets(store: ScheduleStore): { id: string; name: string; since: number; at: number }[] {
    const out: { id: string; name: string; since: number; at: number }[] = [];
    const real = this.deps.realNow();
    const seen = new Set<string>();
    let logins: LoginNow[];
    try {
      logins = this.deps.logins();
    } catch (err) {
      // An unreadable standing skips the reset check this tick, never the time fires.
      console.warn("[schedules] logins not read:", err instanceof Error ? err.message : String(err));
      return out;
    }
    for (const l of logins) {
      seen.add(l.id);
      const prev = store.logins[l.id];
      if (prev?.state === "limited" && l.state === "ready") out.push({ id: l.id, name: l.name, since: prev.since ?? 0, at: prev.until && prev.until <= real ? prev.until : real });
      store.logins[l.id] = { state: l.state, name: l.name, ...(l.state === "limited" && l.since ? { since: l.since } : {}), ...(l.state === "limited" && l.until ? { until: l.until } : {}) };
    }
    // A standing removed outright (the file no longer lists the login) is ready again too.
    for (const [id, prev] of Object.entries(store.logins)) {
      if (seen.has(id)) continue;
      if (prev.state === "limited") out.push({ id, name: prev.name ?? this.deps.loginName?.(id) ?? id, since: prev.since ?? 0, at: prev.until && prev.until <= real ? prev.until : real });
      delete store.logins[id];
    }
    return out;
  }

  private async continueAfterReset(store: ScheduleStore, reset: { id: string; name: string; since: number; at: number }): Promise<void> {
    const late = this.deps.realNow() - reset.at;
    const sessions = await this.deps.sessions();
    for (const s of store.schedules) {
      if (!s.approved) continue;
      const ev = await this.evaluate(s);
      if (ev.view.state !== "active" || !ev.header?.triggers?.some((t) => t.kind === "limit-reset")) continue;
      if (late >= MAX_LATE_MS) {
        this.log(s, LIMIT_RESET, "skipped", { why: `the reset of ${reset.name} was ${lateText(late)} ago, while Sova was not running` });
        continue;
      }
      const tz = this.zone(ev.header);
      // The sessions this schedule may target: those its own fires started, and its One at a time profile's live one.
      const paths = new Set(s.fires.filter((f) => f.kind === "new" && f.path).map((f) => f.path!));
      if (ev.profile?.singleton) {
        const holder = singletonHolder(keyOf(ev.profile), sessions);
        if (holder) paths.add(holder.path);
      }
      for (const path of paths) {
        const sum = sessions.find((x) => x.path === path);
        if (!sum || sum.archived || sum.live || this.deps.busy(path)) continue;
        const turn = await this.deps.lastTurn(path).catch(() => null);
        if (!turn?.failed || turn.login !== reset.id || turn.at < reset.since - 60_000) continue;
        if (this.dayFull(s, tz)) {
          this.log(s, LIMIT_RESET, "skipped", { why: `it fired ${MAX_FIRES_PER_DAY} times today`, session: sum.id });
          continue;
        }
        const head = fireHead(s.id, LIMIT_RESET, s.playbook, `Claude login ${reset.name} is ready again.`, late >= this.deps.lateAfterMs ? late : undefined);
        const r = await this.deps.wake(path, `${head}\n${LIMIT_RESET_INSTRUCTION}`);
        if (!r.ok) {
          this.log(s, LIMIT_RESET, "refused", { why: r.error, session: sum.id });
          continue;
        }
        this.record(s, { trigger: LIMIT_RESET, kind: "reset", sessionId: sum.id, path }, tz);
        this.log(s, LIMIT_RESET, "fired", { session: sum.id });
      }
    }
  }

  /**
   * merge-ready (§chat.schedules/merge-ready): fire once for the branches in the schedule's project
   * that newly read ready to merge with an idle owner. A row the board hasn't read yet (`pending`)
   * is unknown: it neither fires nor counts as having left. While the last run is still going the
   * transition waits, unlogged; any fire attempt (fired, skipped by a cap, refused) spends it.
   */
  private async mergeReady(s: StoredSchedule, ev: Evaluated, board: { pending: number; rowsIn(root: string): BoardRow[] }): Promise<void> {
    const now = this.deps.now();
    const rows = board.rowsIn(s.root);
    const seen = (s.ready ??= {});
    const readyNow = new Set<string>();
    const fresh: (ReadyBranch & { path: string })[] = [];
    for (const r of rows) {
      if ((r.state !== "ready" && r.state !== "waiting-approval") || r.owner.status !== "idle") continue;
      readyNow.add(r.path);
      const prev = seen[r.path];
      if (!prev || prev.branch !== r.branch || (prev.out && now - prev.at >= MERGE_READY_QUIET_MS)) fresh.push({ path: r.path, branch: r.branch, waiting: r.state === "waiting-approval" });
    }
    for (const [path, prev] of Object.entries(seen)) {
      if (readyNow.has(path)) continue;
      const row = rows.find((r) => r.path === path);
      if (!row && board.pending > 0) continue; // not read yet: unknown, never "left"
      if (!row && now - prev.at >= MERGE_READY_FORGET_MS) delete seen[path];
      else prev.out = true;
    }
    if (!fresh.length) return;
    const last = [...s.fires].reverse().find((f) => f.path);
    if (last?.path && this.deps.busy(last.path)) return; // waits for the run in flight
    fresh.sort((a, b) => a.branch.localeCompare(b.branch));
    for (const f of fresh) seen[f.path] = { branch: f.branch, at: now };
    await this.fire(s, ev, MERGE_READY, undefined, mergeReadyReason(fresh));
  }

  /** One tick: limit resets first, then merge-ready transitions, then every approved schedule that is due. */
  tick(): Promise<void> {
    // The board is read outside the store's lock (it may wait on readiness), and only once a
    // previous tick found an active merge-ready schedule.
    const boardP = this.wantsBoard && this.deps.board ? this.deps.board().catch(() => null) : Promise.resolve(null);
    return boardP.then((board) => this.locked(async (store) => {
      for (const reset of this.resets(store)) await this.continueAfterReset(store, reset);
      const now = this.deps.now();
      let wants = false;
      for (const s of store.schedules) {
        if (!s.approved) continue;
        const ev = await this.evaluate(s);
        if (ev.view.state !== "active" || !ev.header?.triggers?.some((t) => t.kind === "merge-ready")) continue;
        wants = true;
        if (board) await this.mergeReady(s, ev, board);
      }
      this.wantsBoard = wants;
      for (const s of store.schedules) {
        if (!s.approved) continue;
        const ev = await this.evaluate(s);
        const triggers = ev.header?.triggers;
        if (ev.view.state !== "active" || !triggers) continue;
        const tz = this.zone(ev.header);
        if (!s.next) {
          const n = nextFire(triggers, now, tz);
          if (n) s.next = n;
          continue;
        }
        if (now < s.next.at) continue;
        const due = s.next;
        const late = now - due.at;
        const n = nextFire(triggers, now, tz);
        if (n) s.next = n;
        else delete s.next;
        // Missed while Sova was down: once if under an hour late, else skipped; never caught up one by one.
        if (late >= MAX_LATE_MS) {
          this.log(s, due.trigger, "skipped", { why: `missed while Sova was not running (late by ${lateText(late)})` });
          continue;
        }
        await this.fire(s, ev, due.trigger, late >= this.deps.lateAfterMs ? late : undefined);
      }
    }));
  }
}

// ── The process's keeper ────────────────────────────────────────────────────────────────────────

let keeper: ScheduleKeeper | null = null;
export const setScheduleKeeper = (k: ScheduleKeeper | null) => {
  keeper = k;
};
export const scheduleKeeper = () => keeper;

/** Every schedule for the Overseer's permits panel; none before the keeper starts. */
export const schedulesForWire = (): Promise<ScheduleInfo[]> => keeper?.list() ?? Promise.resolve([]);
