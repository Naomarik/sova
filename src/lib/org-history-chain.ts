// The Causal View's order, from the chain the server traced: one ordered list in sections. Came from
// holds this event's causes (triggers, all the way), Led to its consequences, and Related every other
// event the trace reached, each placed once and each returned edge said once, in words from the card's
// side. Causes and relations never share a section, and no relation is worded as a cause. Nothing here
// adds an edge: an edge is said only when the server returned it. Pure: no DOM, no Solid.
import { HISTORY_BOUNDS, type ChainEdge, type EventSummary, type HistoryChain } from "../../shared/org-history";
import { edgeWords } from "./org-history-words";

export interface ChainItem {
  id: string;
  /** The edge that places this card under its anchor (this event, or the card it hangs from), or null for
      an event no returned edge reaches. */
  edge: ChainEdge | null;
  words: string | null;
  /** Which way the edge runs on screen: toward the card above ("up"), below ("down"), or neither (its other
      end is named in the words). */
  arrow: "up" | "down" | null;
  causal: boolean;
  /** "Trigger not recorded", said with no line: a card on a cause rail whose own trigger wasn't recorded. */
  cap: boolean;
  /** The card's other returned edges, each said here once. */
  also: { edge: ChainEdge; words: string; causal: boolean }[];
  children: ChainItem[];
}

export interface ChainSections {
  causes: ChainItem[];
  /** This event has no recorded trigger. */
  rootCap: boolean;
  consequences: ChainItem[];
  related: ChainItem[];
}

const at = (e: Pick<EventSummary, "occurredAt" | "recordedAt">) => e.occurredAt ?? e.recordedAt;
export const edgeKey = (e: ChainEdge): string => `${e.from}>${e.to}>${e.via ?? ""}>${e.type ?? ""}`;

/** A headline as a noun in another card's words, short enough to read on one line. */
const quoted = (h: string): string => `“${h.length > 48 ? `${h.slice(0, 47).trimEnd()}…` : h}”`;

export function chainSections(c: Pick<HistoryChain, "root" | "nodes" | "edges" | "noTrigger">): ChainSections {
  const byId = new Map(c.nodes.map((n) => [n.id, n]));
  const order = (a: string, b: string) => {
    const x = byId.get(a)!;
    const y = byId.get(b)!;
    return Math.abs(x.hop) - Math.abs(y.hop) || at(x) - at(y) || (a < b ? -1 : a > b ? 1 : 0);
  };
  // Each returned edge once, between two returned events.
  const seen = new Set<string>();
  const edges = c.edges.filter((e) => {
    const k = edgeKey(e);
    if (seen.has(k) || !byId.has(e.from) || !byId.has(e.to) || e.from === e.to) return false;
    seen.add(k);
    return true;
  });
  const isCause = (e: ChainEdge) => e.link === "cause" && !!e.via;
  const noTrigger = new Set(c.noTrigger);
  const used = new Set<ChainEdge>();
  const section = new Map<string, "root" | "cause" | "consequence" | "related">([[c.root, "root"]]);
  const items = new Map<string, ChainItem>();
  const parentOf = new Map<string, string>();
  const noun = (id: string, card: string, side: "from" | "to") => {
    if (id === c.root) return "this";
    // The card it hangs from in its own section is "it" (or, as the subject, "the event above"/"below").
    if (parentOf.get(card) === id && section.get(id) === section.get(card)) return side === "from" ? "it" : section.get(card) === "cause" ? "the event below" : "the event above";
    return quoted(byId.get(id)!.headline);
  };
  const make = (id: string, edge: ChainEdge | null, sect: "cause" | "consequence" | "related", parent: string | null): ChainItem => {
    section.set(id, sect);
    if (parent) parentOf.set(id, parent);
    if (edge) used.add(edge);
    const side = edge ? (edge.from === id ? "from" : "to") : null;
    const anchorAbove = sect !== "cause";
    const toAnchor = side === "from";
    // Hung from a card of another section (a relation of a cause): the words name it, no arrow points.
    const named = !!edge && !!parent && parent !== c.root && section.get(parent) !== sect;
    const item: ChainItem = {
      id,
      edge,
      words: edge && side ? edgeWords(edge, side, noun(side === "from" ? edge.to : edge.from, id, side)) : null,
      arrow: !edge || named ? null : anchorAbove === toAnchor ? "up" : "down",
      causal: !!edge && isCause(edge),
      // On a cause rail with this card as the trigger, its own missing trigger ends the rail in words.
      cap: noTrigger.has(id) && (sect === "cause" || (!!edge && isCause(edge) && side === "from" && sect === "related")),
      also: [],
      children: [],
    };
    items.set(id, item);
    return item;
  };

  // Came from and Led to: triggers only, outward from this event; a second hop nests under its first.
  const walkCauses = (sect: "cause" | "consequence") => {
    const top: ChainItem[] = [];
    let frontier = [c.root];
    while (frontier.length) {
      const next: string[] = [];
      for (const at of frontier) {
        const out = edges
          .filter((e) => isCause(e) && !used.has(e) && (sect === "cause" ? e.to === at : e.from === at))
          .sort((a, b) => order(sect === "cause" ? a.from : a.to, sect === "cause" ? b.from : b.to));
        for (const e of out) {
          const id = sect === "cause" ? e.from : e.to;
          if (section.has(id)) continue;
          const item = make(id, e, sect, at);
          (at === c.root ? top : items.get(at)!.children).push(item);
          next.push(id);
        }
      }
      frontier = next;
    }
    return top;
  };
  const causes = walkCauses("cause");
  const consequences = walkCauses("consequence");

  // Related: every other event. A trigger between two of them nests under the event it triggered; the rest
  // hang from this event first, then from a related card, then (named in the words) from a cause.
  const related: ChainItem[] = [];
  const rest = c.nodes.map((n) => n.id).filter((id) => !section.has(id));
  const restSet = new Set(rest);
  const placeTriggers = (id: string) => {
    for (const e of edges.filter((e) => isCause(e) && e.to === id && restSet.has(e.from) && !section.has(e.from)).sort((a, b) => order(a.from, b.from))) {
      items.get(id)!.children.push(make(e.from, e, "related", id));
      placeTriggers(e.from);
    }
  };
  const rank = (id: string) => (id === c.root ? 0 : section.get(id) === "related" ? 1 : 2);
  // A related event that triggered another related one waits to nest under it.
  const waits = (id: string) => edges.some((e) => isCause(e) && e.from === id && restSet.has(e.to));
  const anchored = (defer: boolean) =>
    rest
      .filter((id) => !section.has(id) && !(defer && waits(id)))
      .map((id) => {
        const links = edges.filter((e) => (e.from === id && section.has(e.to)) || (e.to === id && section.has(e.from)));
        const best = links.sort((a, b) => rank(a.from === id ? a.to : a.from) - rank(b.from === id ? b.to : b.from) || order(a.from === id ? a.to : a.from, b.from === id ? b.to : b.from))[0];
        return best ? { id, edge: best, anchor: best.from === id ? best.to : best.from } : null;
      })
      .filter((x): x is { id: string; edge: ChainEdge; anchor: string } => !!x)
      .sort((a, b) => rank(a.anchor) - rank(b.anchor) || order(a.id, b.id));
  for (;;) {
    const round = anchored(true).length ? anchored(true) : anchored(false);
    if (!round.length) break;
    for (const { id, edge, anchor } of round) {
      if (section.has(id)) continue;
      const nest = section.get(anchor) === "related";
      const item = make(id, edge, "related", anchor);
      (nest ? items.get(anchor)!.children : related).push(item);
      placeTriggers(id);
    }
  }
  // An event no returned edge reaches still shows, with no words.
  for (const id of rest.filter((id) => !section.has(id)).sort(order)) {
    related.push(make(id, null, "related", null));
    placeTriggers(id);
  }

  // Every edge not yet said, on the card of the end that holds it (or, when that is this event, its target).
  for (const e of edges) {
    if (used.has(e)) continue;
    const card = e.from === c.root ? e.to : e.from;
    const side = card === e.from ? "from" : "to";
    const other = noun(side === "from" ? e.to : e.from, card, side);
    const w = side === "from" ? `also ${edgeWords(e, "from", other)}` : edgeWords(e, "to", other).replace(/^(“[^”]*”|the event (?:above|below)|\S+) /, "$1 also ");
    items.get(card)?.also.push({ edge: e, words: w, causal: isCause(e) });
  }
  return { causes, rootCap: noTrigger.has(c.root) && !causes.length, consequences, related };
}

/** The bound in words: how many events, how far each way, and what was left out. */
export function boundLine(events: number, omitted: HistoryChain["omitted"], hops: number = HISTORY_BOUNDS.hops): string {
  const head = `${events} ${events === 1 ? "event" : "events"} within ${hops} ${hops === 1 ? "step" : "steps"}`;
  const { before, after } = omitted;
  if (!before && !after) return `${head} · nothing left out`;
  const n = before + after;
  const parts = before && after ? `${before} earlier and ${after} later` : before ? `${before} earlier` : `${after} later`;
  return `${head} · ${parts} ${n === 1 ? "event" : "events"} not shown`;
}

/** A further page of the same chain merged in: nodes by id (the newer read wins), edges once each; the
    bound's counts and cursor are the newer page's. */
export function mergeChain(cur: HistoryChain, next: HistoryChain): HistoryChain {
  const nodes = new Map(cur.nodes.map((n) => [n.id, n]));
  for (const n of next.nodes) nodes.set(n.id, n);
  const edges = new Map(cur.edges.map((e) => [edgeKey(e), e]));
  for (const e of next.edges) edges.set(edgeKey(e), e);
  return {
    ...next,
    root: cur.root,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    noTrigger: [...new Set([...cur.noTrigger, ...next.noTrigger])],
  };
}
