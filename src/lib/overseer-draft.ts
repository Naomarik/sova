import { createSignal, untrack } from "solid-js";
import type { OverseerCaps, OverseerQuickAction, OverseerSaveResult, OverseerSettings, OverseerSettingsInfo } from "../../shared/protocol";

/**
 * Settings → Overseer's unsaved edits: the settings file and the standing notes, edited together
 * and saved by one button. Module state, like Delegate's and Spec's drafts: the section unmounts
 * with its tab, and switching tabs must not throw the edit away. The dialog asks before closing
 * over a dirty draft, and forgets it once closed.
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

const [draft, setDraft] = createSignal<OverseerDraft | null>(null);
const [saved, setSaved] = createSignal<OverseerDraft | null>(null);

export const overseerDraft = draft;
export const overseerSaved = saved;

export const cloneOverseer = (d: OverseerDraft): OverseerDraft => ({
  settings: {
    ...d.settings,
    quickActions: d.settings.quickActions.map((a) => ({ ...a })),
    caps: { ...d.settings.caps },
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

export function setOverseerDraft(next: OverseerDraft | null): void {
  setDraft(next);
}

/**
 * What the server has now. The first load seeds the draft; a kept draft is rebased onto it, so
 * the user's edits stay and everything else follows the file. `replaceDraft` (after a save) makes
 * the draft the saved copy. Untracked: it runs inside the section's load effect, and a draft read
 * there would re-run that effect when the dialog closes and re-seed a stale draft from the old load.
 */
export function setOverseerSaved(next: OverseerDraft, { replaceDraft = false } = {}): void {
  untrack(() => {
    const cur = draft();
    const base = saved();
    if (replaceDraft || cur === null || base === null) setDraft(cloneOverseer(next));
    else setDraft(rebaseOverseer(cur, base, next));
    setSaved(cloneOverseer(next));
  });
}

export const overseerDirty = (): boolean => {
  const d = draft();
  const s = saved();
  return !!d && !!s && !sameOverseer(d, s);
};

/** The dialog closed: drop the draft, so the next open reads the saved file afresh. */
export function resetOverseerDraft(): void {
  setDraft(null);
  setSaved(null);
}

export const CAP_KEYS = ["createPerTurn", "promptsPerTurn", "archivesPerTurn", "concurrentSessions"] as const satisfies readonly (keyof OverseerCaps)[];

export const CAP_LABEL: Record<keyof OverseerCaps, { label: string; hint: string }> = {
  createPerTurn: { label: "Sessions created", hint: "Per message you send." },
  promptsPerTurn: { label: "Prompts to other sessions", hint: "Per message you send." },
  archivesPerTurn: { label: "Sessions archived", hint: "Per message you send." },
  concurrentSessions: { label: "Running at once", hint: "Sessions the Overseer started that are working at the same time." },
};

/** Why the draft can't be saved, one sentence, or null. */
export function overseerDraftProblem(d: OverseerDraft): string | null {
  for (const k of CAP_KEYS) {
    const v = d.settings.caps[k];
    if (!Number.isInteger(v) || v < 0 || v > 1000) return `${CAP_LABEL[k].label} must be a whole number from 0 to 1000.`;
  }
  const blank = d.settings.quickActions.findIndex((a) => !a.label.trim() || !a.prompt.trim());
  if (blank >= 0) return `Quick action ${blank + 1} needs a label and a prompt.`;
  return null;
}

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
