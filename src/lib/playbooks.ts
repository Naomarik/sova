import type { PlaybookCatalog, PlaybookInfo } from "../../shared/protocol";

/**
 * The Playbooks dialog's pure half (the composer "+" flyout → Playbooks): the turn a playbook is
 * sent as (re-exported from shared/playbooks.ts), the catalog cut into the dialog's three groups, and
 * the rules of Sova's folded section (when it opens by itself, and which rows the arrow keys reach).
 */

/** The turn a playbook is sent as: one function for the dialog, Run Playbook and the Overseer (shared/playbooks.ts). */
export { playbookTurnText } from "../../shared/playbooks";

export type PlaybookGroupKey = PlaybookInfo["source"];

export interface PlaybookGroup {
  key: PlaybookGroupKey;
  /** The group heading, as shown. */
  label: string;
  playbooks: PlaybookInfo[];
}

const GROUPS: readonly { key: PlaybookGroupKey; label: string }[] = [
  { key: "project", label: "This project" },
  { key: "user", label: "Yours" },
  { key: "sova", label: "Sova" },
];

const byTitle = (a: PlaybookInfo, b: PlaybookInfo) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

/** This project, Yours, Sova — in that order, each sorted by title, and only the ones with a row:
    an empty heading is a question with no answer. */
export function groupPlaybooks(catalog: Pick<PlaybookCatalog, "playbooks">): PlaybookGroup[] {
  return GROUPS.map(({ key, label }) => ({ key, label, playbooks: catalog.playbooks.filter((p) => p.source === key).sort(byTitle) })).filter(
    (g) => g.playbooks.length > 0,
  );
}

/** A stable key for a row: ids repeat across groups (a project playbook replaces nothing). */
export const playbookKey = (p: Pick<PlaybookInfo, "source" | "id">) => `${p.source}:${p.id}`;

/** The one group that folds: what Sova ships. Yours and This project are always open. */
export const FOLDED_GROUP: PlaybookGroupKey = "sova";

/** The key of the folded group's heading row in the focus order; no row key looks like it
    (a row key starts with its source). */
export const FOLD_TOGGLE_KEY = "fold:sova";

/**
 * Whether Sova's section is open when the list is first drawn: folded, unless nothing is listed above
 * it (no project playbooks, none of yours, or the project's couldn't be read — the dialog would be one
 * folded line), or `focus` (the playbook the list comes back to: a reopening's last one, or Back's) is
 * one of its rows. Nothing is remembered between openings: the user's own press decides after this.
 */
export function foldStartsOpen(groups: readonly PlaybookGroup[], focus: string | null): boolean {
  const folded = groups.find((g) => g.key === FOLDED_GROUP);
  if (!folded) return false;
  if (groups.every((g) => g.key === FOLDED_GROUP)) return true;
  return focus !== null && folded.playbooks.some((p) => playbookKey(p) === focus);
}

/** Step 1's focus order, as drawn: every row of the open groups, with Sova's heading row in its place,
    and Sova's rows only while it is open (a folded section's rows are skipped). */
export function playbookFocusOrder(groups: readonly PlaybookGroup[], open: boolean): string[] {
  return groups.flatMap((g) => {
    const rows = g.playbooks.map(playbookKey);
    if (g.key !== FOLDED_GROUP) return rows;
    return open ? [FOLD_TOGGLE_KEY, ...rows] : [FOLD_TOGGLE_KEY];
  });
}

/** Where focus lands when the list arrives: the first playbook drawn, never the heading row, unless
    the heading is all there is (the section folded by hand with nothing above it); -1 for no rows. */
export function firstPlaybookIndex(order: readonly string[]): number {
  const i = order.findIndex((k) => k !== FOLD_TOGGLE_KEY);
  return i >= 0 ? i : order.length > 0 ? 0 : -1;
}

/**
 * Why this project's playbooks aren't in the list, or null when there's nothing to say: `ok`
 * listed them (or there are none), and `none` means the dialog had no folder to ask about. The
 * server's own message wins — it names the target or the folder — and the fallback is only for a
 * server that sent none.
 */
export function projectNote(project: PlaybookCatalog["project"]): string | null {
  if (project.state === "remote") return project.message || "This session's files live on its target, so project playbooks aren't listed.";
  if (project.state === "missing") return project.message || "We couldn't read this session's folder, so project playbooks aren't listed.";
  return null;
}

/**
 * What the dialog holds unsent for one session: the text written for each playbook, under its
 * `playbookKey`, and which playbook was open last (where a reopening lands). Text belongs to the
 * playbook it was written for — picking another shows that one's own text, never this one's.
 */
export interface PlaybookDrafts {
  last: string | null;
  texts: Readonly<Record<string, string>>;
}

export const noPlaybookDrafts: PlaybookDrafts = { last: null, texts: {} };

/** The text written for `key`, or "" when there is none. */
export const playbookDraft = (drafts: PlaybookDrafts, key: string | null): string => (key ? (drafts.texts[key] ?? "") : "");

/** `key`'s text set to `text`; whitespace-only drops the entry. `key` becomes the last one open. */
export function setPlaybookDraft(drafts: PlaybookDrafts, key: string, text: string): PlaybookDrafts {
  const { [key]: _, ...rest } = drafts.texts;
  return { last: key, texts: text.trim() ? { ...rest, [key]: text } : rest };
}

/** `key` was sent: its entry goes, and so does "last" if it pointed there. Other playbooks keep theirs. */
export function sentPlaybookDraft(drafts: PlaybookDrafts, key: string): PlaybookDrafts {
  const { [key]: _, ...rest } = drafts.texts;
  return { last: drafts.last === key ? null : drafts.last, texts: rest };
}

/** Nothing worth keeping: no text for any playbook. */
export const playbookDraftsEmpty = (drafts: PlaybookDrafts) => Object.keys(drafts.texts).length === 0;
