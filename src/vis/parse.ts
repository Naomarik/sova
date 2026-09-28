/**
 * The entry for `vis` fences: the info string's kind word → that kind's parser (registry.ts).
 * Never throws: a parse error comes back with its 1-based body line (0 = the fence as a whole) and a
 * message that says what to write instead. markdown.ts renders an error as the plain code block
 * plus one line; a success becomes a placeholder the Markdown component mounts the kind's View into.
 */

import { VisError, type VisBase } from "./core/grammar";
import { KIND_WORDS, KINDS } from "./registry";

export type ParseResult = { ok: true; spec: VisBase } | { ok: false; line: number; message: string };

/** `vis flow` → "flow"; `vis` alone → ""; any other fence → null. */
export function visKindWord(info: string): string | null {
  const words = info.trim().split(/\s+/);
  if (words[0]?.toLowerCase() !== "vis") return null;
  return (words[1] ?? "").toLowerCase();
}

export function parseVis(kindWord: string, body: string): ParseResult {
  if (!kindWord) return { ok: false, line: 0, message: `name the kind after vis: one of ${KIND_WORDS.join(", ")}` };
  const entry = Object.hasOwn(KINDS, kindWord) ? KINDS[kindWord] : undefined;
  if (!entry) return { ok: false, line: 0, message: `unknown kind "${kindWord}": use one of ${KIND_WORDS.join(", ")}` };
  try {
    return { ok: true, spec: entry.parse(body) };
  } catch (e) {
    if (e instanceof VisError) return { ok: false, line: e.line, message: e.message };
    return { ok: false, line: 0, message: e instanceof Error ? e.message : String(e) };
  }
}
