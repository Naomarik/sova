import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DraftItem } from "../shared/conversation-drafts";
import { readSpecFs } from "../pi-config/extensions/spec/core/layout.mjs";
import { REQUIREMENTS_NS, type DecisionRow } from "../shared/decisions";
import {
  blocksOf,
  CONVERSATION_PREFIX,
  currentClaims,
  draftExists,
  draftSpecDir,
  proseHash,
  rebuildOwnDraftOn,
  recordIdOf,
  recordSlug,
  specDirOf,
  type SpecEdit,
} from "./spec-draft-writer";

/**
 * A conversation's own spec draft (§app.requirements/conversation-drafts): every gathering, settle
 * and Project Assistant conversation writes the requirements agreed in it into a draft of the
 * project's spec named after it, copied from current (the main line), never into current itself.
 *
 * Storage-free core: the caller hands the conversation's items (its recorded requirements, from the
 * transcript) and gets the draft rebuilt from current with them, the clashes, and what the draft
 * changes against current. Where the items and the draft's state live is the caller's.
 *
 * - The writer is the deterministic one (server/spec-draft-writer.ts): a requirement is a `note`
 *   record `§requirements.<area>/<slug>`, the statement and the person's words. A change to existing
 *   behaviour is such a note too, naming the record it changes (`changes`); Sova never rewrites
 *   that record: the coding session that builds the change does, in its own draft.
 * - Caught up by rebuilding: the draft tools have no rebase, so each catch-up makes the draft again
 *   from current and writes the items again. A change whose target's prose moved since it was agreed
 *   (`basedOnHash`), or whose target is gone, is a clash: kept, and reported.
 */

export type ClashReason = "changed" | "gone";
export interface Clash {
  /** The item's id. */
  item: string;
  /** Its record in the draft. */
  recordId: string;
  /** The record it changes. */
  target: string;
  /** `changed`: the current spec changed that record since it was agreed; `gone`: current no longer has it. */
  reason: ClashReason;
}

/**
 * A conversation's items seeded from the decisions it recorded before conversation drafts
 * (§app.requirements/conversation-drafts "Switching over"): its live decisions, oldest first, each a
 * new item (or a change, when its entry names one). A superseded decision is not a requirement.
 * Ids continue after `taken` ("r1", "r2", …).
 */
export function itemsOfDecisions(rows: readonly DecisionRow[], sessionId: string, taken: readonly DraftItem[] = [], changesOf: (d: DecisionRow) => { changes?: string; changesHash?: string } = () => ({})): DraftItem[] {
  let n = nextItemNumber(taken);
  const have = new Set(taken.map((t) => t.decisionId).filter(Boolean));
  return rows
    .filter((d) => d.sessionId === sessionId && d.state !== "superseded" && !d.supersededBy && !have.has(d.id))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .map((d) => ({ ...itemOfDecision(`r${n++}`, d, changesOf(d)), seeded: true }));
}

/** The next free "r<n>" of a record's items. */
export function nextItemNumber(items: readonly Pick<DraftItem, "id">[]): number {
  let max = 0;
  for (const it of items) {
    const m = /^r(\d+)$/.exec(it.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

const cut = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** A recorded decision as an item of its conversation's draft. */
export function itemOfDecision(
  id: string,
  d: Pick<DecisionRow, "id" | "area" | "areaKey" | "statement" | "quote" | "by" | "name" | "at" | "entryId"> & Partial<Pick<DecisionRow, "recordId">>,
  c: { changes?: string; changesHash?: string } = {},
): DraftItem {
  return {
    id,
    kind: c.changes ? "change" : "new",
    title: cut(d.statement, 80),
    text: d.statement,
    area: d.area,
    areaKey: d.areaKey,
    quote: d.quote,
    ...(c.changes ? { target: c.changes, ...(c.changesHash ? { basedOnHash: c.changesHash } : {}) } : {}),
    // Its record id when it has one (a promoted decision is the same record, not a second one).
    ...(d.recordId ? { recordId: d.recordId } : {}),
    agreedAt: d.at,
    by: d.by,
    name: d.name,
    decisionId: d.id,
    entryId: d.entryId,
    status: "agreed",
  };
}

/** A base's manifest records ({} for no spec). */
export const baseClaims = (baseRoot: string | null): Record<string, unknown> => (baseRoot === null ? {} : currentClaims(baseRoot));
/** A base's prose blocks (none for no spec). */
export const baseBlocks = (baseRoot: string | null): Map<string, string> => (baseRoot === null ? new Map() : blocksOf(specDirOf(baseRoot)));

/** The draft of the conversation `sessionId`. */
export function conversationDraftName(sessionId: string): string {
  const id = sessionId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "");
  if (!id) throw new Error("a conversation draft needs a session id");
  return `${CONVERSATION_PREFIX}${id}`.slice(0, 64);
}

/** The hash a change records when it is agreed: its target's prose in the current spec, or null when current has no such record. */
export function targetHash(baseRoot: string | null, target: string): string | null {
  const block = baseBlocks(baseRoot).get(target);
  return block === undefined ? null : proseHash(block);
}

/**
 * Each item's record id: kept while it is still free in current or still this item's own there,
 * else (or when it has none) the next free slug of its area. Pure: returns new items.
 */
export function assignItemRecordIds(items: readonly DraftItem[], current: Record<string, unknown>, sessionId: string): DraftItem[] {
  const taken = new Map<string, Set<string>>();
  const takenIn = (areaKey: string) => {
    let s = taken.get(areaKey);
    if (!s) {
      s = new Set();
      const prefix = `§${REQUIREMENTS_NS}.${areaKey}/`;
      for (const id of Object.keys(current)) if (id.startsWith(prefix)) s.add(id.slice(prefix.length));
      taken.set(areaKey, s);
    }
    return s;
  };
  const ownedHere = (recordId: string, it: DraftItem) => {
    const rec = current[recordId] as { decision?: unknown } | undefined;
    return !rec || rec.decision === decisionIdOf(it, sessionId);
  };
  const out: DraftItem[] = [];
  // An item whose decision current already holds (the legacy path promoted it) is that record.
  const byDecision = new Map<string, string>();
  for (const [id, rec] of Object.entries(current)) {
    const dec = (rec as { decision?: unknown } | null)?.decision;
    if (typeof dec === "string") byDecision.set(dec, id);
  }
  items = items.map((it) => {
    const there = byDecision.get(decisionIdOf(it, sessionId));
    const area = there ? new RegExp(`^§${REQUIREMENTS_NS}\\.([a-z-]+)/`).exec(there)?.[1] : undefined;
    // Filed where the legacy path filed it (its reconciler may have moved it to an earlier area).
    return there && area && there !== it.recordId ? { ...it, recordId: there, areaKey: area } : it;
  });
  // Ids kept first, so a later item never takes an earlier one's slug.
  const keep = new Set<string>();
  for (const it of items) {
    if (it.recordId && it.recordId.startsWith(`§${REQUIREMENTS_NS}.${it.areaKey}/`) && ownedHere(it.recordId, it) && !keep.has(it.recordId)) {
      keep.add(it.recordId);
      takenIn(it.areaKey).add(it.recordId.slice(`§${REQUIREMENTS_NS}.${it.areaKey}/`.length));
    }
  }
  for (const it of items) {
    if (it.recordId && keep.has(it.recordId) && !out.some((o) => o.recordId === it.recordId)) {
      out.push({ ...it });
      continue;
    }
    const slugs = takenIn(it.areaKey);
    const slug = recordSlug(it.title || it.text, slugs);
    slugs.add(slug);
    out.push({ ...it, recordId: recordIdOf(it.areaKey, slug) });
  }
  return out;
}

/** The changes whose target moved or went away in the spec whose blocks are `blocks`. */
/** Why a change item clashes with the spec whose blocks are `blocks`, or null. */
export function clashOf(it: Pick<DraftItem, "kind" | "target" | "basedOnHash">, blocks: ReadonlyMap<string, string>): ClashReason | null {
  if (it.kind !== "change" || !it.target) return null;
  const block = blocks.get(it.target);
  if (block === undefined) return "gone";
  return it.basedOnHash && proseHash(block) !== it.basedOnHash ? "changed" : null;
}

/** The changes whose target moved or went away in the spec whose blocks are `blocks`. */
export function clashesOf(items: readonly DraftItem[], blocks: ReadonlyMap<string, string>): Clash[] {
  const out: Clash[] = [];
  for (const it of items) {
    if (it.status === "dropped") continue;
    const reason = clashOf(it, blocks);
    if (reason) out.push({ item: it.id, recordId: it.recordId ?? "", target: it.target!, reason });
  }
  return out;
}

/** Whether the item's record is in current as its own (promoted, by either path). */
export function isCurrent(it: Pick<DraftItem, "id" | "decisionId" | "recordId">, current: Record<string, unknown>, sessionId: string): boolean {
  if (!it.recordId) return false;
  const rec = current[it.recordId] as { decision?: unknown } | undefined;
  return !!rec && rec.decision === decisionIdOf(it, sessionId);
}

/** The decision id an item's record carries (`decision`): its own decision's, else `<session>:<item>`. */
export const decisionIdOf = (it: Pick<DraftItem, "id" | "decisionId">, sessionId: string): string => it.decisionId ?? `${sessionId}:${it.id}`;

/** An item as the writer's row. */
export function rowOfItem(it: DraftItem, sessionId: string): DecisionRow {
  return {
    id: decisionIdOf(it, sessionId),
    orgId: "",
    projectId: "",
    area: it.area,
    areaKey: it.areaKey,
    statement: it.text,
    quote: it.quote,
    by: it.by ?? "",
    name: it.name ?? "",
    at: it.agreedAt,
    sessionId,
    entryId: it.entryId ?? it.id,
    markerId: it.id,
    authorOwnsArea: true,
    sessionPath: null,
    state: "drafted",
    ...(it.recordId ? { recordId: it.recordId } : {}),
  };
}

/** The writer's edit for these items (their record ids assigned; dropped ones left out). */
export function editOfItems(items: readonly DraftItem[], sessionId: string): SpecEdit {
  const live = items.filter((it) => it.status !== "dropped");
  const changes = new Map<string, string>();
  for (const it of live) if (it.kind === "change" && it.target && it.recordId) changes.set(it.recordId, it.target);
  return { rows: live.map((it) => rowOfItem(it, sessionId)), supersededBy: new Map(), changes };
}

export interface CaughtUp {
  draft: string;
  /** The items with their record ids and clashes (keep them: the next catch-up keeps each id). */
  items: DraftItem[];
  clashes: Clash[];
  /** Record ids the draft changes against current. */
  changed: string[];
}

/**
 * Bring a conversation's draft onto the current spec (§app.requirements/conversation-drafts "Caught
 * up before each reply"): rebuilt from current with `items` written again. It exists after this
 * even with no items. Current is never written.
 */
export async function catchUpDraft(root: string, sessionId: string, items: readonly DraftItem[], baseRoot: string | null = root): Promise<CaughtUp> {
  const name = conversationDraftName(sessionId);
  const live = items.filter((it) => it.status !== "dropped");
  const current = baseClaims(baseRoot);
  const assigned = new Map(assignItemRecordIds(live, current, sessionId).map((it) => [it.id, it]));
  const blocks = baseBlocks(baseRoot);
  const next = items.map((it) => {
    const a = assigned.get(it.id) ?? it;
    const clash = it.status === "dropped" ? null : clashOf(a, blocks);
    return { ...a, clash };
  });
  const clashes = clashesOf(next, blocks);
  // An item already current (promoted: its record carries its decision) is not written again: the draft
  // shows only what it would change.
  const pending = next.filter((it) => !isCurrent(it, current, sessionId));
  const { changed } = await rebuildOwnDraftOn(root, baseRoot, name, `The requirements agreed in conversation ${sessionId}`, editOfItems(pending, sessionId));
  return { draft: name, items: next, clashes, changed };
}

/** One record a conversation's draft changes against current. */
export interface DraftChange {
  id: string;
  /** The heading's title. */
  title: string;
  /** `new`: a new requirement; `change`: a change to the record `changes` names; `other`: a record the draft differs in that Sova didn't write (a hand edit). */
  kind: "new" | "change" | "other";
  changes?: string;
  /** `added`: not in current; `modified`: in current, differently; `removed`: in current, not in the draft. */
  status: "added" | "modified" | "removed";
  /** Its prose in the draft (absent when removed). */
  text?: string;
}

const titleOf = (block: string | undefined, id: string): string => {
  const m = block ? /^#{1,2} §\S+\s+—\s+(.*)$/m.exec(block) : null;
  return m ? m[1]!.trim() : id;
};

function readClaims(specDir: string): Record<string, Record<string, unknown>> {
  try {
    // The records in either layout, through the spec tools' shared reader ({} for none, or a mixed layout).
    const spec = readSpecFs(specDir, ".");
    return spec.state === "present" && spec.manifest && !spec.problems.some((p) => p.code === "layout-mixed") ? (spec.records as Record<string, Record<string, unknown>>) : {};
  } catch {
    return {};
  }
}

/** What a conversation's draft changes against its base (the main line's spec: `baseRoot`), read from the files (no tool run). Empty when it has no draft. */
export function draftChangesOf(root: string, name: string, baseRoot: string | null = root): DraftChange[] {
  if (!draftExists(root, name)) return [];
  const draftDir = draftSpecDir(root, name);
  const cur = baseClaims(baseRoot) as Record<string, Record<string, unknown>>;
  const dr = readClaims(draftDir);
  const curBlocks = baseBlocks(baseRoot);
  const drBlocks = blocksOf(draftDir);
  const out: DraftChange[] = [];
  for (const id of Object.keys(dr).sort()) {
    const rec = dr[id]!;
    const inCur = id in cur;
    const same = inCur && JSON.stringify(cur[id]) === JSON.stringify(rec) && curBlocks.get(id) === drBlocks.get(id);
    if (same) continue;
    // An area's lede that only exists to hold the new records is part of them, not a change of its own.
    if (!inCur && id.startsWith(`§${REQUIREMENTS_NS}/`)) continue;
    const changes = typeof rec.changes === "string" ? rec.changes : undefined;
    const ours = typeof rec.decision === "string";
    out.push({
      id,
      title: titleOf(drBlocks.get(id), id),
      kind: changes ? "change" : ours ? "new" : "other",
      ...(changes ? { changes } : {}),
      status: inCur ? "modified" : "added",
      ...(drBlocks.has(id) ? { text: drBlocks.get(id)!.replace(/\n+$/, "") } : {}),
    });
  }
  for (const id of Object.keys(cur).sort())
    if (!(id in dr)) out.push({ id, title: titleOf(curBlocks.get(id), id), kind: "other", status: "removed" });
  return out;
}

/**
 * What a coding session started from a conversation's draft begins with (§app.requirements/draft-approval):
 * the draft's name and each of its changes against current, in full, the changes naming the record
 * they change. Null when the draft changes nothing.
 */
export function codingContextOf(root: string, name: string, baseRoot: string | null = root): string | null {
  const changes = draftChangesOf(root, name, baseRoot).filter((c) => c.status !== "removed");
  if (!changes.length) return null;
  const lines = [
    `This session builds the requirements of the conversation draft \`${name}\` (.sova/spec/drafts/${name}/), compared with the current spec.`,
    "New requirements are agreed and not built yet. A change to existing behaviour names the record it changes: build it, then update that record in your own spec draft.",
    "",
  ];
  const groups: [string, DraftChange[]][] = [
    ["New requirements", changes.filter((c) => c.kind === "new")],
    ["Changes to existing behaviour", changes.filter((c) => c.kind === "change")],
    ["Other edits", changes.filter((c) => c.kind === "other")],
  ];
  for (const [title, group] of groups) {
    if (!group.length) continue;
    lines.push(`## ${title}`, "");
    for (const c of group) lines.push(`### ${c.kind === "change" ? `Change to ${c.changes}` : c.kind === "new" ? "New requirement" : "Other edit"}: ${c.title}`, "", c.text ?? "", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
