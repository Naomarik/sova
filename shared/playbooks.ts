import type { PlaybookInfo } from "./protocol";

/**
 * What a playbook is sent as (§chat.playbooks/what-gets-sent), and the playbook a profile links
 * (§chat.profiles/playbook). Shared: the Playbooks dialog, the empty screen's Run Playbook and the
 * Overseer's sova_create_session all send through `playbookTurnText`. Imports nothing at runtime.
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

/** The order a profile's linked playbook is looked for in, after the profile's own source. */
const SOURCE_ORDER: readonly PlaybookInfo["source"][] = ["project", "user", "sova"];

/**
 * The playbook `id` a profile from `source` links, among the playbooks a session's folder lists:
 * the profile's own source first, then This project, Yours and Sova. Null: none has that id.
 */
export function linkedPlaybook(
  catalog: readonly PlaybookInfo[],
  id: string,
  source: "sova" | "user" | "project" | undefined,
): PlaybookInfo | null {
  const order = source ? [source, ...SOURCE_ORDER.filter((s) => s !== source)] : SOURCE_ORDER;
  for (const s of order) {
    const p = catalog.find((x) => x.source === s && x.id === id);
    if (p) return p;
  }
  return null;
}

/** The card's line for a linked playbook no listed playbook has. */
export const missingPlaybookText = (id: string) => `This profile runs the playbook "${id}", but this folder has no playbook with that id.`;
