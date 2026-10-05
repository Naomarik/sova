// Run: pnpm test -- server/harness/pi/row-facts.test.ts. The browser's row predicates on the golden
// corpus (golden/README.md: synthetic, faux, cc, and the real sample when .agent/golden-real holds one),
// against verbatim copies of the EntryMeta reads they had before they read RowFacts: each predicate on
// every row, and the context fill at every prefix of every fixture, on rows as wire 1 sends them
// (`meta`) and as wire 2 does (`facts`, no `meta`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CARD_TOOL, normalizeCardDetails } from "../../../shared/overseer-card";
import type { EntryMeta, TranscriptItem } from "../../../shared/protocol";
import { cardResultOfRow } from "../../../shared/row-counts";
import { isChangeRow } from "../../../src/lib/change-rows";
import { contextFromItems, messageContextTokens, type ContextState } from "../../../src/lib/context";
import { factsFromMeta, rowFacts } from "../../../shared/wire-v1";
import { thousands } from "../../../src/lib/format";
import { isObj, toolResultView } from "../../../src/lib/message";
import { firstLine } from "../../../src/lib/spend";
import { rowEstimate } from "../../../src/lib/tail-render";
import { MARKER_TITLE, markerRows } from "../../../src/lib/timeline";
import { sameItem } from "../../../src/lib/transcript-cache";
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

/** The row as a wire-2 consumer gets it: `facts` in place of `meta`. */
function v2Row(it: TranscriptItem): TranscriptItem {
  const { meta, ...rest } = it;
  const facts = factsFromMeta(meta);
  return facts ? { ...rest, facts } : rest;
}

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
        const v2 = rows.map(v2Row);
        const markers = new Map(markerRows(rows).filter((r) => r.marker === "compaction").map((r) => [r.entryId, r]));
        assert.deepEqual(markerRows(v2), markerRows(rows), `${name}: markers on wire 2`);
        for (const [i, it] of rows.entries()) {
          const at = `${name} row ${i} (${it.kind})`;
          const w = v2[i]!;
          assert.equal("meta" in w, false);
          for (const [row, wire] of [[it, "wire 1"], [w, "wire 2"]] as const) {
            const where = `${at} on ${wire}`;
            assert.equal(isChangeRow(row), isChangeRowRef(it), `${where}: change row`);
            assert.deepEqual(cardResultOfRow(row), cardResultOfRowRef(it), `${where}: card result`);
            assert.equal(toolResultView(row).isError, isErrorRef(it), `${where}: isError`);
            const stand = { kind: it.kind, text: it.text, ...(isCompactionRowRef(it) ? { meta: { type: "compaction" } } : {}) };
            assert.equal(rowEstimate(row), rowEstimate(stand), `${where}: estimate`);
            // Thread's Match and its Compaction's props, as it reads them now.
            const c = row.kind === "info" ? rowFacts(row)?.compaction : undefined;
            const view = c && { tokens: c.tokensBefore ?? null, details: isObj(c.details) ? c.details : {}, summary: c.summary ?? "" };
            assert.deepEqual(view, compactionViewRef(it), `${where}: compaction view`);
          }
          const want = compactionMarkerRef(it);
          const got = markers.get(it.id);
          assert.deepEqual(got && { title: got.title, ...(got.full !== undefined ? { full: got.full } : {}) }, want, `${at}: compaction marker`);
        }
        const fill: ContextState[] = [];
        eachPrefix(rows, (prefix, n) => {
          fill[n] = contextFromItemsRef(prefix, 200_000);
          assert.deepEqual(contextFromItems(prefix, 200_000), fill[n], `${name}: context at ${n}`);
        });
        eachPrefix(v2, (prefix, n) => assert.deepEqual(contextFromItems(prefix, 200_000), fill[n], `${name}: context at ${n} on wire 2`));
      });
});

test("a refetched wire-2 row whose facts changed is a different row (transcript-cache sameItem)", () => {
  const row: TranscriptItem = { id: "e1", kind: "info", text: "Compacted", facts: { resetsContext: true, compaction: { tokensBefore: 10 } } };
  assert.equal(sameItem(row, { ...row, facts: { resetsContext: true, compaction: { tokensBefore: 10 } } }), true);
  assert.equal(sameItem(row, { ...row, facts: { resetsContext: true, compaction: { tokensBefore: 20 } } }), false);
});
