import { createSignal, untrack, type Accessor } from "solid-js";
import { SETTINGS_TABS, type SettingsTab } from "./settings-nav";

/**
 * A Settings form's unsaved edits: what the server has (`saved`) and what the form shows (`draft`).
 * Module state, not the section's, because a section unmounts with its tab: switching to another
 * tab and back must not throw the edit away. The dialog asks before closing over a dirty draft
 * (every store made here joins the registry it asks), and forgets every draft once closed, so a
 * reopened dialog starts from what's saved. Saving is explicit: a form writes on Save Changes only.
 */
export interface DraftStore<D, S> {
  draft: Accessor<D | null>;
  saved: Accessor<S | null>;
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
  /** Edits nobody has saved yet. */
  dirty(): boolean;
  /** Discard Changes: the draft goes back to what's saved. */
  discard(): void;
  /** The dialog closed: drop both, so the next open reads the server afresh. */
  reset(): void;
}

export interface DraftStoreOptions<D, S> {
  /** The tab the form is on: the close-hold brings the dialog there. */
  tab: SettingsTab;
  /** The form's name in the close-hold: "Your {label} changes aren't saved." */
  label: string;
  /** A fresh draft of what's saved (a copy: the draft is edited, the saved copy never is). */
  toDraft(settings: S): D;
  /** Whether the draft says what `settings` says. */
  same(draft: D, settings: S): boolean;
  /** `draft` was an edit of `base`; the server now has `fresh`. Pure. */
  rebase?(draft: D, base: S, fresh: S): D;
}

/** One Save-gated form, as the dialog's close-hold sees it. */
export interface GatedForm {
  tab: SettingsTab;
  label: string;
  dirty(): boolean;
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

/** "Delegate", "Models and Decisions", "Models, Spec and Mesh". */
export function formNames(forms: readonly Pick<GatedForm, "label">[]): string {
  const names = forms.map((f) => f.label);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/** The dialog closed: every form forgets its draft. */
export function resetAllDrafts(): void {
  for (const f of registry) f.reset();
}

export function createDraftStore<D, S>(opts: DraftStoreOptions<D, S>): DraftStore<D, S> {
  const [draft, setDraft] = createSignal<D | null>(null);
  const [saved, setSaved] = createSignal<S | null>(null);

  const store: DraftStore<D, S> = {
    draft,
    saved,
    setDraft: (next) => void setDraft(() => next),
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
    dirty() {
      const d = draft();
      const s = saved();
      return d !== null && s !== null && !opts.same(d, s);
    },
    discard() {
      const s = untrack(saved);
      if (s !== null) setDraft(() => opts.toDraft(s));
    },
    reset() {
      setDraft(null);
      setSaved(null);
    },
  };
  registry.push({ tab: opts.tab, label: opts.label, dirty: store.dirty, reset: store.reset });
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
