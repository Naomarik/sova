// Exact find-and-replace over a text: a design session's page edits and the coordinator's Full Prompt edits.

export interface Edit {
  find: string;
  replace: string;
}

/** Apply a list of exact replacements, each of which must match exactly once. */
export function applyEdits(page: string, edits: Edit[]): { html: string } | { error: string } {
  let html = page;
  for (const [i, e] of edits.entries()) {
    if (typeof e?.find !== "string" || !e.find || typeof e.replace !== "string") return { error: `Edit ${i + 1} needs find and replace.` };
    const at = html.indexOf(e.find);
    if (at === -1) return { error: `Edit ${i + 1}: its find text is not in the page.` };
    if (html.indexOf(e.find, at + 1) !== -1) return { error: `Edit ${i + 1}: its find text is in the page more than once; make it longer.` };
    html = `${html.slice(0, at)}${e.replace}${html.slice(at + e.find.length)}`;
  }
  return { html };
}
