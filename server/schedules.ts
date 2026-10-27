import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { permissionsOfProfile, pin2Source, type Automation } from "../shared/automations";
import { deliveryInstruction, type BundleRef, type Load } from "../shared/playbook-delivery";
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
  maxFiresPerDay,
  hostZone,
  lateText,
  nextFire,
  pinSource,
  scheduleOf,
  scheduleText,
  wakeInstruction,
  type ScheduleHeader,
  type Trigger,
} from "../shared/schedules";
import type { BoardRow } from "./merge-board";
import { singletonHolder } from "./session-profile";
import { stateRoot } from "./state-root";

/**
 * Playbook schedules (§chat/schedules): the one keeper that fires them, the store of what the user
 * approved, and each schedule's state for the Playbooks dialog and the Overseer's permits panel.
 *
 * A schedule is declared two ways: a project's automation file `.sova/automations/<id>.json`
 * (§chat.schedules/automation-file: triggers, playbook, its session's own settings and permissions),
 * or, the older way, a project playbook's `when:` line (shared/schedules.ts parses both grammars).
 * When a file names a playbook whose header also has `when:`, the file wins and the header's row is
 * carried over to it (§chat.schedules/store): same `sN`, approval, fires and next fire.
 *
 * The keeper ticks every 30 s, re-reads each approved schedule's declaration, and fires what is due:
 * a wake of the schedule's session (an automation's own pointer, or the header profile's live One at
 * a time session), or a new session, with a `[schedule sN]` message that carries the playbook itself
 * (§chat.schedules/delivery). It also watches this host's Claude logins, and on a limit's reset
 * continues the schedule's sessions that stopped at it (§chat.schedules/limit-reset), and wakes it
 * when a branch in its project turns Ready to land on Sova's merge board
 * (§chat.schedules/merge-ready). Nothing fires unapproved.
 *
 * Everything that touches sessions, profiles, files, logins or the clock is injected (`KeeperDeps`),
 * so the rules are testable; server/schedule-routes.ts wires the real ones.
 */

export const MAX_APPROVED = 20;
export const UNOPENED_PAUSE = 10;
export const MAX_LATE_MS = 3600_000;
export const DEFAULT_TICK_MS = 30_000;
export const PAUSED_UNOPENED = `Paused after ${UNOPENED_PAUSE} runs nobody opened.`;
export const CHANGED = "Changed since you approved it";
export const OTHER_DEVICE = "Runs on another device: this one fires nothing for it.";
/** A branch remembered this long after it last fired, then forgotten once it isn't Ready to land. */
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

export interface StoredApproval {
  /** What was approved: a header's pin, or (for an automation approved as one) its v2 pin. */
  pin: string;
  at: number;
  /** An automation's v2 pin, approved or carried over (§chat.schedules/store). */
  pin2?: string;
  /** A header schedule's approval in automation terms, recorded while its pin was verified equal,
      so a later automation file can carry it even once the header is gone. */
  carry2?: string;
  /** When its approval carried over to the automation file (keeper clock). */
  carried?: number;
}

export interface StoredSchedule {
  id: string;
  root: string;
  /** The playbook it runs (an automation's `playbook`; for a header, the playbook declaring it). */
  playbook: string;
  /** An automation file's id, once the row is the file's (§chat.schedules/store). */
  automation?: string;
  approved?: StoredApproval;
  /** Only the automatic pause is stored; every other pause is read from the files each time. */
  paused?: { reason: string; at: number };
  next?: { at: number; trigger: string };
  fires: StoredFire[];
  day?: { key: string; n: number };
  /** merge-ready: each worktree path that fired, with its branch, the landing commit it fired for, and
      when (keeper clock) (§chat.schedules/merge-ready). A row stored before commits were has none, so it reads fresh. */
  ready?: Record<string, { branch: string; commit: string; at: number }>;
  /** merge-ready: each worktree path woken for the user's go-ahead typed in its own chat, with the commit the
      go-ahead names (§chat.schedules/merge-ready). */
  typed?: Record<string, { branch: string; commit: string; at: number }>;
  /** merge-ready: each worktree path woken for Go on an Overseer card's Ready to land row, with the commit it
      names (§app.overseer/card-land). */
  card?: Record<string, { branch: string; commit: string; at: number }>;
  /** A long-running schedule's own session (§chat.schedules/store). */
  session?: { id: string; path: string };
  /** The device that runs it (its host id). */
  host?: string;
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
/** The one copy of the store as it was before its first automation write (§chat.schedules/store). */
export const backupFileOf = (file: string) => `${file}.bak-automations`;

/** A store that exists but can't be read as version 1: refused, never read as empty. */
export class StoreRefused extends Error {}

/** The store: missing is empty; unparseable or another version is refused (§chat.schedules/store). */
export function readStore(file: string): ScheduleStore {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, seq: 0, schedules: [], logins: {} };
    throw new StoreRefused(`${file} can't be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: Partial<ScheduleStore>;
  try {
    raw = JSON.parse(text) as Partial<ScheduleStore>;
  } catch (err) {
    throw new StoreRefused(`${file} is not JSON (${err instanceof Error ? err.message : String(err)}); nothing is read or written until it is fixed.`);
  }
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.schedules))
    throw new StoreRefused(`${file} is not a version 1 schedule store; nothing is read or written until it is fixed.`);
  return {
    version: 1,
    seq: typeof raw.seq === "number" ? raw.seq : 0,
    schedules: raw.schedules.filter((s) => s && typeof s.id === "string" && typeof s.root === "string" && typeof s.playbook === "string").map((s) => ({ ...s, fires: Array.isArray(s.fires) ? s.fires : [] })),
    logins: raw.logins && typeof raw.logins === "object" ? raw.logins : {},
  };
}

/** A store holding any of the fields the automation migration adds. */
const migrated = (store: { schedules?: unknown }): boolean =>
  Array.isArray(store.schedules) &&
  (store.schedules as StoredSchedule[]).some((s) => s && (s.automation !== undefined || s.session !== undefined || s.host !== undefined || s.approved?.pin2 !== undefined || s.approved?.carry2 !== undefined));

function writeStore(file: string, store: ScheduleStore): void {
  mkdirSync(dirname(file), { recursive: true });
  // One backup, before the first write that adds the migration's fields.
  if (migrated(store) && !existsSync(backupFileOf(file)) && existsSync(file)) {
    let before: { schedules?: unknown } | null = null;
    try {
      before = JSON.parse(readFileSync(file, "utf8")) as { schedules?: unknown };
    } catch {
      before = null;
    }
    if (before && !migrated(before)) copyFileSync(file, backupFileOf(file));
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, file);
}

const hash16 = (src: string) => createHash("sha256").update(src).digest("hex").slice(0, 16);

/** The pin an approval records: a hash of what it covers (§chat.schedules/approval). */
export function pinOf(header: Pick<ScheduleHeader, "tz"> & { triggers: NonNullable<ScheduleHeader["triggers"]> }, profile: ListedProfile): string {
  return hash16(pinSource(header, { key: profile.key, remove: profile.remove, grant: profile.grant, singleton: profile.singleton, overseerMayStart: profile.overseerMayStart }));
}

/** An automation's v2 pin: its triggers, playbook, session kind and permissions. */
export const pin2Of = (a: Pick<Automation, "triggers" | "tz" | "playbook" | "session" | "permissions">): string => hash16(pin2Source(a));

/** A header schedule's approval in automation terms (§chat.schedules/store). */
export function legacyPin2(header: { triggers: readonly Trigger[]; tz?: string }, playbook: string, profile: ListedProfile): string {
  return hash16(pin2Source({ triggers: header.triggers, tz: header.tz, playbook, session: profile.singleton ? "long-running" : "per-fire", permissions: permissionsOfProfile(profile) }));
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

/** An automation file as read: parsed, or its exact error. */
export interface AutomationRead {
  id: string;
  automation?: Automation;
  error?: string;
}

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
  /** The project's automation files, each parsed or with its error; [] without the folder. */
  automations?(root: string): Promise<AutomationRead[]>;
  sessions(): Promise<SessionSummary[]>;
  /** The session runs a turn or holds a queued message. */
  busy(path: string): boolean;
  /** Free slots of the running-at-once cap. */
  freeSlots(): number;
  /** Count a session this keeper started or woke toward that cap. */
  started(path: string): void;
  wake(path: string, text: string): Promise<SendResult>;
  create(root: string, profile: { source: ListedProfile["source"]; id: string }, text: string, title: string): Promise<{ ok: true; id: string; path: string } | { ok: false; error: string }>;
  /** A new session for an automation: its settings and permissions from the file itself. */
  createForAutomation?(root: string, automation: Automation, text: string, title: string): Promise<{ ok: true; id: string; path: string } | { ok: false; error: string }>;
  /** Set a session's model, effort, mode and minor modes to the automation's, where they differ. */
  configure?(path: string, automation: Automation): Promise<SendResult>;
  /** The playbook block for a session (null: a new one), §chat.schedules/delivery. */
  payload?(path: string | null, bundle: BundleRef): Promise<{ block: string; load: Load; sha: string }>;
  /** This device's host id (§chat.schedules/store). */
  hostId?(): string;
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
  /** The user's go-aheads typed in a branch's own chat (`landing.json`, `by: "owner-chat"`), oldest first. */
  typedGoAheads?(): { branch: string; commit: string }[];
  /** Go on an Overseer card's Ready to land row (`landing.json`, `by: "overseer-card"`), oldest first. */
  cardGoAheads?(): { branch: string; commit: string }[];
  /** Tell the Overseer (under Brief Me only). */
  brief?(text: string): void;
  zone?(): string;
}

/** What a schedule is now, read from its files and the store. */
interface Evaluated {
  kind: "header" | "automation";
  pb: { info: PlaybookInfo; fields: Record<string, string> } | null;
  header: ScheduleHeader | null;
  profile: ListedProfile | null;
  automation?: Automation;
  /** The triggers and zone it fires on, and its task (either declaration). */
  triggers?: Trigger[];
  tz?: string;
  task?: string;
  title: string;
  pin?: string;
  view: PlaybookSchedule;
}

const iso = (t: number) => new Date(t).toISOString();
const bundleOf = (info: PlaybookInfo): BundleRef => ({ id: info.id, dir: info.dir, entry: info.entry });

export class ScheduleKeeper {
  private chain: Promise<unknown> = Promise.resolve();
  /** An active merge-ready schedule was seen (the first tick reads the board to find out). */
  private wantsBoard = true;
  /** The refusal last logged, so a broken store is said once, not every tick. */
  private refusedSaid = "";
  constructor(readonly deps: KeeperDeps) {}

  /** Every store change runs here, one at a time: a tick's awaits never interleave with an approve.
      A store that can't be read refuses the whole step: nothing runs, nothing is written. */
  private locked<T>(fn: (store: ScheduleStore) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      let store: ScheduleStore;
      try {
        store = readStore(this.deps.file);
        this.refusedSaid = "";
      } catch (err) {
        if (err instanceof StoreRefused && err.message !== this.refusedSaid) {
          this.refusedSaid = err.message;
          console.warn(`[schedules] store refused: ${err.message}`);
        }
        throw err;
      }
      await this.syncAutomations(store);
      const out = await fn(store);
      writeStore(this.deps.file, store);
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private log(s: Pick<StoredSchedule, "id" | "root" | "playbook"> & { automation?: string }, trigger: string, outcome: string, extra: { why?: string; session?: string } = {}): void {
    try {
      mkdirSync(dirname(this.deps.logFile), { recursive: true });
      appendFileSync(this.deps.logFile, `${JSON.stringify({ at: iso(this.deps.realNow()), id: s.id, playbook: s.playbook, ...(s.automation ? { automation: s.automation } : {}), root: s.root, trigger, outcome, ...extra })}\n`);
    } catch (err) {
      console.warn("[schedules] log not written:", err instanceof Error ? err.message : String(err));
    }
  }

  private zone(ev: Pick<Evaluated, "tz"> | null): string {
    return ev?.tz ?? (this.deps.zone ?? hostZone)();
  }

  private host(): string | undefined {
    return this.deps.hostId?.();
  }

  // ── Automation files and the carry-over (§chat.schedules/store) ───────────────────────────────

  /** The automation files of `root`, never throwing. */
  private async automationsIn(root: string): Promise<AutomationRead[]> {
    if (!this.deps.automations) return [];
    return this.deps.automations(root).catch(() => []);
  }

  /** The automation file `id` in `root`, or null when it's gone. */
  private async automationOf(root: string, id: string): Promise<AutomationRead | null> {
    return (await this.automationsIn(root)).find((a) => a.id === id) ?? null;
  }

  /**
   * Bring the store in step with the automation files of the roots it knows (and `extra`): a file
   * naming the playbook of a header schedule takes that row over (same `sN`, approval, fires), and
   * any other file gets its own row. Run in every store step, before the step reads anything.
   */
  private async syncAutomations(store: ScheduleStore, extra: readonly string[] = []): Promise<void> {
    if (!this.deps.automations) return;
    const roots = [...new Set([...store.schedules.map((s) => s.root), ...extra])];
    for (const root of roots) {
      for (const a of await this.automationsIn(root)) {
        if (store.schedules.some((s) => s.root === root && s.automation === a.id)) continue;
        const playbook = a.automation?.playbook;
        const legacy = playbook ? store.schedules.find((s) => s.root === root && !s.automation && s.playbook === playbook) : undefined;
        if (legacy && a.automation) await this.adopt(legacy, a.automation);
        else {
          const s: StoredSchedule = { id: `s${++store.seq}`, root, playbook: playbook ?? a.id, automation: a.id, fires: [] };
          store.schedules.push(s);
          this.log(s, "", "found");
          if (a.automation) this.deps.brief?.(`The automation ${a.automation.label} in ${basename(root)} wants to run the playbook ${a.automation.playbook} (${scheduleText(a.automation.triggers)}). It fires only once the user approves it on your permits chip.`);
        }
      }
    }
  }

  /**
   * A header schedule's row becomes the automation's: everything kept, its approval carried only
   * when the header's approved pin still holds (now, or as recorded while it held) and says what
   * the file says. Never approve(): a mismatch stays approved-but-changed until the user approves.
   */
  private async adopt(s: StoredSchedule, a: Automation): Promise<void> {
    const carry = (await this.verifiedLegacyPin2(s)) ?? s.approved?.carry2;
    s.automation = a.id;
    s.host ??= this.host();
    if (s.approved) {
      if (carry && carry === pin2Of(a)) {
        s.approved = { ...s.approved, pin2: carry, carried: this.deps.now() };
        this.log(s, "", "carried");
      } else this.log(s, "", "adopted", { why: `${CHANGED}: the file's triggers, playbook, session kind or permissions differ from what was approved` });
    } else this.log(s, "", "adopted");
    if (!s.session) {
      const sessions = await this.deps.sessions().catch(() => [] as SessionSummary[]);
      const last = [...s.fires].reverse().find((f) => f.sessionId && f.path && sessions.some((x) => x.id === f.sessionId && !x.archived));
      if (last) s.session = { id: last.sessionId!, path: last.path! };
    }
  }

  /** The header's approval in automation terms, when its stored pin is the one its files give now. */
  private async verifiedLegacyPin2(s: StoredSchedule): Promise<string | null> {
    if (!s.approved) return null;
    const pb = await this.deps.readPlaybook(s.root, s.playbook);
    const header = pb ? scheduleOf(pb.fields) : null;
    if (!header?.triggers || !header.profile) return null;
    const profile = await this.deps.findProfile(header.profile, s.root);
    if (!profile || profile.approval === "needed") return null;
    if (pinOf({ tz: header.tz, triggers: header.triggers }, profile) !== s.approved.pin) return null;
    return legacyPin2({ triggers: header.triggers, tz: header.tz }, s.playbook, profile);
  }

  // ── What a schedule is now ──────────────────────────────────────────────────────────────────

  /** The schedule's state now (§chat.schedules/approval): its files first, then what the store holds. */
  private async evaluate(s: Pick<StoredSchedule, "root" | "playbook"> & Partial<StoredSchedule>): Promise<Evaluated> {
    const ev = s.automation ? await this.evaluateAutomation(s as StoredSchedule) : await this.evaluateHeader(s);
    // A row this device doesn't run fires nothing here (§chat.schedules/store).
    const host = this.host();
    if (s.approved && s.host && host && s.host !== host && ev.view.state === "active") {
      ev.view.state = "paused";
      ev.view.reason = OTHER_DEVICE;
      delete ev.view.next;
    }
    return ev;
  }

  private async evaluateHeader(s: Pick<StoredSchedule, "root" | "playbook"> & Partial<StoredSchedule>): Promise<Evaluated> {
    const pb = await this.deps.readPlaybook(s.root, s.playbook);
    const header = pb ? scheduleOf(pb.fields) : null;
    const out: Evaluated = { kind: "header", pb, header, profile: null, title: pb?.info.title ?? s.playbook, view: { when: header?.when ?? "", state: "invalid" } };
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
    out.triggers = header.triggers;
    out.tz = header.tz;
    out.task = header.task;
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
    else {
      // Verified equal now: record it in automation terms, so a later automation file can carry it.
      const carry2 = legacyPin2({ triggers: header.triggers, tz: header.tz }, s.playbook, profile);
      if (s.approved.carry2 !== carry2) s.approved.carry2 = carry2;
      if (!s.host && this.host()) s.host = this.host();
      if (s.paused) out.view.reason = s.paused.reason;
      else {
        out.view.state = "active";
        if (s.next) out.view.next = iso(s.next.at);
      }
    }
    return out;
  }

  private async evaluateAutomation(s: StoredSchedule): Promise<Evaluated> {
    const read = await this.automationOf(s.root, s.automation!);
    const out: Evaluated = { kind: "automation", pb: null, header: null, profile: null, title: read?.automation?.label ?? s.automation!, view: { when: "", state: "invalid" } };
    if (!read) {
      out.view.reason = `The automation file ${s.automation}.json is gone from ${basename(s.root)}.`;
      if (s.approved) out.view.state = "paused";
      return out;
    }
    const a = read.automation;
    if (!a) {
      out.view.reason = read.error;
      return out;
    }
    out.automation = a;
    out.view.when = a.when;
    out.view.text = scheduleText(a.triggers);
    out.view.profileLabel = `${a.label}'s own settings`;
    if (a.tz) out.view.tz = a.tz;
    out.triggers = a.triggers;
    out.tz = a.tz;
    out.task = a.task;
    out.pin = pin2Of(a);
    out.view.pin = out.pin;
    out.pb = await this.deps.readPlaybook(s.root, a.playbook);
    if (!out.pb) {
      out.view.reason = `The playbook ${a.playbook} is gone from ${basename(s.root)}.`;
      out.view.state = s.approved ? "paused" : "invalid";
      return out;
    }
    if (!s.approved) {
      out.view.state = "needs-approval";
      return out;
    }
    out.view.state = "paused";
    if (s.approved.pin2 !== out.pin) out.view.reason = CHANGED;
    else if (s.paused) out.view.reason = s.paused.reason;
    else {
      out.view.state = "active";
      if (s.next) out.view.next = iso(s.next.at);
    }
    return out;
  }

  private register(store: ScheduleStore, root: string, playbook: string): { s: StoredSchedule; fresh: boolean } {
    const found = store.schedules.find((x) => x.root === root && x.playbook === playbook && !x.automation);
    if (found) return { s: found, fresh: false };
    const s: StoredSchedule = { id: `s${++store.seq}`, root, playbook, fires: [] };
    store.schedules.push(s);
    this.log(s, "", "found");
    return { s, fresh: true };
  }

  /** The schedule's sessions for the Automations group, newest first: its own, then its fires'. */
  private sessionsOf(s: StoredSchedule): string[] {
    const ids: string[] = [];
    if (s.session) ids.push(s.session.id);
    for (let i = s.fires.length - 1; i >= 0; i--) {
      const id = s.fires[i]!.sessionId;
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  private info(s: StoredSchedule, ev: Evaluated): ScheduleInfo {
    return {
      ...ev.view,
      id: s.id,
      root: s.root,
      projectName: basename(s.root),
      playbook: s.playbook,
      title: ev.title,
      fires: s.fires.slice(-5).map((f) => ({ at: iso(f.at), trigger: f.trigger, kind: f.kind, ...(f.sessionId ? { sessionId: f.sessionId } : {}) })),
      ...(s.automation ? { automation: s.automation } : {}),
      sessions: this.sessionsOf(s),
    };
  }

  /**
   * The playbook a session's schedule runs (§chat.schedules/playbook-read): the schedule whose own
   * session it is, or whose fires went to it, or (a new session whose fire isn't recorded yet) the
   * approved schedule running the playbook `hint` names, delivered there from that very folder. A
   * session keeps reading what it was delivered after a revoke. Read only.
   */
  async bundleFor(sessionId: string, hint?: { id: string; dir?: string }): Promise<(BundleRef & { title: string }) | null> {
    let store: ScheduleStore;
    try {
      store = readStore(this.deps.file);
    } catch {
      return null;
    }
    const mine = store.schedules.filter((s) => s.session?.id === sessionId || s.fires.some((f) => f.sessionId === sessionId));
    const candidates = mine.length ? mine : hint ? store.schedules.filter((s) => s.approved && s.playbook === hint.id) : [];
    for (const s of candidates) {
      const pb = await this.deps.readPlaybook(s.root, s.playbook).catch(() => null);
      if (!pb) continue;
      if (!mine.length && hint?.dir !== pb.info.dir) continue;
      return { ...bundleOf(pb.info), title: pb.info.title };
    }
    return null;
  }

  /** Every schedule Sova knows of, with its state (the permits panel, GET /api/schedules). */
  list(): Promise<ScheduleInfo[]> {
    return this.locked(async (store) => {
      const out: ScheduleInfo[] = [];
      for (const s of store.schedules) out.push(this.info(s, await this.evaluate(s)));
      return out;
    });
  }

  /** The playbooks an automation file in `root` names: their headers are no second schedule. */
  private async claimedPlaybooks(root: string): Promise<Set<string>> {
    return new Set((await this.automationsIn(root)).map((a) => a.automation?.playbook).filter((x): x is string => !!x));
  }

  /**
   * The Playbooks catalog with each project schedule's state, registering the ones Sova hadn't seen
   * (they read Needs approval). `root`: the catalog's project.
   */
  decorate(catalog: PlaybookCatalog, root: string | null): Promise<PlaybookCatalog> {
    const scheduled = catalog.playbooks.filter((p) => p.source === "project" && p.schedule && p.schedule.state !== "not-project");
    if (!root || !scheduled.length) return Promise.resolve(catalog);
    return this.locked(async (store) => {
      await this.syncAutomations(store, [root]);
      const claimed = await this.claimedPlaybooks(root);
      for (const p of scheduled) {
        // A playbook an automation file runs shows that automation's row.
        const own = claimed.has(p.id) ? store.schedules.find((x) => x.root === root && x.automation && x.playbook === p.id) : undefined;
        const { s, fresh } = own ? { s: own, fresh: false } : this.register(store, root, p.id);
        if (fresh) this.announce(s, p);
        const ev = await this.evaluate(s);
        p.schedule = { ...ev.view, id: s.id, ...(s.automation ? { automation: s.automation } : {}) };
      }
      return catalog;
    });
  }

  private announce(s: StoredSchedule, p: PlaybookInfo): void {
    if (p.schedule?.state === "invalid") return;
    this.deps.brief?.(`The playbook ${p.title} in ${basename(s.root)} wants to run on a schedule (${p.schedule?.text ?? p.schedule?.when}). It fires only once the user approves it in the Playbooks dialog or on your permits chip.`);
  }

  /**
   * Find schedules in the projects of `roots` (the keeper's discovery): automation files and
   * playbook headers; new ones read Needs approval. An unapproved one whose header no longer
   * declares a schedule, or whose automation file is gone, is forgotten.
   */
  discover(roots: readonly string[], list: (root: string) => Promise<PlaybookInfo[]>): Promise<void> {
    return this.locked(async (store) => {
      await this.syncAutomations(store, roots);
      for (const root of new Set(roots)) {
        const claimed = await this.claimedPlaybooks(root);
        const pbs = await list(root).catch(() => [] as PlaybookInfo[]);
        for (const p of pbs) {
          if (!p.schedule || p.schedule.state === "not-project" || claimed.has(p.id)) continue;
          const { s, fresh } = this.register(store, root, p.id);
          if (fresh) this.announce(s, p);
        }
      }
      const keep: StoredSchedule[] = [];
      for (const s of store.schedules) {
        if (!s.approved && roots.includes(s.root)) {
          if (s.automation && !(await this.automationOf(s.root, s.automation))) continue;
          if (!s.automation && !(await this.deps.readPlaybook(s.root, s.playbook).then((pb) => pb && scheduleOf(pb.fields)))) continue;
        }
        keep.push(s);
      }
      store.schedules = keep;
    });
  }

  /** POST /api/schedules/approve: the user's click, for exactly the pin they were shown. `ref` names
      a header's playbook or an automation file. */
  approve(root: string, ref: string | { playbook?: string; automation?: string }, pin: string): Promise<{ ok: true; schedule: ScheduleInfo } | { ok: false; status: 404 | 409; error: string }> {
    const r = typeof ref === "string" ? { playbook: ref } : ref;
    return this.locked(async (store) => {
      await this.syncAutomations(store, [root]);
      const match = (x: StoredSchedule) => x.root === root && (r.automation ? x.automation === r.automation : !x.automation && x.playbook === r.playbook);
      const existing = store.schedules.find(match);
      if (r.automation && !existing) return { ok: false as const, status: 404 as const, error: `No automation ${r.automation} in ${basename(root)}.` };
      if (!r.automation && r.playbook && (await this.claimedPlaybooks(root)).has(r.playbook))
        return { ok: false as const, status: 409 as const, error: `An automation file runs ${r.playbook}: approve the automation instead.` };
      const ev = await this.evaluate(existing ?? { root, playbook: r.playbook ?? "" });
      if (ev.kind === "header" && (!ev.pb || !ev.header)) return { ok: false as const, status: 404 as const, error: ev.view.reason ?? `No schedule in ${r.playbook}.` };
      if (!ev.pin || !ev.triggers || (ev.kind === "header" && !ev.profile) || (ev.kind === "automation" && !ev.pb)) return { ok: false as const, status: 409 as const, error: ev.view.reason ?? "This schedule can't be approved." };
      if (ev.pin !== pin) return { ok: false as const, status: 409 as const, error: "The schedule or its profile changed since it was shown. Look at it again, then approve." };
      if (ev.profile?.approval === "needed") return { ok: false as const, status: 409 as const, error: `Its profile ${ev.profile.label} needs your approval first (Settings → Profiles).` };
      const others = store.schedules.filter((x) => x.approved && !match(x)).length;
      if (others >= MAX_APPROVED) return { ok: false as const, status: 409 as const, error: `Sova runs at most ${MAX_APPROVED} schedules. Revoke one first.` };
      const s = existing ?? this.register(store, root, r.playbook!).s;
      const now = this.deps.now();
      s.approved = ev.kind === "automation" ? { pin, at: now, pin2: pin } : { pin, at: now };
      const host = this.host();
      if (host) s.host = host;
      delete s.paused;
      s.next = nextFire(ev.triggers, now, this.zone(ev)) ?? undefined;
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

  /** The block for a session (null: new), or why it can't be had. Without a payload dep, the
      wake's old instruction (tests that predate delivery). */
  private async block(bundle: BundleRef, path: string | null): Promise<{ ok: true; block: string; load?: Load } | { ok: false; error: string }> {
    if (!this.deps.payload) return { ok: true, block: "" };
    try {
      const p = await this.deps.payload(path, bundle);
      return { ok: true, block: p.block, load: p.load };
    } catch (err) {
      return { ok: false, error: `the playbook couldn't be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private message(head: string, title: string, block: string, before?: string): string {
    return [head, ...(before ? [before] : []), ...(block ? [deliveryInstruction(title), block] : [])].join("\n");
  }

  /** One fire of an active schedule (§chat.schedules/fire): a time, or a merge-ready transition with its own reason. */
  private async fire(s: StoredSchedule, ev: Evaluated, trigger: string, lateMs: number | undefined, reason?: string): Promise<void> {
    const tz = this.zone(ev);
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
    const bundle = bundleOf(pb);
    const head = fireHead(s.id, trigger, ev.automation?.id ?? pb.id, reason ?? ev.task ?? DEFAULT_TASK, lateMs, ev.automation ? "automation" : "playbook");
    const wakeText = async (path: string): Promise<string | { error: string }> => {
      const b = await this.block(bundle, path);
      if (!b.ok) return { error: b.error };
      return b.block ? this.message(head, pb.title, b.block) : `${head}\n${wakeInstruction(pb.title, pb.dir, pb.entry)}`;
    };

    if (ev.automation) {
      const a = ev.automation;
      const sessions = await this.deps.sessions();
      const own = s.session ? sessions.find((x) => x.id === s.session!.id && !x.archived) : undefined;
      if (own) {
        if (own.live) return skip(`${a.label}'s session is open in a terminal`);
        const configured = this.deps.configure ? await this.deps.configure(own.path, a).catch((err) => ({ ok: false as const, error: String(err) })) : ({ ok: true } as const);
        const text = await wakeText(own.path);
        if (typeof text !== "string") return this.log(s, trigger, "refused", { why: text.error, session: own.id });
        const r = await this.deps.wake(own.path, text);
        if (!r.ok) return this.log(s, trigger, "refused", { why: r.error, session: own.id });
        this.record(s, { trigger, kind: "wake", sessionId: own.id, path: own.path }, tz);
        return this.log(s, trigger, "fired", { session: own.id, ...(configured.ok ? {} : { why: `its settings were not applied: ${configured.error}` }) });
      }
      if (!this.deps.createForAutomation) return this.log(s, trigger, "refused", { why: "this Sova can't start an automation's session" });
      const b = await this.block(bundle, null);
      if (!b.ok) return this.log(s, trigger, "refused", { why: b.error });
      const r = await this.deps.createForAutomation(s.root, a, this.message(head, pb.title, b.block), `${a.label} (automation)`);
      if (!r.ok) return this.log(s, trigger, "refused", { why: r.error });
      s.session = { id: r.id, path: r.path };
      this.record(s, { trigger, kind: "new", sessionId: r.id, path: r.path }, tz);
      return this.log(s, trigger, "fired", { session: r.id });
    }

    const profile = ev.profile!;
    if (profile.singleton) {
      const holder = singletonHolder(keyOf(profile), await this.deps.sessions());
      if (holder) {
        if (holder.live) return skip(`${profile.label} is open in a terminal`);
        const text = await wakeText(holder.path);
        if (typeof text !== "string") return this.log(s, trigger, "refused", { why: text.error, session: holder.id });
        const r = await this.deps.wake(holder.path, text);
        if (!r.ok) return this.log(s, trigger, "refused", { why: r.error, session: holder.id });
        // The schedule's own session, seeded from the header's One at a time session (§chat.schedules/store).
        if (s.session?.id !== holder.id) s.session = { id: holder.id, path: holder.path };
        this.record(s, { trigger, kind: "wake", sessionId: holder.id, path: holder.path }, tz);
        return this.log(s, trigger, "fired", { session: holder.id });
      }
    }
    const b = await this.block(bundle, null);
    if (!b.ok) return this.log(s, trigger, "refused", { why: b.error });
    const text = b.block ? this.message(head, pb.title, b.block) : `${head}\n\n${playbookTurnText(pb, "")}`;
    const r = await this.deps.create(s.root, { source: profile.source, id: profile.id }, text, `${pb.title} (scheduled)`);
    if (!r.ok) return this.log(s, trigger, "refused", { why: r.error });
    if (profile.singleton) s.session = { id: r.id, path: r.path };
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
      if (ev.view.state !== "active" || !ev.triggers?.some((t) => t.kind === "limit-reset")) continue;
      if (late >= MAX_LATE_MS) {
        this.log(s, LIMIT_RESET, "skipped", { why: `the reset of ${reset.name} was ${lateText(late)} ago, while Sova was not running` });
        continue;
      }
      const tz = this.zone(ev);
      // The sessions this schedule may target: those its own fires started, its One at a time
      // profile's live one, and an automation's own session.
      const paths = new Set(s.fires.filter((f) => f.kind === "new" && f.path).map((f) => f.path!));
      if (ev.profile?.singleton) {
        const holder = singletonHolder(keyOf(ev.profile), sessions);
        if (holder) paths.add(holder.path);
      }
      if (ev.automation && s.session) paths.add(s.session.path);
      for (const path of paths) {
        const sum = sessions.find((x) => x.path === path);
        if (!sum || sum.archived || sum.live || this.deps.busy(path)) continue;
        const turn = await this.deps.lastTurn(path).catch(() => null);
        if (!turn?.failed || turn.login !== reset.id || turn.at < reset.since - 60_000) continue;
        if (this.dayFull(s, tz)) {
          this.log(s, LIMIT_RESET, "skipped", { why: `it fired ${MAX_FIRES_PER_DAY} times today`, session: sum.id });
          continue;
        }
        // The running-at-once cap holds for a continue as for any fire.
        if (this.deps.freeSlots() <= 0) {
          this.log(s, LIMIT_RESET, "skipped", { why: "the running-at-once limit was reached", session: sum.id });
          continue;
        }
        const head = fireHead(s.id, LIMIT_RESET, ev.automation?.id ?? s.playbook, `Claude login ${reset.name} is ready again.`, late >= this.deps.lateAfterMs ? late : undefined, ev.automation ? "automation" : "playbook");
        let block = "";
        if (ev.pb) {
          const b = await this.block(bundleOf(ev.pb.info), path);
          if (!b.ok) {
            this.log(s, LIMIT_RESET, "refused", { why: b.error, session: sum.id });
            continue;
          }
          block = b.block;
        }
        if (ev.automation && this.deps.configure) await this.deps.configure(path, ev.automation).catch(() => undefined);
        const r = await this.deps.wake(path, [head, LIMIT_RESET_INSTRUCTION, ...(block ? [block] : [])].join("\n"));
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
   * merge-ready (§chat.schedules/merge-ready): fire, at once, for the branches in the schedule's project
   * that read Ready to land with an idle owner at a commit they haven't fired for. A row the board hasn't
   * read yet (`pending`) is unknown: it is never forgotten. While the last run is still going the
   * transition waits, unlogged; any fire attempt (fired, skipped by a cap, refused) spends it.
   */
  private async mergeReady(s: StoredSchedule, ev: Evaluated, board: { pending: number; rowsIn(root: string): BoardRow[] }): Promise<void> {
    const now = this.deps.now();
    const rows = board.rowsIn(s.root);
    const seen = (s.ready ??= {});
    const fresh: { path: string; branch: string; commit: string }[] = [];
    for (const r of rows) {
      if (r.landing?.state !== "ready" || r.owner.status !== "idle") continue;
      const prev = seen[r.path];
      if (prev?.branch !== r.branch || prev.commit !== r.landing.commit) fresh.push({ path: r.path, branch: r.branch, commit: r.landing.commit });
    }
    for (const [path, prev] of Object.entries(seen)) {
      const row = rows.find((r) => r.path === path);
      if (row?.landing?.state === "ready" || (!row && board.pending > 0)) continue; // ready, or not read yet
      if (now - prev.at >= MERGE_READY_FORGET_MS) delete seen[path];
    }
    // The user's go-ahead typed in a branch's own chat, or given with Go on an Overseer card, wakes the round too,
    // whatever its row reads: once per commit.
    const goAheadsIn = (seenMap: NonNullable<StoredSchedule["typed"]>, goAheads: readonly { branch: string; commit: string }[]) => {
      const out: { path: string; branch: string; commit: string }[] = [];
      for (const r of rows) {
        const g = goAheads.filter((x) => x.branch === r.branch).at(-1);
        const prev = seenMap[r.path];
        if (g && (prev?.branch !== r.branch || prev.commit !== g.commit)) out.push({ path: r.path, branch: r.branch, commit: g.commit });
      }
      for (const [path, prev] of Object.entries(seenMap)) {
        if (rows.some((r) => r.path === path) || board.pending > 0) continue;
        if (now - prev.at >= MERGE_READY_FORGET_MS) delete seenMap[path];
      }
      return out;
    };
    const typedSeen = (s.typed ??= {});
    const typed = goAheadsIn(typedSeen, this.deps.typedGoAheads?.() ?? []);
    const cardSeen = (s.card ??= {});
    const card = goAheadsIn(cardSeen, this.deps.cardGoAheads?.() ?? []);
    if (!fresh.length && !typed.length && !card.length) return;
    // Held, unlogged and unseen, so they go out together later, while the run it last fired into is in flight.
    const last = [...s.fires].reverse().find((f) => f.path);
    if (last?.path && this.deps.busy(last.path)) return;
    fresh.sort((a, b) => a.branch.localeCompare(b.branch));
    typed.sort((a, b) => a.branch.localeCompare(b.branch));
    card.sort((a, b) => a.branch.localeCompare(b.branch));
    for (const f of fresh) seen[f.path] = { branch: f.branch, commit: f.commit, at: now };
    for (const f of typed) typedSeen[f.path] = { branch: f.branch, commit: f.commit, at: now };
    for (const f of card) cardSeen[f.path] = { branch: f.branch, commit: f.commit, at: now };
    // The day's timed fires keep their room under the cap: merge-ready never takes it.
    const tz = this.zone(ev);
    const reserved = maxFiresPerDay(ev.triggers!).n;
    if (s.day?.key === dayKey(now, tz) && s.day.n >= MAX_FIRES_PER_DAY - reserved) {
      this.log(s, MERGE_READY, "skipped", { why: `merge-ready leaves today's last ${reserved} of ${MAX_FIRES_PER_DAY} fires to the timed triggers` });
      return;
    }
    await this.fire(s, ev, MERGE_READY, undefined, mergeReadyReason(fresh.map((f) => f.branch), typed.map((f) => f.branch), card.map((f) => f.branch)));
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
        if (ev.view.state !== "active" || !ev.triggers?.some((t) => t.kind === "merge-ready")) continue;
        wants = true;
        if (board) await this.mergeReady(s, ev, board);
      }
      this.wantsBoard = wants;
      for (const s of store.schedules) {
        if (!s.approved) continue;
        const ev = await this.evaluate(s);
        const triggers = ev.triggers;
        if (ev.view.state !== "active" || !triggers) continue;
        const tz = this.zone(ev);
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

/** Every schedule for the Overseer's permits panel; none before the keeper starts (or with its store refused). */
export const schedulesForWire = (): Promise<ScheduleInfo[]> => keeper?.list().catch(() => [] as ScheduleInfo[]) ?? Promise.resolve([]);
