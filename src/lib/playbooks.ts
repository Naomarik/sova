import type { PlaybookCatalog, PlaybookInfo } from "../../shared/protocol";

/**
 * The Playbooks dialog's pure half (the composer "+" flyout → Playbooks): the turn a playbook is
 * sent as, and the catalog cut into the dialog's three groups.
 */

/**
 * The text a playbook is sent as, exactly:
 *
 *   Playbook: <title> — <absolute dir>
 *   Read the files in that directory as the playbook directs.
 *
 *   <body>
 *
 * and, when the user wrote something, `\n---\n\n<their text>\n` after it. The first line is
 * always plain prose, so the turn can never start with `/` and be taken for a command; it names
 * the ABSOLUTE directory because the body refers to its phases/ and templates/ by relative path,
 * and the session's cwd is a different folder. The body goes through verbatim — the SDK expands
 * prompt templates and skills on its way in, so anything that looks like one must arrive intact.
 * Blank or whitespace-only user text adds nothing: no separator, no filler.
 */
export function playbookTurnText(playbook: Pick<PlaybookInfo, "title" | "dir" | "body">, userText: string): string {
  const head = `Playbook: ${playbook.title} — ${playbook.dir}\nRead the files in that directory as the playbook directs.\n\n${playbook.body}`;
  const own = userText.trim();
  return own ? `${head}\n---\n\n${own}\n` : head;
}

export type PlaybookGroupKey = PlaybookInfo["source"];

export interface PlaybookGroup {
  key: PlaybookGroupKey;
  /** The group heading, as shown. */
  label: string;
  playbooks: PlaybookInfo[];
}

const GROUPS: readonly { key: PlaybookGroupKey; label: string }[] = [
  { key: "sova", label: "Sova" },
  { key: "user", label: "Yours" },
  { key: "project", label: "This project" },
];

const byTitle = (a: PlaybookInfo, b: PlaybookInfo) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

/** Sova, Yours, This project — in that order, each sorted by title, and only the ones with a row:
    an empty heading is a question with no answer. */
export function groupPlaybooks(catalog: Pick<PlaybookCatalog, "playbooks">): PlaybookGroup[] {
  return GROUPS.map(({ key, label }) => ({ key, label, playbooks: catalog.playbooks.filter((p) => p.source === key).sort(byTitle) })).filter(
    (g) => g.playbooks.length > 0,
  );
}

/** A stable key for a row: ids repeat across groups (a project playbook replaces nothing). */
export const playbookKey = (p: Pick<PlaybookInfo, "source" | "id">) => `${p.source}:${p.id}`;

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
