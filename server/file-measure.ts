// What a file costs: its size on disk, its lines, and pi's estimate of what its text costs a model; and
// a skill's listing, the part of it every chat it is offered to carries. Pure but for reading the file, and
// importing nothing of Sova's but the protocol's constant, so any module can size a file without a load cycle.

import { readFileSync } from "node:fs";
import { CHARS_PER_TOKEN } from "../shared/protocol";

/** Lines in a buffer, counted the way `wc -l` counts them: the newlines, plus one for a last line
    the file never terminated. An empty file has none. */
export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let newlines = 0;
  for (const byte of buf) if (byte === 10) newlines++;
  return buf[buf.length - 1] === 10 ? newlines : newlines + 1;
}

/** pi's own estimate of what a text costs a model: `pi-ai`'s `estimateTextTokens`, ceil(code units /
    CHARS_PER_TOKEN) — `text.length`, UTF-16 code units, the same count pi makes (an emoji is 2). Sova never tokenizes — a real count belongs to the model, and this is the number
    pi itself budgets a prompt with, so the card can say what a file costs before it is sent. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The text pi lists one offered skill with (pi formatSkillsForPrompt): its name, description and location.
    What every chat offered the skill carries before it uses it; its SKILL.md loads only when it is used. */
export const skillListing = (name: string, description: string | undefined, path: string): string =>
  `  <skill>\n    <name>${name}</name>\n    <description>${description ?? ""}</description>\n    <location>${path}</location>\n  </skill>`;

/** ≈ tokens of one skill's listing (skillListing). */
export const skillListingTokens = (name: string, description: string | undefined, path: string): number =>
  estimateTokens(skillListing(name, description, path));

/** A file's size on disk and what its text would cost. null when it can't be read at all — gone
    since the caller listed it, a directory, a permission bit: the row is dropped rather than
    reported as an empty file. */
export function measureFile(path: string): { bytes: number; lines: number; tokens: number } | null {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  // Decoded once, for the estimate: pi counts the characters of the text it reads, not the bytes
  // on disk, and the two differ for anything that isn't ASCII.
  return { bytes: buf.length, lines: countLines(buf), tokens: estimateTokens(buf.toString("utf8")) };
}
