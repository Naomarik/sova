// The spec card's words and the reply's closing-line cut (§chat.spec-card/card, /closing-lines). No DOM,
// no Solid: the pure parts test under the runner.
import type { SpecTurnInfo, SpecTurnItemInfo, TranscriptItem } from "../../shared/protocol";

/** The reply's trailing closing spec lines, the same cut merge readiness makes (server/merge-readiness.ts replyBody). */
const CLOSING = /(?:\n\s*(?:Also changes|Deferred|Plumbing|Spec check override):[^\n]*)+\s*$/i;

/** The reply without its trailing closing spec lines; lines inside the body stay. */
export function withoutClosingLines(text: string): string {
  const cut = `\n${text}`.replace(CLOSING, "");
  return cut.slice(1).trimEnd();
}

/** Rows a turn starts at: the reply rows after one belong to the next run. */
const startsTurn = (it: TranscriptItem) => it.kind === "user" || it.kind === "wake" || it.kind === "link" || it.kind === "topic";

/**
 * The assistant-text rows whose run has a spec card: every reply row between the turn's start and a
 * spec-turn row. Their closing lines are the card's to show.
 */
export function rowsWithCard(rows: readonly TranscriptItem[]): Set<string> {
  const out = new Set<string>();
  rows.forEach((row, i) => {
    if (row.kind !== "spec-turn") return;
    for (let j = i - 1; j >= 0; j--) {
      const r = rows[j]!;
      if (startsTurn(r) || r.kind === "spec-turn") break;
      if (r.kind === "assistant-text") out.add(r.id);
    }
  });
  return out;
}

/** The area a § sits in: everything before its last `/`, without the `§` (as pi-config/extensions/mode/spec-turn.ts areaOf). */
export function areaOf(id: string): string {
  const bare = id.replace(/^§/, "");
  const cut = bare.lastIndexOf("/");
  return cut < 0 ? bare : bare.slice(0, cut);
}

/** Items grouped by area, in first-seen order. */
export function byArea(items: readonly SpecTurnItemInfo[]): { area: string; items: SpecTurnItemInfo[] }[] {
  const groups = new Map<string, SpecTurnItemInfo[]>();
  for (const it of items) {
    const a = areaOf(it.id);
    const g = groups.get(a);
    if (g) g.push(it);
    else groups.set(a, [it]);
  }
  return [...groups].map(([area, list]) => ({ area, items: list }));
}

/** The § a record counts as changed by its run: its own and what it landed. */
export const changedCount = (d: SpecTurnInfo): number => new Set([...d.own, ...d.landed].map((it) => it.id)).size;

/** The collapsed line: "Spec · 6 § changed · 83 § from master" (a 0 part left out), as the TUI's. */
export function specTurnLine(d: SpecTurnInfo): string {
  const parts = ["Spec"];
  const n = changedCount(d);
  if (n) parts.push(`${n} § changed`);
  if (d.arrived?.count) parts.push(`${d.arrived.count} § from ${d.arrived.from}`);
  if (parts.length === 1) parts.push("no § changed");
  return parts.join(" · ");
}

/** A change kind in words, for a row's end: the spec tools' names, sentence-cased. */
export function changeWord(change: string | undefined): string | undefined {
  if (!change) return undefined;
  const words: Record<string, string> = {
    text: "Text",
    record: "Record",
    "text+record": "Text + record",
    "child-added": "New child",
    added: "New",
    deleted: "Deleted",
    renamed: "Renamed",
  };
  return words[change] ?? change.charAt(0).toUpperCase() + change.slice(1);
}

/** Whether the open card has a "Left open" section. */
export function leftOpen(d: SpecTurnInfo): boolean {
  return d.gate.unpromoted.length > 0 || d.gate.unmapped.length > 0 || d.gate.stale.length > 0 || !!d.check.incomplete || !!d.check.override || !d.check.ok;
}

/** "1 area" / "9 areas". */
export const areas = (n: number): string => `${n} ${n === 1 ? "area" : "areas"}`;
