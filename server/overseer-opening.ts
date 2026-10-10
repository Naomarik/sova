import { createHash } from "node:crypto";
import type { HEntry } from "../shared/harness";
import { CARDS_NOTE_MESSAGE } from "../shared/overseer-card";

/**
 * An overseer's prompt fixed at opening (§app.overseer/hosting, §app.project-overseer/identity): the
 * global Overseer's and each project overseer's system prompt is rendered from the values as they
 * were when the conversation opened, and stays byte for byte the same for the whole conversation,
 * so a provider's prompt cache holds and a Claude Code CLI never restarts for it. What can change
 * while it runs (the live parts: notes, ideas, limits, level, …) is told in the hidden run note
 * instead, once per change.
 *
 * Both are kept in the run notes' details (the hidden `CARDS_NOTE_MESSAGE` message every run a
 * message starts carries): the first note of a conversation records `opening`, the values the
 * prompt is rendered from, so a restarted server renders the same prompt; each note records `told`,
 * a fingerprint of each live part as the overseer was last told it. Pure.
 */

/** A part of the prompt that can change while the overseer runs. */
export interface LivePart {
  /** Its placeholder or section key (`NOTES`, `CAPS`, `section:# Roster`, …). */
  key: string;
  /** What the run note calls it ("Your standing notes"). */
  title: string;
  /** Its current text, as the prompt would put it in. */
  text: string;
}

/** What the run note's details carry for this (beside the global note's `cleared`). */
export interface OpeningDetails {
  /** The values the prompt is rendered from: every placeholder's, `NOW` included. On the first note. */
  opening?: Record<string, string>;
  /** Each live part's fingerprint as told (the opening's, or a note's `[changed]`). */
  told?: Record<string, string>;
}

export const partPrint = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

const isStrings = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === "string");

function notes(branch: readonly HEntry[]): { details: OpeningDetails; at: number }[] {
  const out: { details: OpeningDetails; at: number }[] = [];
  branch.forEach((e, at) => {
    if (e.kind !== "note" || e.inMessage || e.noteType !== CARDS_NOTE_MESSAGE) return;
    const d = e.details as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object") return;
    out.push({ details: { ...(isStrings(d.opening) ? { opening: d.opening } : {}), ...(isStrings(d.told) ? { told: d.told } : {}) }, at });
  });
  return out;
}

/** The opening values on a branch: the first run note's that carries them, or undefined (a new
    conversation, or one opened before the prompt was fixed). */
export function openingOn(branch: readonly HEntry[]): Record<string, string> | undefined {
  return notes(branch).find((n) => n.details.opening)?.details.opening;
}

/**
 * What the overseer was last told of each live part: the prompt's opening text, then, for each part,
 * the newest note since the last compaction that told it (a compaction summarizes older notes away,
 * so what they told counts as untold and the prompt's opening text stands again).
 */
export function toldOn(branch: readonly HEntry[], openingParts: readonly LivePart[]): Record<string, string> {
  const told: Record<string, string> = Object.fromEntries(openingParts.map((p) => [p.key, partPrint(p.text)]));
  let since = 0;
  branch.forEach((e, at) => { if (e.kind === "compaction") since = at; });
  for (const n of notes(branch)) if (n.at > since && n.details.told) Object.assign(told, n.details.told);
  return told;
}

/**
 * The run note's `[changed]` part: every live part whose current text differs from what was last
 * told, whole, saying it replaces that part of the system prompt; and the fingerprints to record.
 * Undefined text when nothing changed.
 */
export function changedText(current: readonly LivePart[], told: Readonly<Record<string, string>>): { text?: string; told: Record<string, string> } {
  const out: Record<string, string> = {};
  const parts: string[] = [];
  for (const p of current) {
    const print = partPrint(p.text);
    if (told[p.key] === print) continue;
    out[p.key] = print;
    parts.push(`## ${p.title} (now)\n\n${p.text.trim() ? p.text : "(now empty)"}`);
  }
  // A part the prompt has that is gone now (an organization's section after a detach).
  for (const key of Object.keys(told)) {
    if (current.some((p) => p.key === key) || told[key] === partPrint("")) continue;
    out[key] = partPrint("");
    parts.push(`## ${key.startsWith("section:") ? key.slice("section:".length).replace(/^#+\s*/, "") : key} (now)\n\n(removed: disregard that part of your system prompt)`);
  }
  if (!parts.length) return { told: out };
  return {
    text: ["[changed] Parts of your system prompt changed since it was written. Each part below replaces the part of the same name there:", ...parts].join("\n\n"),
    told: out,
  };
}
