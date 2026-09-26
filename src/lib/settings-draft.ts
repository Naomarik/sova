import { createSignal, untrack, type Accessor } from "solid-js";
import { SETTINGS_TABS, type SettingsTab } from "./settings-nav";

/**
 * A Settings form's unsaved edits: what the server has (`saved`) and what the form shows (`draft`).
 * Module state, not the section's, because a section unmounts with its tab: switching to another
 * tab and back must not throw the edit away. The dialog asks before closing over a dirty draft
 * (every store made here joins the registry it asks), and forgets every draft once closed, so a
 * reopened dialog starts from what's saved. Saving is explicit and the dialog's: its footer's Save
 * Changes writes every dirty form on every tab (`saveAllDrafts`), so each store carries its own
 * save, its validity check and what its last save said — none of it can live in a section that
 * may not be mounted.
 */
export interface DraftStore<D, S, R = S> {
  draft: Accessor<D | null>;
  saved: Accessor<S | null>;
  /** An edit. It also clears the form's last save error: the user is acting on it. */
  setDraft(next: D | null): void;
  /**
   * What the server has now. The first load seeds the draft. A kept draft stays as it is, or, for a
   * store with `rebase`, is rebased onto it: the user's edits stay and every field they left alone
   * follows the server. `replaceDraft` (after a save) makes the draft the saved copy. Untracked: it
   * runs inside a section's load effect, and a draft read there would re-run that effect when the
   * dialog closes and re-seed a stale draft from the old load.
   */
  setSaved(settings: S, opts?: { replaceDraft?: boolean }): void;
  /**
   * A save landed with `settings`: the draft becomes the saved copy, unless the dialog was closed
   * (the drafts forgotten) while the save was in flight — then nothing is re-seeded.
   */
  acceptSave(settings: S): void;
  /**
   * The server has `settings` now, read outside a load (after a failed save): like `setSaved`, but
   * a forgotten draft stays forgotten.
   */
  refreshSaved(settings: S): void;
  /** Edits nobody has saved yet. */
  dirty(): boolean;
  /** Why the draft can't be saved, one sentence naming the form, or null. Tracked. */
  problem(): string | null;
  /** Discard Changes: the draft goes back to what's saved, and the last save error goes with it. */
  discard(): void;
  /** The dialog closed: drop both, and what the last save said, so the next open reads the server afresh. */
  reset(): void;
  /**
   * Save Changes for this form: write the draft, an edit of `saved`. "skipped" when there is
   * nothing to write, the draft is invalid, or a save of this form is still in flight (one write
   * at a time per form, even across a close and reopen of the dialog).
   */
  save(): Promise<SaveStatus>;
  /** A save of this form is in flight: its controls wait. */
  saving: Accessor<boolean>;
  /** Why the last save failed, until the user edits, discards, or saves again. */
  error: Accessor<SaveFailure | null>;
  /** What the last successful save's server said about it ("Saved, with notes."). */
  warnings: Accessor<string[]>;
  /** The last successful save's full response, for a mounted section to show (`null` until one). */
  result: Accessor<R | null>;
}

export type SaveStatus = "saved" | "failed" | "skipped";

/** A failed save, as its form's banner says it. `partial`: some of it was written. */
export interface SaveFailure {
  message: string;
  partial: boolean;
}

/** A save's `write` throws this to say part of the save landed before it failed. */
export class SaveFailed extends Error {
  constructor(
    message: string,
    readonly partial = false,
  ) {
    super(message);
  }
}

/** An error as a form's banner quotes it: its message, without a closing period (the banner adds its own). */
export const failureOf = (err: unknown): SaveFailure => ({
  message: (err instanceof Error ? err.message : String(err)).replace(/\.$/, ""),
  partial: err instanceof SaveFailed && err.partial,
});

export interface DraftStoreOptions<D, S, R = S> {
  /** The tab the form is on: the close-hold and a failed save bring the dialog there. */
  tab: SettingsTab;
  /** The form's name in the footer and the close-hold: "Unsaved: {label}". */
  label: string;
  /** A fresh draft of what's saved (a copy: the draft is edited, the saved copy never is). */
  toDraft(settings: S): D;
  /** Whether the draft says what `settings` says. */
  same(draft: D, settings: S): boolean;
  /** `draft` was an edit of `base`; the server now has `fresh`. Pure. */
  rebase?(draft: D, base: S, fresh: S): D;
  /**
   * Why `draft` can't be saved: one sentence that names the form, for the dialog's footer (the
   * form's own fields say it inline too), or null. Save Changes waits for every dirty form's null.
   */
  problem?(draft: D, saved: S): string | null;
  /**
   * Write `draft`, an edit of `base`, and resolve with what the server has now (`saved`), any notes
   * it made, and the whole response (`result`) for a mounted section. Throw to fail; a `SaveFailed`
   * with `partial` says part of it landed.
   */
  write?(draft: D, base: S): Promise<{ saved: S; warnings?: string[]; result: R }>;
  /** The dialog closed: anything else the module keeps about its last save is forgotten too. */
  onReset?(): void;
}

/** One Save-gated form, as the dialog's footer and close-hold see it. */
export interface GatedForm {
  tab: SettingsTab;
  label: string;
  dirty(): boolean;
  problem(): string | null;
  saving(): boolean;
  error(): SaveFailure | null;
  save(): Promise<SaveStatus>;
  discard(): void;
  reset(): void;
}

const registry: GatedForm[] = [];

/** Every Save-gated form, in rail order (then by name within a tab: Delegate before Spec). */
export function gatedForms(): readonly GatedForm[] {
  const at = (t: SettingsTab) => SETTINGS_TABS.indexOf(t);
  return [...registry].sort((a, b) => at(a.tab) - at(b.tab) || a.label.localeCompare(b.label));
}

/** The forms holding unsaved edits, in rail order. */
export const dirtyForms = (): GatedForm[] => gatedForms().filter((f) => f.dirty());

/** Dirty forms that can't be saved as they are: Save Changes waits for them. */
export const invalidForms = (): GatedForm[] => dirtyForms().filter((f) => f.problem() !== null);

/** Forms whose last save failed, in rail order. */
export const failedForms = (): GatedForm[] => gatedForms().filter((f) => f.error() !== null);

/** Some form's save is in flight. */
export const savingAny = (): boolean => registry.some((f) => f.saving());

/** "Delegate", "Models and Decisions", "Models, Spec and Mesh". */
export function formNames(forms: readonly Pick<GatedForm, "label">[]): string {
  const names = forms.map((f) => f.label);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/**
 * Save Changes: every dirty form on every tab, at once — each form writes its own file, and each
 * keeps its own rebase-on-a-fresh-read. Nothing is written while any dirty form is invalid or a
 * save is still in flight. A failure stops only its own form: the others' saves stand.
 */
export async function saveAllDrafts(): Promise<{ saved: GatedForm[]; failed: GatedForm[] }> {
  const forms = dirtyForms();
  if (forms.length === 0 || forms.some((f) => f.problem() !== null) || savingAny()) return { saved: [], failed: [] };
  const done = await Promise.all(forms.map(async (f) => ({ f, status: await f.save() })));
  return {
    saved: done.filter((d) => d.status === "saved").map((d) => d.f),
    failed: done.filter((d) => d.status === "failed").map((d) => d.f),
  };
}

/** Discard Changes: every form on every tab goes back to what's saved. */
export function discardAllDrafts(): void {
  for (const f of registry) f.discard();
}

/** The dialog closed: every form forgets its draft. */
export function resetAllDrafts(): void {
  for (const f of registry) f.reset();
}

/**
 * The footer's status line, first match wins: a save in flight; the first invalid dirty form's
 * problem (Save waits for it); a save that failed ("Saved Models; Delegate failed."); what is
 * unsaved; what the last save wrote. Empty when there is nothing to say. Pure.
 */
export function footerStatus(s: {
  saving: boolean;
  dirty: readonly Pick<GatedForm, "label">[];
  problem: string | null;
  failed: readonly Pick<GatedForm, "label">[];
  lastSaved: readonly Pick<GatedForm, "label">[];
}): string {
  if (s.saving) return "Saving…";
  if (s.problem) return s.problem;
  if (s.failed.length > 0) return `${s.lastSaved.length > 0 ? `Saved ${formNames(s.lastSaved)}; ` : ""}${formNames(s.failed)} failed.`;
  if (s.dirty.length > 0) return `Unsaved: ${s.dirty.map((f) => f.label).join(", ")}`;
  if (s.lastSaved.length > 0) return `Saved ${formNames(s.lastSaved)}.`;
  return "";
}

export function createDraftStore<D, S, R = S>(opts: DraftStoreOptions<D, S, R>): DraftStore<D, S, R> {
  const [draft, setDraft] = createSignal<D | null>(null);
  const [saved, setSaved] = createSignal<S | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<SaveFailure | null>(null);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [result, setResult] = createSignal<R | null>(null);
  /** Bumped by `reset`: a save that started before the dialog closed reports nothing after it. */
  let generation = 0;

  const store: DraftStore<D, S, R> = {
    draft,
    saved,
    saving,
    error,
    warnings,
    result,
    setDraft(next) {
      setError(null);
      setDraft(() => next);
    },
    setSaved(settings, { replaceDraft = false } = {}) {
      untrack(() => {
        const cur = draft();
        const base = saved();
        if (replaceDraft || cur === null) setDraft(() => opts.toDraft(settings));
        else if (opts.rebase && base !== null) setDraft(() => opts.rebase!(cur, base, settings));
        setSaved(() => settings);
      });
    },
    acceptSave(settings) {
      if (untrack(draft) === null) return;
      store.setSaved(settings, { replaceDraft: true });
    },
    refreshSaved(settings) {
      if (untrack(draft) === null) return;
      store.setSaved(settings);
    },
    dirty() {
      const d = draft();
      const s = saved();
      return d !== null && s !== null && !opts.same(d, s);
    },
    problem() {
      const d = draft();
      const s = saved();
      return d !== null && s !== null && opts.problem ? opts.problem(d, s) : null;
    },
    discard() {
      setError(null);
      const s = untrack(saved);
      if (s !== null) setDraft(() => opts.toDraft(s));
    },
    reset() {
      generation++;
      setDraft(null);
      setSaved(null);
      setError(null);
      setWarnings([]);
      setResult(null);
      opts.onReset?.();
    },
    async save() {
      const d = untrack(draft);
      const base = untrack(saved);
      if (!opts.write || d === null || base === null || untrack(saving) || opts.same(d, base) || opts.problem?.(d, base)) return "skipped";
      const gen = generation;
      setSaving(true);
      setError(null);
      try {
        const out = await opts.write(d, base);
        if (gen !== generation) return "saved";
        store.acceptSave(out.saved);
        setWarnings(out.warnings ?? []);
        setResult(() => out.result);
        return "saved";
      } catch (err) {
        if (gen === generation) setError(failureOf(err));
        return "failed";
      } finally {
        setSaving(false);
      }
    },
  };
  registry.push({
    tab: opts.tab,
    label: opts.label,
    dirty: store.dirty,
    problem: store.problem,
    saving: store.saving,
    error: store.error,
    save: store.save,
    discard: store.discard,
    reset: store.reset,
  });
  return store;
}

/**
 * Save a rebasing form: read the server afresh, rebase the draft (an edit of `base`) onto that read,
 * and write it — unless the result is what the server already has, which writes nothing. So a field
 * the user left alone is written with what the server holds NOW (a TUI edit, a peer's sync), never
 * with the form's older copy. `settingsOf` picks the saved settings out of a read.
 */
export async function saveRebased<D, S, R>(
  draft: D,
  base: S,
  io: {
    read(): Promise<R>;
    settingsOf(read: R): S;
    rebase(draft: D, base: S, fresh: S): D;
    same(draft: D, settings: S): boolean;
    write(draft: D): Promise<R>;
  },
): Promise<{ result: R; wrote: boolean }> {
  const fresh = await io.read();
  const next = io.rebase(draft, base, io.settingsOf(fresh));
  if (io.same(next, io.settingsOf(fresh))) return { result: fresh, wrote: false };
  return { result: await io.write(next), wrote: true };
}
