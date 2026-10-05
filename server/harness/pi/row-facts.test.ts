// Run: pnpm test -- server/harness/pi/row-facts.test.ts. The browser's row predicates on the golden
// corpus (golden/README.md: synthetic, faux, cc, and the real sample when .agent/golden-real holds one),
// against verbatim copies of the EntryMeta reads they had before they read RowFacts: each predicate on
// every row, and the context fill at every prefix of every fixture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CARD_TOOL, normalizeCardDetails } from "../../../shared/overseer-card";
import type { EntryMeta, TranscriptItem } from "../../../shared/protocol";
import { cardResultOfRow } from "../../../shared/row-counts";
import { isChangeRow } from "../../../src/lib/change-rows";
import { contextFromItems, messageContextTokens, type ContextState } from "../../../src/lib/context";
import { thousands } from "../../../src/lib/format";
import { isObj, toolResultView } from "../../../src/lib/message";
import { firstLine } from "../../../src/lib/spend";
import { rowEstimate } from "../../../src/lib/tail-render";
import { MARKER_TITLE, markerRows } from "../../../src/lib/timeline";
import { normalizeClaudeText } from "../../claude-transcript";
import { rowsOf } from "../../transcript";
import { fixtureSets, shortHash, type FixtureSet } from "./golden/golden";
import { branchOf, parsePi } from "./reader";

// ---- The meta reads as they were (copied, not imported)

/** src/lib/change-rows.ts isChangeRow. */
function isChangeRowRef(item: TranscriptItem): boolean {
  if (item.kind !== "info" || !item.meta) return false;
  const { type, customType } = item.meta;
  return type === "model_change" || type === "thinking_level_change" || (type === "custom" && customType === "mode");
}

/** src/lib/context.ts contextFromItems and its isCompaction. */
const isCompactionMetaRef = (meta: EntryMeta) => meta.type === "compaction" || (meta.type === "message" && meta.role === "compactionSummary");
function contextFromItemsRef(items: TranscriptItem[], window: number | null): ContextState {
  for (let i = items.length - 1; i >= 0; i--) {
    const meta = items[i]!.meta;
    if (!meta) continue;
    if (isCompactionMetaRef(meta)) return "compacted";
    const tokens = meta.type === "message" ? messageContextTokens(meta) : null;
    if (tokens !== null) return { tokens, window };
  }
  return null;
}

/** src/lib/timeline.ts markerRows, its compaction marker. */
function compactionMarkerRef(it: TranscriptItem): { title: string; full?: string } | undefined {
  if (!it.at || !(it.kind === "info" && it.meta?.type === "compaction")) return undefined;
  const tokens = typeof it.meta.tokensBefore === "number" ? it.meta.tokensBefore : null;
  const summary = firstLine(it.meta.summary ?? "", 200);
  return { title: tokens ? `Compacted · ${thousands(tokens)} tokens summarized` : MARKER_TITLE.compaction, ...(summary ? { full: summary } : {}) };
}

/** src/lib/tail-render.ts isCompaction. */
const isCompactionRowRef = (item: { meta?: { type?: string } }) => item.meta?.type === "compaction";

/** src/components/Thread.tsx: the Match that draws a Compaction, and the Compaction's props as it read them. */
function compactionViewRef(item: TranscriptItem): { tokens: number | null; details: Record<string, unknown>; summary: string } | undefined {
  const meta = item.kind === "info" && item.meta?.type === "compaction" && item.meta;
  if (!meta) return undefined;
  return { tokens: typeof meta.tokensBefore === "number" ? meta.tokensBefore : null, details: isObj(meta.details) ? meta.details : {}, summary: meta.summary ?? "" };
}

/** shared/row-counts.ts cardResultOfRow. */
function cardResultOfRowRef(it: TranscriptItem) {
  if (it.kind !== "tool-result" || it.meta?.role !== "toolResult" || it.meta.toolName !== CARD_TOOL || it.meta.isError === true) return undefined;
  return normalizeCardDetails(it.tool?.details);
}

/** src/lib/message.ts toolResultView's isError. */
const isErrorRef = (row: TranscriptItem) => row.meta?.isError === true;

// ---- The corpus

const sets = fixtureSets();
const nameOf = (set: FixtureSet, f: FixtureSet["fixtures"][number]) => (set.private ? `real/${shortHash(f.path)}` : `${set.name}/${f.name}`);
const rowsOfText = (format: "pi" | "cc", text: string) => (format === "pi" ? rowsOf(branchOf(parsePi(text).entries)) : normalizeClaudeText(text));

/** contextFromItems at every prefix, longest first, popping one row at a time (no quadratic slicing). */
function eachPrefix(rows: readonly TranscriptItem[], at: (prefix: TranscriptItem[], n: number) => void): void {
  const prefix = rows.slice();
  for (let n = rows.length; n >= 0; n--) {
    at(prefix, n);
    prefix.pop();
  }
}

describe("row predicates equal their EntryMeta reads on every fixture row", () => {
  test("there is a corpus", () => assert.ok(sets.flatMap((s) => s.fixtures).length > 20));
  for (const set of sets)
    for (const f of set.fixtures)
      test(nameOf(set, f), () => {
        const name = nameOf(set, f);
        const rows = rowsOfText(f.format, readFileSync(f.path, "utf8"));
        const markers = new Map(markerRows(rows).filter((r) => r.marker === "compaction").map((r) => [r.entryId, r]));
        for (const [i, it] of rows.entries()) {
          const at = `${name} row ${i} (${it.kind})`;
          assert.equal(isChangeRow(it), isChangeRowRef(it), `${at}: change row`);
          assert.deepEqual(cardResultOfRow(it), cardResultOfRowRef(it), `${at}: card result`);
          assert.equal(toolResultView(it).isError, isErrorRef(it), `${at}: isError`);
          const stand = { kind: it.kind, text: it.text, ...(isCompactionRowRef(it) ? { meta: { type: "compaction" } } : {}) };
          assert.equal(rowEstimate(it), rowEstimate(stand), `${at}: estimate`);
          const want = compactionMarkerRef(it);
          const got = markers.get(it.id);
          assert.deepEqual(got && { title: got.title, ...(got.full !== undefined ? { full: got.full } : {}) }, want, `${at}: compaction marker`);
          assert.equal(compactionViewRef(it) !== undefined, it.kind === "info" && it.meta?.type === "compaction", `${at}: compaction view`);
        }
        eachPrefix(rows, (prefix, n) => assert.deepEqual(contextFromItems(prefix, 200_000), contextFromItemsRef(prefix, 200_000), `${name}: context at ${n}`));
      });
});
