// Rows from a peer still on an older Sova: each carries its whole source entry (`raw`) and none of
// the fields a row now draws from (`at`, `meta`, `tool`, `entry`). They are rewritten here, as they
// arrive, into the rows this build reads — every tool row keeping its content (nothing to fetch:
// such a peer has no route for it). Rows that already have the current shape pass through untouched.

import type { EntryMeta, TranscriptItem } from "../../shared/protocol";
import { argsSummary, contentText, isObj, SPAWN_TOOLS, spawnName, str } from "./message";
import { summaryStats } from "./tool-diff-stats";

const SIGNATURES = new Set(["thinkingSignature", "textSignature", "thoughtSignature"]);

/** The entry without its reasoning signatures (the unknown row's JSON). */
function unsigned(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unsigned);
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !SIGNATURES.has(k)).map(([k, x]) => [k, unsigned(x)]));
}

function metaOf(raw: Record<string, unknown>): EntryMeta | undefined {
  const type = str(raw.type);
  if (!type) return undefined;
  const meta: EntryMeta = { type };
  const customType = str(raw.customType);
  if (customType) meta.customType = customType;
  if (type === "compaction") {
    if (typeof raw.tokensBefore === "number") meta.tokensBefore = raw.tokensBefore;
    if (typeof raw.summary === "string") meta.summary = raw.summary;
    if (raw.details !== undefined) meta.details = raw.details;
  }
  const m = raw.message;
  if (isObj(m)) {
    for (const k of ["role", "provider", "model", "stopReason", "errorMessage", "toolName", "toolCallId"] as const) {
      const v = str(m[k]);
      if (v !== undefined) meta[k] = v;
    }
    if (m.usage !== undefined) meta.usage = m.usage;
    if (typeof m.isError === "boolean") meta.isError = m.isError;
    if (!meta.customType && str(m.customType)) meta.customType = str(m.customType);
  }
  return meta;
}

type LegacyRow = TranscriptItem & { raw?: unknown };

/** Whether a list came from an older peer: its rows carry `raw`. */
export const isLegacy = (items: readonly unknown[]): boolean => isObj(items[0]) && "raw" in items[0] && typeof items[0].kind === "string";

/** `items` in the current shape: rewritten when they came from an older peer, else themselves. */
export function upgradeLegacyRows<T>(items: T[]): T[] {
  if (!isLegacy(items)) return items;
  const seen = new Set<unknown>();
  return items.map((row) => {
    const { raw, ...it } = row as LegacyRow;
    const out: TranscriptItem = it;
    if (!isObj(raw)) return out as T;
    const at = str(raw.timestamp);
    if (at) out.at = at;
    // Several rows share one entry (a reply's blocks): its facts go on the first.
    const entryId = str(raw.id) ?? raw;
    if (!seen.has(entryId)) {
      seen.add(entryId);
      const meta = metaOf(raw);
      if (meta) out.meta = meta;
    }
    const m = isObj(raw.message) ? raw.message : undefined;
    if (out.kind === "tool-call") {
      const block = Array.isArray(m?.content) ? m.content.find((c) => isObj(c) && c.type === "toolCall" && c.id === out.toolCallId) : undefined;
      const args = isObj(block) ? block.arguments : undefined;
      out.tool = { summary: argsSummary(args), ...(args !== undefined ? { args } : {}) };
      const spawn = SPAWN_TOOLS.has(out.text ?? "") ? spawnName(args) : "";
      if (spawn) out.tool.spawn = spawn;
    } else if (out.kind === "tool-result" && m) {
      const details = m.details;
      const stats = summaryStats("edit", details);
      out.tool = { output: contentText(m.content), ...(details !== undefined ? { details } : {}), ...(stats ? { stats } : {}) };
    } else if (out.kind === "unknown") out.entry = unsigned(raw);
    return out as T;
  });
}
