import type { IdeaRecord, IdeaStatus, IdeasToc } from "../../shared/protocol";

/**
 * The Overseer page's Ideas panel, as data: the chip each status draws, the ToC as rows, and the
 * messages its actions send. Pure, so the component only draws.
 */

/** Each status's chip. `exploring` takes the accent: an agent is working on it, the live-run case.
    `open` and `dropped` are uncoloured; the word carries them, as it carries every chip. */
export const IDEA_STATUS_CHIP: Record<IdeaStatus, { label: string; tone: string }> = {
  open: { label: "Open", tone: "" },
  exploring: { label: "Exploring", tone: "chip-accent" },
  started: { label: "Started", tone: "chip-info" },
  done: { label: "Done", tone: "chip-success" },
  dropped: { label: "Dropped", tone: "" },
};

/** A status the ToC hides unless asked: the idea is finished with. */
export const settled = (s: IdeaStatus) => s === "done" || s === "dropped";

/** Words for a count of ideas: "1 idea", "3 ideas". */
export const ideasCount = (n: number) => `${n} ${n === 1 ? "idea" : "ideas"}`;

/**
 * One namespace's line under its heading: the statuses it has, most active first, zeros left out.
 * "2 open · 1 exploring".
 */
export function countsLine(counts: Record<IdeaStatus, number>, showSettled: boolean): string {
  const order: IdeaStatus[] = ["exploring", "started", "open", "done", "dropped"];
  return order
    .filter((s) => counts[s] > 0 && (showSettled || !settled(s)))
    .map((s) => `${counts[s]} ${IDEA_STATUS_CHIP[s].label.toLowerCase()}`)
    .join(" · ");
}

export interface TocRow {
  id: string;
  title: string;
  status: IdeaStatus;
  /** 1 for a sub-entry (drawn one indent step in). */
  depth: 0 | 1;
  /** The name after the "/", what the row leads with. */
  name: string;
}

export interface TocGroup {
  ns: string;
  counts: Record<IdeaStatus, number>;
  rows: TocRow[];
  /** Ideas left out because they are done or dropped. */
  hidden: number;
}

/**
 * The ToC as the panel lists it: the server's order (namespaces by name; each main entry followed
 * by its sub-entries). Done and dropped ideas go unless `showSettled`; a sub-entry stays when its
 * parent goes, still indented. `query` keeps entries whose id or title contains it (any case). A
 * namespace with no row left is dropped, unless it only hides settled ideas — then it stays, so
 * the user sees where they went.
 */
export function tocGroups(toc: IdeasToc, opts: { showSettled: boolean; query?: string }): TocGroup[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const out: TocGroup[] = [];
  for (const ns of toc.namespaces) {
    const matching = ns.entries.filter((e) => !q || e.id.toLowerCase().includes(q) || e.title.toLowerCase().includes(q));
    const rows = matching
      .filter((e) => opts.showSettled || !settled(e.status))
      .map<TocRow>((e) => ({ id: e.id, title: e.title, status: e.status, depth: e.parent ? 1 : 0, name: e.id.slice(e.id.indexOf("/") + 1) }));
    const hidden = matching.length - rows.length;
    if (rows.length === 0 && (hidden === 0 || q)) continue;
    out.push({ ns: ns.ns, counts: ns.counts, rows, hidden });
  }
  return out;
}

/** An id as the user types it: the `§` added when missing. */
export const canonicalId = (id: string) => (id.startsWith("§") ? id : `§${id}`);

/**
 * What "Explore" sends: an ordinary user message, so the turn is user-started and the Overseer's
 * caps apply. It names the idea by id, the way the Overseer's own ToC does. With an explorer
 * already linked, it asks for that one's report instead of launching a second.
 */
export function exploreMessage(idea: Pick<IdeaRecord, "id" | "explorerId">): string {
  return idea.explorerId
    ? `What has the explorer for idea ${idea.id} found so far?`
    : `Explore idea ${idea.id}: launch an exploratory agent for it.`;
}

/** What "Start a Session" sends. The Overseer asks where, and confirms, like any session it starts. */
export const startMessage = (idea: Pick<IdeaRecord, "id">) => `Start a session to work on idea ${idea.id}.`;

/** Tags as the user types them ("a, b c") → the list the server takes (lowercase, deduped). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/[\s,]+/)) {
    const tag = t.trim().toLowerCase().replace(/^#/, "");
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}
