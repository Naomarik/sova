import type { DelegateOptions, OverseerCaps, OverseerPingLimits, OverseerQuickAction, OverseerSaveResult, OverseerSettings, OverseerSettingsInfo, WorkerChoice } from "../../shared/protocol";
import { ApiError, getOverseerNotes, getOverseerSettings, putOverseerNotes, putOverseerSettings } from "./api";
import type { BackendsInfo } from "./delegate-form";
import { createDraftStore, failureOf, SaveFailed } from "./settings-draft";
import { check, type FieldCheck, firstIssue, type WholeRule } from "../../shared/form-rules";
import { CAP_KEYS, CAP_MAX, CAP_RULES, DEFAULT_CAPS as CAP_DEFAULTS, DEFAULT_PING_LIMITS, EXTRA_PROMPT_RULE, NOTES_MAX, NOTES_RULE, PING_LIMIT_KEYS, PING_LIMIT_RULES, pingLimitsOf, QA_RULES, qaLabel, QUICK_ACTIONS_MAX, TOO_MANY_QUICK_ACTIONS } from "../../shared/overseer-limits";

/**
 * Settings → Overseer's unsaved edits: the settings file and the standing notes, edited together
 * and saved by one button (settings-draft.ts: module state, held on close, forgotten once closed).
 *
 * The files change under an open form: the Overseer's composer writes its model and thinking, and
 * its `sova_note` appends notes. So the draft is always an edit OF a base (`saved`): a fresh read
 * rebases it (every field the user left alone follows the file), and Save rebases once more onto a
 * read taken just before it writes. A save only ever carries what the user changed.
 */
export interface OverseerDraft {
  settings: OverseerSettings;
  notes: string;
}

/** A limit as its box holds it: the text typed (a half-typed or blank entry stays as typed, red,
    and Save waits), or a number (what a load or a test puts there). */
export type CapEntry = number | string;
export type FormCaps = Record<keyof OverseerCaps, CapEntry>;
/** The sessions' ping limits' boxes (§app.overseer-pings/limits), as the caps' are. */
export type FormPings = Record<keyof OverseerPingLimits, CapEntry>;

/** What the form edits: the saved shape, but each limit is what its box holds. */
export interface OverseerForm {
  settings: Omit<OverseerSettings, "caps" | "pings"> & { caps: FormCaps; pings?: FormPings };
  notes: string;
}

// The server's limits and labels (shared/overseer-limits.ts), checked by the form before anything is sent.
export { CAP_KEYS, CAP_LABEL, CAP_MAX, DEFAULT_CAPS as CAP_DEFAULTS, EXTRA_PROMPT_MAX, NOTES_MAX, QUICK_ACTIONS_MAX } from "../../shared/overseer-limits";

const ANY_CAP: WholeRule = { kind: "whole", label: "A limit", min: 0, max: CAP_MAX };
/** A limit's value: a whole number from 0 to CAP_MAX, typed or stored; null when it isn't one. */
export function capOf(v: CapEntry | undefined): number | null {
  const r = check(ANY_CAP, v);
  return r.ok ? r.value : null;
}

/** Settings with every limit present: one missing (or not a number) takes `defaults`', else the form's own default. */
export function completeCaps(settings: OverseerSettings, defaults?: Partial<OverseerCaps>): OverseerSettings {
  const caps = { ...settings.caps };
  for (const k of CAP_KEYS) {
    if (typeof caps[k] === "number") continue;
    const d = defaults?.[k];
    caps[k] = typeof d === "number" ? d : CAP_DEFAULTS[k];
  }
  // The ping limits: absent (never saved) or out of range reads as each default, so their boxes always show.
  return { ...settings, caps, pings: pingLimitsOf(settings) };
}

/** The same, for a whole read of the settings: its defaults completed first. */
export function completeInfo<T extends { settings: OverseerSettings; defaults: { caps: OverseerCaps } }>(info: T): T {
  const defaults = completeCaps({ caps: info.defaults?.caps ?? {} } as OverseerSettings).caps;
  return { ...info, settings: completeCaps(info.settings, defaults), defaults: { ...info.defaults, caps: defaults } };
}

/** A copy with every limit mapped by `f`. */
const mapCaps = <T extends OverseerDraft | OverseerForm, V extends CapEntry>(d: T, f: (v: CapEntry) => V) => {
  const c = cloneOverseer(d);
  const map = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v as CapEntry)]));
  return { ...c, settings: { ...c.settings, caps: map(c.settings.caps), ...(c.settings.pings ? { pings: map(c.settings.pings) } : {}) } };
};
/** The form as a fresh copy of what's saved: each limit shown as text. */
export const toOverseerForm = (d: OverseerDraft): OverseerForm => mapCaps(d, String) as OverseerForm;
/** The form as the saved shape: each limit its number (NaN for a box that holds none). */
export const formToDraft = (f: OverseerDraft | OverseerForm): OverseerDraft => mapCaps(f, (v) => capOf(v) ?? Number.NaN) as unknown as OverseerDraft;

/** Whether a box's entry says the same as a saved number (the number typed back, "5" for 5). */
const capSame = (a: CapEntry | undefined, b: CapEntry | undefined): boolean => Object.is(a, b) || (capOf(a) ?? Number.NaN) === capOf(b);

/** A deep copy (works for the form as well as the saved shape). */
export function cloneOverseer<T extends OverseerDraft | OverseerForm>(d: T): T;
export function cloneOverseer(d: OverseerDraft | OverseerForm): OverseerDraft | OverseerForm {
  return {
  settings: {
    ...d.settings,
    quickActions: d.settings.quickActions.map((a) => ({ ...a })),
    caps: { ...d.settings.caps },
    ...(d.settings.pings ? { pings: { ...d.settings.pings } } : {}),
    explorer: { ...d.settings.explorer },
  },
  notes: d.notes,
  } as OverseerDraft;
}

/** Deep equality for the plain JSON the drafts hold (NaN equals NaN: a cleared number field). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Every field, the notes included: a field added to OverseerSettings later is compared too. A
    limit compares by its value, so the saved number typed back is no change. */
export const sameOverseer = (a: OverseerDraft | OverseerForm, b: OverseerDraft | OverseerForm): boolean => sameValue(formToDraft(a), formToDraft(b));

const trimEnd = (t: string) => t.replace(/\s*$/, "");

/**
 * The notes the user edited from `base`, onto the file's `fresh` notes. Untouched: the file's.
 * The file unchanged: the user's. The Overseer appended (sova_note append keeps the old text as a
 * prefix): the user's text with the appended lines after it. Anything else (sova_note replace):
 * null, a conflict the user has to settle. Pure.
 */
export function mergeNotes(mine: string, base: string, fresh: string): string | null {
  if (mine === base) return fresh;
  if (fresh === base || fresh === mine) return mine;
  const was = trimEnd(base);
  const now = trimEnd(fresh);
  if (!now.startsWith(was)) return null;
  const added = now.slice(was.length).trim();
  if (!added || trimEnd(mine).endsWith(added)) return mine;
  const head = trimEnd(mine);
  return `${head}${head ? "\n" : ""}${added}\n`;
}

/**
 * `draft` was an edit of `base`; the file now holds `fresh`. Every field the user left alone
 * (still equal to `base`) takes `fresh`'s value; every field they changed keeps theirs. Caps go
 * key by key, the quick actions as one list, the notes by `mergeNotes` (a conflict keeps the user's
 * text; Save checks for it before writing). Pure.
 */
export function rebaseOverseer<T extends OverseerDraft | OverseerForm>(draft: T, base: OverseerDraft, fresh: OverseerDraft): T {
  const pick = <T>(mine: T, was: T, now: T): T => (sameValue(mine, was) ? now : mine);
  const settings = { ...fresh.settings } as Record<string, unknown>;
  const d = draft.settings as unknown as Record<string, unknown>;
  const b = base.settings as unknown as Record<string, unknown>;
  const f = fresh.settings as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(f), ...Object.keys(d)])) {
    if (k === "caps") continue;
    settings[k] = pick(d[k], b[k], f[k]);
  }
  const caps: Record<string, CapEntry> = { ...fresh.settings.caps };
  const mine = draft.settings.caps as Record<string, CapEntry>;
  const was = base.settings.caps as unknown as Record<string, CapEntry>;
  // The form shows a limit the file just changed as text, like every other limit box.
  const asDraft = (now: CapEntry) => (Object.values(mine).some((v) => typeof v === "string") ? String(now) : now);
  for (const k of Object.keys(caps)) caps[k] = mine[k] === undefined || capSame(mine[k], was[k]) ? asDraft(caps[k]!) : mine[k]!;
  settings.caps = caps;
  return cloneOverseer({ settings: settings as unknown as OverseerSettings, notes: mergeNotes(draft.notes, base.notes, fresh.notes) ?? draft.notes }) as T;
}

/** The Overseer rewrote its notes (sova_note replace) while the user edited them: nothing merges. */
export class NotesConflict extends Error {
  constructor() {
    super("The standing notes changed while you were editing them");
  }
}

/** The user's notes and what the Overseer appended meanwhile merge past NOTES_MAX: nothing is written. */
export class NotesTooLong extends Error {
  constructor() {
    super("The standing notes would be too long with what the Overseer added");
  }
}

/** What a save reads and writes, injected (src/lib/api.ts in the app, fakes in the tests). */
export interface OverseerSaveIO {
  getSettings(): Promise<OverseerSettingsInfo>;
  getNotes(): Promise<string>;
  putSettings(settings: OverseerSettings): Promise<OverseerSaveResult>;
  /** Refused (409) when the file no longer holds `base`. */
  putNotes(text: string, base: string): Promise<string>;
}

/**
 * Save `draft`, an edit of `base`. Both files are read first, and the draft rebased onto them, so
 * a field the user left alone is written with what the file holds NOW (the composer's model, the
 * Overseer's latest note), never with the form's older copy. A file whose content wouldn't change
 * is not written at all. Throws NotesConflict, before writing anything, when the Overseer rewrote
 * the notes the user edited.
 */
export async function saveOverseerDraft(draft: OverseerDraft, base: OverseerDraft, io: OverseerSaveIO): Promise<{ result: OverseerSaveResult; notes: string }> {
  const [read, notes] = await Promise.all([io.getSettings(), io.getNotes()]);
  const info = completeInfo(read);
  if (mergeNotes(draft.notes, base.notes, notes) === null) throw new NotesConflict();
  const next = rebaseOverseer(draft, base, { settings: info.settings, notes });
  // The form checked the user's notes; what the Overseer appended since can still push the merge
  // over the server's limit. Refuse before the settings are written, so the save never half-lands.
  if (next.notes.length > NOTES_MAX) throw new NotesTooLong();
  const result = sameValue(next.settings, info.settings) ? { ...info, warnings: [] } : await io.putSettings(next.settings);
  const savedNotes = next.notes === notes ? notes : await io.putNotes(next.notes, notes);
  return { result, notes: savedNotes };
}

/** What the app's save reads and writes: the server, through src/lib/api.ts. */
const serverIO: OverseerSaveIO = {
  getSettings: () => getOverseerSettings().then(completeInfo),
  getNotes: () => getOverseerNotes().then((n) => n.text),
  putSettings: (s) => putOverseerSettings(s).then(completeInfo),
  putNotes: (text, was) => putOverseerNotes(text, was).then((n) => n.text),
};

export const NOTES_CONFLICT_MESSAGE =
  "The Overseer rewrote its standing notes while you were editing them, so your notes weren't saved. Your edit is still in the box: Save Changes again replaces the Overseer's version, and Cancel drops your edit, so the Overseer's version shows the next time you open Settings";

export const NOTES_TOO_LONG_MESSAGE =
  "The Overseer added to its standing notes while you were editing them, and together they're over 8,000 characters, so nothing was saved. Shorten the notes, then Save Changes again";

const store = createDraftStore<OverseerForm, OverseerDraft, OverseerSaveResult>({
  tab: "overseer",
  label: "Overseer",
  toDraft: toOverseerForm,
  same: sameOverseer,
  rebase: rebaseOverseer,
  fields: (d) => overseerFields(d),
  write: async (cur, base) => {
    let wrote = false;
    try {
      const { result, notes } = await saveOverseerDraft(formToDraft(cur), base, {
        ...serverIO,
        putSettings: async (settings) => {
          const r = await serverIO.putSettings(settings);
          wrote = true;
          return r;
        },
      });
      return { saved: cloneOverseer({ settings: result.settings, notes }), warnings: result.warnings, result };
    } catch (err) {
      const conflict = err instanceof NotesConflict || (err instanceof ApiError && err.status === 409);
      // Whatever did land, and whatever the Overseer wrote meanwhile, becomes the base again.
      void Promise.all([serverIO.getSettings(), serverIO.getNotes()]).then(
        ([info, notes]) => store.refreshSaved(cloneOverseer({ settings: info.settings, notes })),
        () => {},
      );
      throw new SaveFailed(err instanceof NotesTooLong ? NOTES_TOO_LONG_MESSAGE : conflict ? NOTES_CONFLICT_MESSAGE : failureOf(err).message, wrote);
    }
  },
});

export const overseerDraft = store.draft;
export const overseerSaved = store.saved;
export const setOverseerDraft = store.setDraft;

/**
 * What the server has now. The first load seeds the draft; a kept draft is rebased onto it, so
 * the user's edits stay and everything else follows the file. `replaceDraft` (after a save) makes
 * the draft the saved copy.
 */
export const setOverseerSaved = (next: OverseerDraft, opts?: { replaceDraft?: boolean }): void => store.setSaved(cloneOverseer(next), opts);
export const overseerDirty = store.dirty;
export const overseerSaving = store.saving;
/** Why the dialog's Save waits for this form ("Overseer: …"), or null. */
export const overseerProblem = store.problem;
/** The dialog's Save Changes for this form alone (the footer saves every form; tests use this). */
export const saveOverseer = store.save;
export const overseerSaveError = store.error;
export const overseerWarnings = store.warnings;
/** The dialog closed: drop the draft, so the next open reads the saved file afresh. */
export const resetOverseerDraft = store.reset;

/** The eight limits counted per message: the folded group under Running at once. */
export const PER_MESSAGE_CAP_KEYS = CAP_KEYS.filter((k) => k !== "concurrentSessions");

/** Where the draft's problem is, so the form can open the folded group that holds the field. */
export type OverseerIssueAt =
  | { group: "running" }
  | { group: "per-message"; key: keyof OverseerCaps }
  /** A session ping limit (§app.overseer-pings/limits), checked whenever the settings carry them. */
  | { group: "pings"; key: (typeof PING_LIMIT_KEYS)[number] }
  | { group: "quick-action"; index: number }
  | { group: "notes" }
  | { group: "advanced" };

type AnyDraft = OverseerDraft | OverseerForm;

/** Add Quick Action stops at the most the server keeps. */
export const canAddQuickAction = (list: readonly OverseerQuickAction[]): boolean => list.length < QUICK_ACTIONS_MAX;

export const EXPLORER_NEEDS = "The idea explorer needs a model and an effort.";

/**
 * The form's fields in page order, each with its rule (or the explorer's own sentence) and where
 * it is, so the form can open the folded group that holds the first bad one. Every limit the
 * server's strict PUT checks is here, so Save never sends what the server refuses, and never
 * writes the settings and then fails on the notes.
 */
export function overseerFields(d: AnyDraft): (FieldCheck<OverseerIssueAt> | { message: string | null; at: OverseerIssueAt })[] {
  const actions = d.settings.quickActions;
  return [
    ...CAP_KEYS.map((k) => ({ rule: CAP_RULES[k], value: (d.settings.caps as FormCaps)[k], at: k === "concurrentSessions" ? { group: "running" as const } : { group: "per-message" as const, key: k } })),
    ...(d.settings.pings ? PING_LIMIT_KEYS.map((k) => ({ rule: PING_LIMIT_RULES[k], value: d.settings.pings![k], at: { group: "pings" as const, key: k } })) : []),
    { message: actions.length > QUICK_ACTIONS_MAX ? TOO_MANY_QUICK_ACTIONS : null, at: { group: "quick-action", index: QUICK_ACTIONS_MAX } },
    ...actions.flatMap((a, i) => (["label", "description", "prompt"] as const).map((k) => ({ rule: QA_RULES[k], value: a[k], label: qaLabel(i + 1, k), at: { group: "quick-action" as const, index: i } }))),
    { rule: NOTES_RULE, value: d.notes, at: { group: "notes" } },
    { message: !d.settings.explorer.model || !d.settings.explorer.effort ? EXPLORER_NEEDS : null, at: { group: "advanced" } },
    { rule: EXTRA_PROMPT_RULE, value: d.settings.extraSystemPrompt, at: { group: "advanced" } },
  ];
}

/** The first problem and where it is, or null. */
export const overseerDraftIssue = (d: AnyDraft) => firstIssue(overseerFields(d)) as { message: string; at: OverseerIssueAt } | null;

/** Why the draft can't be saved, one sentence, or null. */
export const overseerDraftProblem = (d: AnyDraft): string | null => overseerDraftIssue(d)?.message ?? null;

/** How many of the per-message limits differ from their defaults (a cleared field counts). */
export function capsChangedFromDefault(caps: FormCaps | OverseerCaps, defaults: OverseerCaps): number {
  return PER_MESSAGE_CAP_KEYS.filter((k) => !capSame(caps[k], defaults[k])).length;
}

/** Limits' Reset to Defaults: every box shows its default, as text like every limit box. Pure. */
export function resetLimits(d: OverseerForm, defaults: { caps: OverseerCaps }): OverseerForm {
  const caps = {} as FormCaps;
  for (const k of CAP_KEYS) caps[k] = String(defaults.caps[k] ?? CAP_DEFAULTS[k]);
  const pings = {} as FormPings;
  for (const k of PING_LIMIT_KEYS) pings[k] = String(DEFAULT_PING_LIMITS[k]);
  return { ...cloneOverseer(d), settings: { ...cloneOverseer(d).settings, caps, pings } };
}

/** How many ping limits differ from their defaults (an absent one is at its default). */
export function pingsChangedFromDefault(pings: FormPings | OverseerPingLimits | undefined): number {
  return PING_LIMIT_KEYS.filter((k) => !capSame(pings?.[k] ?? DEFAULT_PING_LIMITS[k], DEFAULT_PING_LIMITS[k])).length;
}
/** Quick actions' Reset to Defaults: the shipped list, copied. Pure. */
export const resetQuickActions = (d: OverseerForm, defaults: { quickActions: OverseerQuickAction[] }): OverseerForm => {
  const c = cloneOverseer(d);
  return { ...c, settings: { ...c.settings, quickActions: defaults.quickActions.map((q) => ({ ...q })) } };
};
/** The idea explorer's Reset to Defaults. Pure. */
export const resetExplorer = (d: OverseerForm, defaults: { explorer: WorkerChoice }): OverseerForm => {
  const c = cloneOverseer(d);
  return { ...c, settings: { ...c.settings, explorer: { ...defaults.explorer } } };
};

/** Which groups already hold their defaults: their Reset to Defaults is greyed out. */
export function atDefaults(d: AnyDraft, defaults: { caps: OverseerCaps; quickActions: OverseerQuickAction[]; explorer: WorkerChoice }): { limits: boolean; quickActions: boolean; explorer: boolean } {
  return {
    limits: CAP_KEYS.every((k) => capSame((d.settings.caps as FormCaps)[k], defaults.caps[k])) && pingsChangedFromDefault(d.settings.pings) === 0,
    quickActions: sameValue(d.settings.quickActions, defaults.quickActions),
    explorer: sameValue(d.settings.explorer, defaults.explorer),
  };
}

/** The folded Per-message limits group's head: "All at default", "2 changed from default". */
export const perMessageSummary = (changed: number): string => (changed === 0 ? "All at default" : `${changed} changed from default`);

/** Running at once's live line: the count now, of the number in the field, or of the saved limit
    while the field doesn't hold a valid one. */
export const runningNowLine = (running: number, field: CapEntry, saved: number): string => `Now: ${running} of ${capOf(field) ?? saved} running.`;

/** A fresh quick action: an id no other row has. */
export function newQuickAction(existing: readonly OverseerQuickAction[]): OverseerQuickAction {
  let n = existing.length + 1;
  const ids = new Set(existing.map((a) => a.id));
  while (ids.has(`custom-${n}`)) n++;
  return { id: `custom-${n}`, label: "", description: "", prompt: "" };
}

/** Moves row `i` by `delta` (−1 up, +1 down); out of range changes nothing. */
export function moveQuickAction<T>(list: readonly T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Claude Opus 5 — never offered for the explorer (plain or `[1m]`, bare or as a pi ref's id);
    Opus 5.5 (`claude-opus-5-5`) is a different id and stays. */
export const NEVER_EXPLORER_MODEL = /(^|\/)claude-opus-5(\[1m\])?$/;

/**
 * The exploratory agent row's model lists: Delegate's (for Claude Code, Sova's Claude catalog), minus
 * Claude Opus 5, plus the shipped default should a list not have it, offered with every effort its
 * backend takes. A backend that couldn't list its models stays unlisted (null).
 */
export function explorerOptions(options: DelegateOptions | undefined, info: BackendsInfo, shipped: WorkerChoice): DelegateOptions | undefined {
  if (!options) return undefined;
  return {
    backends: options.backends.map((b) => {
      if (b.models === null) return b;
      const models = b.models.filter((m) => !NEVER_EXPLORER_MODEL.test(m.id));
      if (b.id === shipped.backend && !models.some((m) => m.id === shipped.model))
        models.unshift({ id: shipped.model, name: shipped.model, efforts: info.backends.find((x) => x.id === b.id)?.efforts ?? [shipped.effort] });
      return { ...b, models };
    }),
  };
}
