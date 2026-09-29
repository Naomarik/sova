/**
 * The entry for `vis` fences: the info string's kind word → that kind's parser (registry.ts).
 * Never throws: a parse error comes back with its 1-based body line (0 = the fence as a whole) and a
 * message that says what to write instead. markdown.ts renders an error as the plain code block
 * plus one line; a success becomes a placeholder the Markdown component mounts the kind's View into.
 *
 * Two grades of problem. A HARD error (`ok: false`) means nothing is drawn: the reader gets the
 * source. SOFT warnings (`ok: true`, `warnings` not empty) mean the figure draws with something cut
 * or dropped (overlong text, a mark that names nothing, a large html/svg), plus one muted line
 * listing them; the spec carries the same list as `spec.warnings`. Pure and DOM-free (with
 * registry.ts), so node can run it too.
 */

import { collectWarnings, VisError, type VisBase, type VisWarning } from "./core/grammar";
import { KIND_WORDS, KINDS } from "./registry";

export type { VisWarning };
export type ParseResult = { ok: true; spec: VisBase; warnings: VisWarning[] } | { ok: false; line: number; message: string };

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
    const { value: spec, warnings: all } = collectWarnings(() => entry.parse(body));
    // A kind may read a line twice (a pre-pass), so one problem can be reported twice.
    const warnings = all.filter((w, i) => all.findIndex((o) => o.line === w.line && o.message === w.message) === i).sort((a, b) => a.line - b.line);
    if (warnings.length) spec.warnings = warnings;
    return { ok: true, spec, warnings };
  } catch (e) {
    if (e instanceof VisError) return { ok: false, line: e.line, message: e.message };
    return { ok: false, line: 0, message: e instanceof Error ? e.message : String(e) };
  }
}
