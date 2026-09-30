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

export const cloneOverseer = (d: OverseerDraft): OverseerDraft => ({
  settings: {
    ...d.settings,
    quickActions: d.settings.quickActions.map((a) => ({ ...a })),
    caps: { ...d.settings.caps },
    explorer: { ...d.settings.explorer },
  },
  notes: d.notes,
});

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

/** Every field, the notes included: a field added to OverseerSettings later is compared too. */
export const sameOverseer = (a: OverseerDraft, b: OverseerDraft): boolean => sameValue(a, b);

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
export function rebaseOverseer(draft: OverseerDraft, base: OverseerDraft, fresh: OverseerDraft): OverseerDraft {
  const pick = <T>(mine: T, was: T, now: T): T => (sameValue(mine, was) ? now : mine);
  const settings = { ...fresh.settings } as Record<string, unknown>;
  const d = draft.settings as unknown as Record<string, unknown>;
  const b = base.settings as unknown as Record<string, unknown>;
  const f = fresh.settings as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(f), ...Object.keys(d)])) {
    if (k === "caps") continue;
    settings[k] = pick(d[k], b[k], f[k]);
  }
  const caps = { ...fresh.settings.caps };
  for (const k of Object.keys(caps) as (keyof OverseerCaps)[]) caps[k] = pick(draft.settings.caps[k], base.settings.caps[k], fresh.settings.caps[k]);
  settings.caps = caps;
  return cloneOverseer({ settings: settings as unknown as OverseerSettings, notes: mergeNotes(draft.notes, base.notes, fresh.notes) ?? draft.notes });
}

/** The Overseer rewrote its notes (sova_note replace) while the user edited them: nothing merges. */
export class NotesConflict extends Error {
  constructor() {
    super("The standing notes changed while you were editing them");
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
  const [info, notes] = await Promise.all([io.getSettings(), io.getNotes()]);
  if (mergeNotes(draft.notes, base.notes, notes) === null) throw new NotesConflict();
  const next = rebaseOverseer(draft, base, { settings: info.settings, notes });
  const result = sameValue(next.settings, info.settings) ? { ...info, warnings: [] } : await io.putSettings(next.settings);
  const savedNotes = next.notes === notes ? notes : await io.putNotes(next.notes, notes);
  return { result, notes: savedNotes };
}

/** What the app's save reads and writes: the server, through src/lib/api.ts. */
const serverIO: OverseerSaveIO = {
  getSettings: getOverseerSettings,
  getNotes: () => getOverseerNotes().then((n) => n.text),
  putSettings: putOverseerSettings,
  putNotes: (text, was) => putOverseerNotes(text, was).then((n) => n.text),
};

export const NOTES_CONFLICT_MESSAGE =
  "The Overseer rewrote its standing notes while you were editing them, so your notes weren't saved. Your edit is still in the box: Save Changes again replaces the Overseer's version, and Discard Changes shows it";

const store = createDraftStore<OverseerDraft, OverseerDraft, OverseerSaveResult>({
  tab: "overseer",
  label: "Overseer",
  toDraft: cloneOverseer,
  same: sameOverseer,
  rebase: rebaseOverseer,
  problem: (d) => {
    const p = overseerDraftProblem(d);
    return p ? `Overseer: ${p}` : null;
  },
  write: async (cur, base) => {
    let wrote = false;
    try {
      const { result, notes } = await saveOverseerDraft(cur, base, {
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
      throw new SaveFailed(conflict ? NOTES_CONFLICT_MESSAGE : failureOf(err).message, wrote);
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
export const overseerSaveError = store.error;
export const overseerWarnings = store.warnings;
/** The dialog closed: drop the draft, so the next open reads the saved file afresh. */
export const resetOverseerDraft = store.reset;

export const CAP_KEYS = ["createPerTurn", "promptsPerTurn", "archivesPerTurn", "concurrentSessions", "explorePerTurn", "linksPerTurn", "orgWritesPerTurn", "gatherPerTurn"] as const satisfies readonly (keyof OverseerCaps)[];

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
};

/** The seven limits counted per message: the folded group under Running at once. */
export const PER_MESSAGE_CAP_KEYS = CAP_KEYS.filter((k) => k !== "concurrentSessions");

/** A limit the form can take: a whole number from 0 to 1000. */
export const capValid = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= 1000;

/** Where the draft's problem is, so the form can open the folded group that holds the field. */
export type OverseerIssueAt =
  | { group: "running" }
  | { group: "per-message"; key: keyof OverseerCaps }
  | { group: "quick-action"; index: number }
  | { group: "advanced" };

/** Why the draft can't be saved, one sentence, and where; null when it can. First match wins, in page order. */
export function overseerDraftIssue(d: OverseerDraft): { message: string; at: OverseerIssueAt } | null {
  for (const k of CAP_KEYS) {
    if (!capValid(d.settings.caps[k]))
      return { message: `${CAP_LABEL[k].label} must be a whole number from 0 to 1000.`, at: k === "concurrentSessions" ? { group: "running" } : { group: "per-message", key: k } };
  }
  const blank = d.settings.quickActions.findIndex((a) => !a.label.trim() || !a.prompt.trim());
  if (blank >= 0) return { message: `Quick action ${blank + 1} needs a label and a prompt.`, at: { group: "quick-action", index: blank } };
  if (!d.settings.explorer.model || !d.settings.explorer.effort) return { message: "The idea explorer needs a model and an effort.", at: { group: "advanced" } };
  return null;
}

/** Why the draft can't be saved, one sentence, or null. */
export const overseerDraftProblem = (d: OverseerDraft): string | null => overseerDraftIssue(d)?.message ?? null;

/** How many of the per-message limits differ from their defaults (a cleared field counts). */
export function capsChangedFromDefault(caps: OverseerCaps, defaults: OverseerCaps): number {
  return PER_MESSAGE_CAP_KEYS.filter((k) => !Object.is(caps[k], defaults[k])).length;
}

/** The folded Per-message limits group's head: "All at default", "2 changed from default". */
export const perMessageSummary = (changed: number): string => (changed === 0 ? "All at default" : `${changed} changed from default`);

/** Running at once's live line: the count now, of the number in the field, or of the saved limit
    while the field doesn't hold a valid one. */
export const runningNowLine = (running: number, field: number, saved: number): string => `Now: ${running} of ${capValid(field) ? field : saved} running.`;

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

/** Claude Opus 5 — never offered for the explorer (plain or `[1m]`, bare or as a pi ref's id). "Opus"
    means Opus 5.5 (`opus`, `opus[1m]`); `claude-opus-5-5` is a different id and stays. */
export const NEVER_EXPLORER_MODEL = /(^|\/)claude-opus-5(\[1m\])?$/;

/**
 * The exploratory agent row's model lists: Delegate's discovery, minus Claude Opus 5, plus the
 * shipped default when discovery didn't list it. The Claude Code CLI's list is remote and
 * alternates between shapes with and without the `[1m]` aliases, so the out-of-the-box choice
 * would otherwise read "not verified" on a fresh install, although it launches. It is offered with
 * every effort its backend takes. A backend that couldn't list its models stays unlisted (null).
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
