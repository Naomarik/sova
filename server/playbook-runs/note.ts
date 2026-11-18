// What a chat is told, in its own context and never in the thread, while it shows a playbook card with a choice
// worked out with it still empty: which card, which choices, and the command that fills them (the card's own
// choices-fill route, playbook.run.edit). Gone once each such choice is filled or the card is closed or started.
import { alignMessage } from "./align-first";
import { loadPlaybook, SOVA_SCRIPT } from "./env";
import { effectiveEdits } from "./plan";
import { runsOfChat, type PlaybookRunRecord } from "./store";

/** customType of the hidden note (server/project-services/note.ts noteMessage: display false). */
export const PLAYBOOK_CARD_NOTE = "sova-playbook-card-note";

const empty = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** The note for one card: null when it has no empty choice the chat works out. Pure but for reading the playbook. */
export async function cardNoteOf(r: PlaybookRunRecord, script: string = SOVA_SCRIPT): Promise<string | null> {
  if (r.state !== "draft" || r.closed) return null;
  const loaded = await loadPlaybook(r.playbook, r.cwd).catch(() => null);
  if (!loaded?.spec) return null;
  if (r.aligning) return alignMessage(r, loaded.spec);
  const edits = effectiveEdits(r);
  const open = loaded.spec.inputs.filter((i) => i.ask === "chat" && empty(edits.choices?.[i.id]));
  if (!open.length) return null;
  const lines = [
    `This chat shows the card of the playbook "${r.playbook.title}" (run ${r.id}), not started. These of its choices are worked out with you, and the card shows them read-only until you fill them:`,
    ...open.map((i) => `- ${i.label} [${i.id}], ${i.type === "list" ? "a list of lines" : i.type === "text" && i.multiline ? "text, several lines" : "text"}${i.required ? ", required before Start" : ", optional"}${i.help ? `: ${i.help}` : ""}`),
    "Fill each choice marked as worked out with you from what the person asked. If the request is ambiguous about one of them and align mode is on, you may open an alignment first and fill the choices from what it decides; otherwise fill them, or ask in a line.",
    `To fill them: read the card's revision with \`node ${script} run playbook.run.get --run ${r.id}\`, then \`node ${script} run playbook.run.edit --run ${r.id} --json '{"revision": <its revision>, "edits": {"choices": {"<choice id>": <value>}}}'\` (a value is a string for text, an array of strings for a list). A stale revision is refused with the card as it is now: read it again and retry. Only the person presses Start.`,
  ];
  return lines.join("\n");
}

/** The note for a chat: every card it shows that waits on it, newest first; null when none does. */
export async function playbookCardNote(sessionId: string): Promise<string | null> {
  const notes: string[] = [];
  for (const r of runsOfChat(sessionId)) {
    const n = await cardNoteOf(r);
    if (n) notes.push(n);
  }
  return notes.length ? notes.join("\n\n") : null;
}
