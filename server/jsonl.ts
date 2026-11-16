// Format-agnostic JSONL (§app.harness/reader): the one line parse every session-file reader shares,
// pi's (server/harness/pi/reader.ts) and Claude Code's transcripts alike. Knows nothing of either format.

/** One parsed line: any JSON object (an array line counts, as it always has). */
export type JsonObject = Record<string, any>;

/** One line's parse: an object, or null for a blank, malformed or non-object line. */
function parseLine(line: string): JsonObject | null {
  if (!line.trim()) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null; // malformed line: skip
  }
}

/** Parse JSONL text into objects, skipping blank, malformed and non-object lines. */
export function parseJsonl(text: string): JsonObject[] {
  const out: JsonObject[] = [];
  for (const line of text.split("\n")) {
    const v = parseLine(line);
    if (v) out.push(v);
  }
  return out;
}

/** How long parseJsonlYielding parses before it lets the event loop run. */
export const PARSE_SLICE_MS = 8;
const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

/**
 * parseJsonl's result, the same objects in the same order, parsed in slices of about PARSE_SLICE_MS with a
 * turn of the event loop between them: a long transcript (tens of MB) never holds every other request up
 * for its whole parse, only for one slice (or one very long line).
 */
export async function parseJsonlYielding(text: string, sliceMs = PARSE_SLICE_MS): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  const lines = text.split("\n");
  let since = performance.now();
  for (let i = 0; i < lines.length; i++) {
    const v = parseLine(lines[i]!);
    if (v) out.push(v);
    if (performance.now() - since >= sliceMs) {
      await yieldTurn();
      since = performance.now();
    }
  }
  return out;
}
