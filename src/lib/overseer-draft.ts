import type { DelegateOptions, OverseerCaps, OverseerQuickAction, OverseerSaveResult, OverseerSettings, OverseerSettingsInfo, WorkerChoice } from "../../shared/protocol";
import { ApiError, getOverseerNotes, getOverseerSettings, putOverseerNotes, putOverseerSettings } from "./api";
import type { BackendsInfo } from "./delegate-form";
import { createDraftStore, failureOf, SaveFailed } from "./settings-draft";

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

/** What the form edits: the saved shape, but each limit is what its box holds. */
export interface OverseerForm {
  settings: Omit<OverseerSettings, "caps"> & { caps: FormCaps };
  notes: string;
}

// The server's limits (server/overseer-store.ts), checked by the form before anything is sent.
export const CAP_MAX = 1000;
export const QUICK_ACTIONS_MAX = 12;
export const QA_LABEL_MAX = 40;
export const QA_DESC_MAX = 120;
export const QA_PROMPT_MAX = 2000;
export const NOTES_MAX = 8000;
export const EXTRA_PROMPT_MAX = 8000;

/** The limits' shipped defaults (the server's DEFAULT_CAPS), for a limit the server didn't send. */
export const CAP_DEFAULTS: OverseerCaps = { createPerTurn: 5, promptsPerTurn: 10, archivesPerTurn: 50, concurrentSessions: 10, explorePerTurn: 2, linksPerTurn: 3, orgWritesPerTurn: 20, gatherPerTurn: 3, extRunsPerTurn: 5 };

/** A limit's value: a whole number from 0 to CAP_MAX, typed or stored; null when it isn't one. */
export function capOf(v: CapEntry | undefined): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= CAP_MAX ? v : null;
  if (typeof v !== "string" || !/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n <= CAP_MAX ? n : null;
}

/** Settings with every limit present: one missing (or not a number) takes `defaults`', else the form's own default. */
export function completeCaps(settings: OverseerSettings, defaults?: Partial<OverseerCaps>): OverseerSettings {
  const caps = { ...settings.caps };
  for (const k of CAP_KEYS) {
    if (typeof caps[k] === "number") continue;
    const d = defaults?.[k];
    caps[k] = typeof d === "number" ? d : CAP_DEFAULTS[k];
  }
  return { ...settings, caps };
}

/** The same, for a whole read of the settings: its defaults completed first. */
export function completeInfo<T extends { settings: OverseerSettings; defaults: { caps: OverseerCaps } }>(info: T): T {
  const defaults = completeCaps({ caps: info.defaults?.caps ?? {} } as OverseerSettings).caps;
  return { ...info, settings: completeCaps(info.settings, defaults), defaults: { ...info.defaults, caps: defaults } };
}

/** The form as a fresh copy of what's saved: each limit shown as text. */
export const toOverseerForm = (d: OverseerDraft): OverseerForm => {
  const c = cloneOverseer(d);
  const caps = {} as FormCaps;
  for (const [k, v] of Object.entries(c.settings.caps)) caps[k as keyof OverseerCaps] = String(v);
  return { ...c, settings: { ...c.settings, caps } };
};

/** The form as the saved shape: each limit its number (only for a form with no problem). */
export function formToDraft(f: OverseerForm): OverseerDraft {
  const c = cloneOverseer(f);
  const caps = {} as OverseerCaps;
  for (const [k, v] of Object.entries(c.settings.caps)) caps[k as keyof OverseerCaps] = capOf(v) ?? Number.NaN;
  return { ...c, settings: { ...c.settings, caps } };
}

/** Whether a box's entry says the same as a saved number (the number typed back, "5" for 5). */
const capSame = (a: CapEntry | undefined, b: CapEntry | undefined): boolean => {
  if (Object.is(a, b)) return true;
  const x = capOf(a);
  return x !== null && x === capOf(b);
};

/** A deep copy (works for the form as well as the saved shape). */
export function cloneOverseer<T extends OverseerDraft | OverseerForm>(d: T): T;
export function cloneOverseer(d: OverseerDraft | OverseerForm): OverseerDraft | OverseerForm {
  return {
  settings: {
    ...d.settings,
    quickActions: d.settings.quickActions.map((a) => ({ ...a })),
    caps: { ...d.settings.caps },
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
export function sameOverseer(a: OverseerDraft | OverseerForm, b: OverseerDraft | OverseerForm): boolean {
  const ca = a.settings.caps as Record<string, CapEntry>;
  const cb = b.settings.caps as Record<string, CapEntry>;
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  for (const k of keys) if (!capSame(ca[k], cb[k])) return false;
  return sameValue({ ...a, settings: { ...a.settings, caps: null } }, { ...b, settings: { ...b.settings, caps: null } });
}

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
  problem: (d) => {
    const p = overseerDraftProblem(d);
    return p ? `Overseer: ${p}` : null;
  },
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
export const acceptOverseerSave = (next: OverseerDraft): void => store.acceptSave(cloneOverseer(next));
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

export const CAP_KEYS = ["createPerTurn", "promptsPerTurn", "archivesPerTurn", "concurrentSessions", "explorePerTurn", "linksPerTurn", "orgWritesPerTurn", "gatherPerTurn", "extRunsPerTurn"] as const satisfies readonly (keyof OverseerCaps)[];

export const CAP_LABEL: Record<keyof OverseerCaps, { label: string; hint: string }> = {
  createPerTurn: { label: "Sessions created", hint: "New sessions it may create, per message you send." },
  promptsPerTurn: { label: "Prompts to other sessions", hint: "Messages it may send to other sessions, per message you send." },
  archivesPerTurn: { label: "Sessions archived", hint: "Sessions it may archive, per message you send." },
  concurrentSessions: {
    label: "Running at once",
    hint:
      "How many sessions the Overseer started or messaged may be working at the same time. Starting a session, or messaging one " +
      "that isn't already counted, needs a free slot; when none is free, the Overseer waits or asks you. Sessions you started " +
      "count only once the Overseer messages them.",
  },
  explorePerTurn: { label: "Ideas explored", hint: "Idea explorers it may launch, per message you send." },
  linksPerTurn: { label: "Links made", hint: "Sessions it may link across hosts, per message you send." },
  orgWritesPerTurn: { label: "Organization changes", hint: "Changes it may make to organizations, projects, rosters and project overseers, per message you send." },
  gatherPerTurn: { label: "Gathering sessions started", hint: "Gathering sessions and offers it may start, per message you send." },
  extRunsPerTurn: { label: "Extension commands run", hint: "Extension commands it may run, per message you send." },
};

/** The eight limits counted per message: the folded group under Running at once. */
export const PER_MESSAGE_CAP_KEYS = CAP_KEYS.filter((k) => k !== "concurrentSessions");

/** A limit the form can take: a whole number from 0 to 1000, typed or stored. */
export const capValid = (v: CapEntry): boolean => capOf(v) !== null;

/** "1,234": a count as the form shows it. */
const count = (n: number) => n.toLocaleString("en-US");

/** A long text box's count: "8,001 / 8,000". */
export const lengthCount = (text: string, max: number): string => `${count(text.length)} / ${count(max)}`;

/** Where the draft's problem is, so the form can open the folded group that holds the field. */
export type OverseerIssueAt =
  | { group: "running" }
  | { group: "per-message"; key: keyof OverseerCaps }
  | { group: "quick-action"; index: number }
  | { group: "notes" }
  | { group: "advanced" };

type AnyDraft = OverseerDraft | OverseerForm;

/** Why the quick action can't be saved, a sentence after "Quick action {n}", or null (the server's checks, trimmed as it trims). */
function quickActionIssue(a: OverseerQuickAction, n: number): string | null {
  const label = a.label.trim();
  const prompt = a.prompt.trim();
  if (!label || !prompt) return `Quick action ${n} needs a label and a prompt.`;
  if (label.length > QA_LABEL_MAX) return `Quick action ${n}'s label can be at most ${count(QA_LABEL_MAX)} characters.`;
  if (a.description.trim().length > QA_DESC_MAX) return `Quick action ${n}'s description can be at most ${count(QA_DESC_MAX)} characters.`;
  if (prompt.length > QA_PROMPT_MAX) return `Quick action ${n}'s prompt can be at most ${count(QA_PROMPT_MAX)} characters.`;
  return null;
}

/** Which of a quick action's fields are over the server's limit (each box goes red). */
export const quickActionTooLong = (a: OverseerQuickAction) => ({
  label: a.label.trim().length > QA_LABEL_MAX,
  description: a.description.trim().length > QA_DESC_MAX,
  prompt: a.prompt.trim().length > QA_PROMPT_MAX,
});

/** Add Quick Action stops at the most the server keeps. */
export const canAddQuickAction = (list: readonly OverseerQuickAction[]): boolean => list.length < QUICK_ACTIONS_MAX;

/**
 * Why the draft can't be saved, one sentence, and where; null when it can. First match wins, in
 * page order. Every limit the server's strict PUT checks is checked here first, so Save never
 * sends what the server refuses, and never writes the settings and then fails on the notes.
 */
export function overseerDraftIssue(d: AnyDraft): { message: string; at: OverseerIssueAt } | null {
  for (const k of CAP_KEYS) {
    if (!capValid((d.settings.caps as FormCaps)[k]))
      return { message: `${CAP_LABEL[k].label} must be a whole number from 0 to ${CAP_MAX}.`, at: k === "concurrentSessions" ? { group: "running" } : { group: "per-message", key: k } };
  }
  const actions = d.settings.quickActions;
  if (actions.length > QUICK_ACTIONS_MAX) return { message: `There can be at most ${QUICK_ACTIONS_MAX} quick actions.`, at: { group: "quick-action", index: QUICK_ACTIONS_MAX } };
  for (const [i, a] of actions.entries()) {
    const message = quickActionIssue(a, i + 1);
    if (message) return { message, at: { group: "quick-action", index: i } };
  }
  if (d.notes.length > NOTES_MAX) return { message: `Standing notes can be at most ${count(NOTES_MAX)} characters.`, at: { group: "notes" } };
  if (!d.settings.explorer.model || !d.settings.explorer.effort) return { message: "The idea explorer needs a model and an effort.", at: { group: "advanced" } };
  if (d.settings.extraSystemPrompt.length > EXTRA_PROMPT_MAX) return { message: `Extra instructions can be at most ${count(EXTRA_PROMPT_MAX)} characters.`, at: { group: "advanced" } };
  return null;
}

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
  return { ...cloneOverseer(d), settings: { ...cloneOverseer(d).settings, caps } };
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
    limits: CAP_KEYS.every((k) => capSame((d.settings.caps as FormCaps)[k], defaults.caps[k])),
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
