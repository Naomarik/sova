// Format-agnostic JSONL (§app.harness/reader): the one line parse every session-file reader shares,
// pi's (server/harness/pi/reader.ts) and Claude Code's transcripts alike. Knows nothing of either format.

/** One parsed line: any JSON object (an array line counts, as it always has). */
export type JsonObject = Record<string, any>;

/** Parse JSONL text into objects, skipping blank, malformed and non-object lines. */
export function parseJsonl(text: string): JsonObject[] {
  const out: JsonObject[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") out.push(v);
    } catch {
      // malformed line: skip
    }
  }
  return out;
}
