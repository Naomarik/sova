// Run: pnpm test -- server/harness/pi/wire-v1-corpus.test.ts. Wire 1 → wire 2 on the
// golden corpus (golden/README.md: synthetic, faux, cc, and the real sample when .agent/golden-real holds
// one): every event of the genuine pi streams through fromV1, and every row's facts against the row
// predicates that read meta today. The table itself is shared/wire-v1.test.ts.
//
// facts(meta) == facts(HEntry) waits for the neutral reader (R1, ./reader.ts): it runs once that file is
// here, and is skipped, saying so, until then.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { RowFacts, SovaEvent } from "../../../shared/harness-wire";
import { stripImageNotes } from "../../../shared/image-note";
import { CARD_TOOL, normalizeCardDetails } from "../../../shared/overseer-card";
import type { EntryMeta, TranscriptItem } from "../../../shared/protocol";
import { cardResultOfRow } from "../../../shared/row-counts";
import { factsFromMeta, fromV1, rowFacts } from "../../../shared/wire-v1";
import { isChangeRow } from "../../../src/lib/change-rows";
import { contextFromItems, messageContextTokens } from "../../../src/lib/context";
import { contentText, toolResultView } from "../../../src/lib/message";
import { normalizeClaudeText } from "../../claude-transcript";
import { activeBranch, normalizeEntries, parseLines } from "../../transcript";
import { metaOf } from "./wire";
import { fixtureSets, GOLDEN_DIR, shortHash, type FixtureSet } from "./golden/golden";

const sets = fixtureSets();
/** A fixture's name in a message: its hash for the real corpus, never its content. Hashed once. */
const names = new Map<string, string>();
const nameOf = (set: FixtureSet, f: FixtureSet["fixtures"][number]): string => {
  let name = names.get(f.path);
  if (name === undefined) names.set(f.path, (name = set.private ? `real/${shortHash(f.path)}` : `${set.name}/${f.name}`));
  return name;
};

// ---- The faux streams

/** pi's event as chat-manager's toWireEvent sends it (server/chat-manager.ts:409): a message_update
    without `partial` and its message, a toolcall_start naming its call. Signatures don't matter here. */
function wireEvent(event: any): unknown {
  if (event?.type !== "message_update") return event;
  const ame = event.assistantMessageEvent ?? {};
  let wire = ame;
  if ("partial" in ame) {
    const { partial, ...rest } = ame;
    wire = rest;
    if (ame.type === "toolcall_start") {
      const tc = partial?.content?.[ame.contentIndex];
      if (tc?.type === "toolCall") wire = { ...rest, id: tc.id, toolName: tc.name };
    }
  }
  return { type: "message_update", usage: event.message?.usage, assistantMessageEvent: wire };
}

/** The v1 events the live view acts on (src/lib/live.ts applyEvent, ChatView's flush). */
const READ = new Set([
  "agent_start", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update",
  "tool_execution_end", "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end",
]);
const PART_EVENTS = /^(text|thinking|toolcall)_(start|delta|end)$/;

const fauxDir = join(GOLDEN_DIR, "fixtures/faux");
const faux = sets.find((s) => s.name === "faux")!.fixtures.map((f) => ({ name: f.name, events: JSON.parse(readFileSync(join(fauxDir, f.name, "events.json"), "utf8")) as any[] }));

describe("fromV1 on the faux streams", () => {
  test("there are streams", () => assert.ok(faux.length >= 8, `${faux.length} faux streams`));
  for (const { name, events } of faux)
    test(name, () => {
      const seen = new Set<string>();
      for (const [i, raw] of events.entries()) {
        const event = wireEvent(raw) as any;
        const out = fromV1({ event });
        const at = `${name} event ${i} (${raw.type})`;
        const role = raw.message?.role;
        const ame = raw.assistantMessageEvent?.type;
        const acts =
          READ.has(raw.type) &&
          (raw.type === "message_start" ? role === "assistant" || role === "user" : true) &&
          (raw.type === "message_end" ? role === "assistant" || role === "user" : true) &&
          (raw.type === "message_update" ? PART_EVENTS.test(ame ?? "") : true);
        assert.equal(out.length, acts ? 1 : 0, `${at}: ${JSON.stringify(out)}`);
        for (const e of out) seen.add(e.type);
        const e = out[0] as SovaEvent | undefined;
        if (e?.type === "part.start" && e.kind === "toolCall") assert.ok(e.id && e.name, `${at}: a streamed call names itself`);
        if (e?.type === "message.end" && e.role === "assistant") {
          // The fill as the browser reads it off the v1 event today.
          assert.equal(e.contextTokens ?? null, messageContextTokens(raw.message), `${at}: context`);
          assert.equal(e.stop, raw.message.stopReason === "error" ? "error" : raw.message.stopReason === "aborted" ? "aborted" : "ok", at);
        }
        if (e?.type === "message.start" && e.role === "user")
          assert.equal(e.text, stripImageNotes(contentText(raw.message.content), raw.message.content), `${at}: user text as live.ts makes it`);
        if (e?.type === "activity" && e.phase === "end" && e.what === "compaction") assert.equal(e.wrote, typeof raw.result === "object" && raw.result !== null, at);
      }
      assert.ok(seen.has("run.start") && seen.has("run.settled") && seen.has("message.end"), `${name}: ${[...seen].join(",")}`);
    });
});

// ---- Rows: every predicate that reads meta, read off facts alone

/** The row as a wire-2 consumer gets it: `facts` in place of `meta`. */
function v2Row(it: TranscriptItem): TranscriptItem {
  const { meta, ...rest } = it;
  const facts = factsFromMeta(meta);
  return facts ? { ...rest, facts } : rest;
}

/** Each predicate in its facts form, as W3.3 ports it (rowFacts reads either wire). */
const isChangeRowF = (it: TranscriptItem) => it.kind === "info" && rowFacts(it)?.setting !== undefined;
const compactionF = (it: TranscriptItem) => (it.kind === "info" ? rowFacts(it)?.compaction : undefined);
const cardResultF = (it: TranscriptItem) => {
  const tool = rowFacts(it)?.tool;
  return it.kind === "tool-result" && tool && tool.name === CARD_TOOL && tool.isError !== true ? normalizeCardDetails(it.tool?.details) : undefined;
};
const isErrorF = (it: TranscriptItem) => rowFacts(it)?.tool?.isError === true;
function contextF(items: readonly TranscriptItem[], window: number | null): ReturnType<typeof contextFromItems> {
  for (let i = items.length - 1; i >= 0; i--) {
    const f = rowFacts(items[i]!);
    if (!f) continue;
    if (f.resetsContext) return "compacted";
    if (f.contextTokens !== undefined) return { tokens: f.contextTokens, window };
  }
  return null;
}

const rowsOf = (format: "pi" | "cc", text: string) => (format === "pi" ? normalizeEntries(activeBranch(parseLines(text))) : normalizeClaudeText(text));

describe("row facts on every fixture row: each meta predicate equals its facts form", () => {
  for (const set of sets)
    for (const f of set.fixtures)
      test(nameOf(set, f), () => {
        const rows = rowsOf(f.format, readFileSync(f.path, "utf8"));
        const v2 = rows.map(v2Row);
        for (const [i, it] of rows.entries()) {
          const at = `${nameOf(set, f)} row ${i} (${it.kind})`;
          const w = v2[i]!;
          assert.equal("meta" in w, false);
          assert.equal(isChangeRowF(w), isChangeRow(it), `${at}: change row`);
          assert.equal(isChangeRowF(it), isChangeRow(it), `${at}: change row on v1`);
          // timeline / tail-render / Thread: a compaction row, its figures.
          const c = compactionF(w);
          assert.equal(c !== undefined, it.kind === "info" && it.meta?.type === "compaction", `${at}: compaction`);
          if (c) {
            assert.equal(c.tokensBefore ?? null, typeof it.meta!.tokensBefore === "number" ? it.meta!.tokensBefore : null, at);
            assert.equal(c.summary ?? "", it.meta!.summary ?? "", at);
            assert.deepEqual(c.details, it.meta!.details, at);
          }
          assert.deepEqual(cardResultF(w), cardResultOfRow(it), `${at}: card result`);
          if (it.kind === "tool-result") assert.equal(isErrorF(w), toolResultView(it).isError, `${at}: isError`);
        }
        // The fill as the stream grows: at every prefix (the real corpus: 64 of them, ends included, as
        // slicing every prefix of a long session is quadratic), on v2 rows and on v1 rows via rowFacts.
        const step = set.private ? Math.max(1, Math.ceil(rows.length / 64)) : 1;
        const prefixes = new Set([...Array.from({ length: Math.floor(rows.length / step) + 1 }, (_, k) => k * step), rows.length]);
        for (const n of prefixes) {
          const want = contextFromItems(rows.slice(0, n), 200_000);
          assert.deepEqual(contextF(v2.slice(0, n), 200_000), want, `${nameOf(set, f)}: context at ${n}`);
          assert.deepEqual(contextF(rows.slice(0, n), 200_000), want, `${nameOf(set, f)}: context at ${n} via meta`);
        }
      });
});

// ---- facts(meta) == facts(HEntry), once the neutral reader is here (R1)

/** An HEntry as harness-v2 plan B §2.1 has it: read structurally, so this compiles before R1 lands. */
type H = { kind: string; wire1?: EntryMeta; [k: string]: unknown };

/** RowFacts read off the neutral entry: what the facts mean, independent of EntryMeta. */
function factsOfEntry(h: H): RowFacts {
  const facts: RowFacts = {};
  if (h.kind === "setting" && h.what === "model") facts.setting = "model";
  else if (h.kind === "setting" && h.what === "thinking") facts.setting = "thinking";
  else if (h.kind === "state" && h.key === "mode") facts.setting = "mode";
  if (h.kind === "compaction" || (h.kind === "summary" && h.of === "compaction" && h.inMessage === true)) facts.resetsContext = true;
  if (h.kind === "compaction") {
    const c: NonNullable<RowFacts["compaction"]> = {};
    if (typeof h.tokensBefore === "number") c.tokensBefore = h.tokensBefore;
    if (typeof h.summary === "string") c.summary = h.summary;
    if (h.details !== undefined) c.details = h.details;
    facts.compaction = c;
  }
  if (h.kind === "assistant" && typeof h.contextTokens === "number") facts.contextTokens = h.contextTokens;
  if (h.kind === "tool-result") {
    const tool: NonNullable<RowFacts["tool"]> = {};
    if (typeof h.tool === "string") tool.name = h.tool;
    if (typeof h.callId === "string") tool.callId = h.callId;
    if (typeof h.isError === "boolean") tool.isError = h.isError;
    facts.tool = tool;
  }
  return facts;
}

const READER = join(import.meta.dirname, "reader.ts");
const reader: any = existsSync(READER) ? await import(READER) : null;
const pending = reader ? false : "pending R1: server/harness/pi/reader.ts is not here yet";

describe("facts(meta) equals facts(HEntry)", () => {
  test("the reader parses pi text", { skip: pending }, () => assert.equal(typeof reader.parsePi, "function", "R1's parsePi(text) → {entries}"));
  for (const set of sets)
    for (const f of set.fixtures.filter((x) => x.format === "pi"))
      test(nameOf(set, f), { skip: pending }, () => {
        const text = readFileSync(f.path, "utf8");
        const entries: H[] = reader.parsePi(text).entries;
        const raws = parseLines(text).filter((e) => e.type !== "session");
        let compared = 0;
        for (const [i, h] of entries.entries()) {
          if (h.kind === "unknown") continue; // q7: unknown entries carry no facts a consumer reads
          // The entry's v1 facts: the adapter's own (wire1), else today's metaOf of its raw line.
          const meta = h.wire1 ?? (typeof reader.rawOf === "function" ? metaOf(reader.rawOf(h)) : raws[i] ? metaOf(raws[i]!) : undefined);
          if (!meta) continue;
          assert.deepEqual(factsOfEntry(h), factsFromMeta(meta), `${nameOf(set, f)} entry ${i} (${h.kind})`);
          compared++;
        }
        assert.ok(compared > 0 || entries.length === 0, `${nameOf(set, f)}: nothing compared`);
      });
});
