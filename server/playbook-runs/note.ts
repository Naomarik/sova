// What a chat is told, in its own context and never in the thread, while it shows a playbook card not yet started:
// which card, the choices worked out with it that are still empty, everything else it may set on the card, and the
// command that sets it (playbook.run.edit). The text changes as the card does, so it's told again; nothing once the
// card is closed or started.
import { alignMessage } from "./align-first";
import { loadPlaybook, SOVA_SCRIPT } from "./env";
import { effectiveEdits, flatSteps } from "./plan";
import { membersOf } from "../../shared/playbook-format";
import { runsOfChat, type PlaybookRunRecord } from "./store";

/** customType of the hidden note (server/project-services/note.ts noteMessage: display false). */
export const PLAYBOOK_CARD_NOTE = "sova-playbook-card-note";

const empty = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** The note for one card while it's a draft: what of it the chat works out, what it may set, and how; null otherwise. */
export async function cardNoteOf(r: PlaybookRunRecord, script: string = SOVA_SCRIPT): Promise<string | null> {
  if (r.state !== "draft" || r.closed) return null;
  const loaded = await loadPlaybook(r.playbook, r.cwd).catch(() => null);
  if (!loaded?.spec) return null;
  const spec = loaded.spec;
  if (r.aligning) return alignMessage(r, spec);
  const edits = effectiveEdits(r);
  const worked = spec.inputs.filter((i) => i.ask === "chat");
  const open = worked.filter((i) => empty(edits.choices?.[i.id]));
  const lines = [`This chat shows the card of the playbook "${r.playbook.title}" (run ${r.id}), not started.`];
  if (open.length) {
    lines.push(
      "These of its choices are worked out with you, and the card shows them read-only until you fill them:",
      ...open.map((i) => `- ${i.label} [${i.id}], ${i.type === "list" ? "a list of lines" : i.type === "text" && i.multiline ? "text, several lines" : "text"}${i.required ? ", required before Start" : ", optional"}${i.help ? `: ${i.help}` : ""}`),
      "Fill each choice marked as worked out with you from what the person asked. If the request is ambiguous about one of them and align mode is on, you may open an alignment first and fill the choices from what it decides; otherwise fill them, or ask in a line.",
    );
  } else if (worked.length) lines.push("Every choice worked out with you is filled now.");
  lines.push(
    "Put everything the person said when asking onto the card itself, through the card's commands: the choices worked out with you, and any model, effort, count, optional member, stop or cycle setting they named (\"on GLM\", \"three cycles\", \"no grader\"), so they needn't touch it. Keep a member's model within its own list (or any model Settings → Models allows, unless it's 'only these models'). Start, Save as My Defaults and Close Card are the person's own clicks: ask them.",
    "What you can set on it:",
    `- choices: ${spec.inputs.map((i) => `${i.id} (${i.type})`).join(", ") || "none"}`,
  );
  const members = membersOf(spec);
  if (members.length) lines.push(`- members (model and effort, a note, on/off if optional): ${members.map((m) => `${m.id}${m.only ? ` (only: ${m.models.map((x) => x.ref).join(", ")})` : m.models.length ? ` (list: ${m.models.map((x) => x.ref).join(", ")})` : ""}${m.optional ? ", optional" : ""}`).join("; ")}`);
  if (spec.teams.length) lines.push(`- team notes: ${spec.teams.map((t) => t.id).join(", ")}`);
  const stops = flatSteps(spec.steps).filter(({ step }) => step.stop === "optional").map(({ step }) => step.id);
  if (stops.length) lines.push(`- optional stops (on or off): ${stops.join(", ")}`);
  if (spec.steps.some((x) => x.kind === "cycle")) lines.push("- the cycle: max, askEvery, until (\"rule\" or \"max\")");
  lines.push(
    `To set them: read the card's revision with \`node ${script} run playbook.run.get --run ${r.id}\`, then \`node ${script} run playbook.run.edit --run ${r.id} --json '{"revision": <its revision>, "edits": {…}}'\`, where edits takes any of "choices": {"<choice id>": <value>} (a string for text, an array of strings for a list), "roles": {"<member id>": {"pick": {"model": "provider/id", "effort": "low"}, "on": true, "note": "…"}}, "teams": {"<team id>": {"note": "…"}}, "stops": {"<step id>": true}, "cycle": {"max": 3, "askEvery": 1, "until": "rule"}. Notes are one line. A stale revision is refused with the card as it is now: read it again and retry.`,
  );
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
