import { basename } from "node:path";
import { CONFIRM_NOTE_MAX, type SessionSummary, type SovaConfirmItem } from "../shared/protocol";

/**
 * What a card is about, shared by the Overseer's and the project overseer's `sova_card`
 * (server/overseer-card-tool.ts): `items` names the sessions, ideas, todos, people and projects;
 * each id is resolved here, an unknown one refuses the whole card, and the resolved rows are
 * snapshotted into the card, so the answering turn acts on exactly what the user saw.
 */

/** The most items one card may carry (the per-turn archive cap). */
export const CONFIRM_ITEMS_MAX = 50;

/** How a card's ids resolve; null = no such thing. */
export interface ConfirmLookup {
  /** A session reference in any form the tools print it (a bare id, `s/<id>`, `sova://s/<id>`, a markdown link). */
  session(ref: string): Promise<SessionSummary | null>;
  /** The asking overseer's own conversation: never an item. */
  isSelf(s: SessionSummary): boolean;
  idea(ref: string): { id: string; title: string } | null;
  todo(ref: string): { id: string; text: string } | null;
  /** A roster person / a project of an org on this host, by id or exact name (the global Overseer's
      cards only; a caller without them takes no `people` or `projects`). */
  person?(org: string, ref: string): Extract<SovaConfirmItem, { kind: "person" }> | null;
  project?(org: string, ref: string): Extract<SovaConfirmItem, { kind: "project" }> | null;
}

const cut = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const ITEM_KINDS = ["sessions", "ideas", "todos"];
const ORG_KINDS = ["people", "projects"];
const ITEMS_EXAMPLE = '{"sessions": [{"id": "<session id>", "note": "What it is. Why it fits."}], "todos": [{"id": "td_…", "note": "…"}]}';
const ORG_EXAMPLE = '"people": [{"org": "<org id or name>", "id": "<person id or name>", "note": "…"}], "projects": [{"org": "…", "id": "<project id or name>", "note": "…"}]';

/** One requested item: its id as the model wrote it, its note (whitespace collapsed), and the
    per-item choice it starts on (a sova_card entry's `default`, checked by the card model). */
type Wanted = { ref: string; note?: string; default?: string };
/** A resolved item, with the `default` its entry gave. */
export type ResolvedItem = SovaConfirmItem & { default?: string };
const defaultOf = (x: unknown): { default?: string } => {
  const d = x && typeof x === "object" ? (x as { default?: unknown }).default : undefined;
  return typeof d === "string" && d.trim() ? { default: d.trim().toLowerCase() } : {};
};
/** A list of ids, each a bare string or `{id, note}`; the first mention of an id wins. */
function wanted(v: unknown): Wanted[] {
  const out = new Map<string, Wanted>();
  for (const x of Array.isArray(v) ? v : []) {
    const ref = (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" ? (x as { id: string }).id : "").trim();
    if (!ref || out.has(ref)) continue;
    const raw = x && typeof x === "object" ? (x as { note?: unknown }).note : undefined;
    const note = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    out.set(ref, { ref, ...(note ? { note } : {}), ...defaultOf(x) });
  }
  return [...out.values()];
}
/** People or projects: each `{org, id, note?}`; an entry without its org matches nothing. */
type OrgWanted = Wanted & { org: string };
function wantedOrg(v: unknown): OrgWanted[] {
  const out = new Map<string, OrgWanted>();
  for (const x of Array.isArray(v) ? v : []) {
    const o: { org?: unknown; id?: unknown; note?: unknown } = x && typeof x === "object" ? x : { id: x };
    const ref = typeof o.id === "string" ? o.id.trim() : "";
    const org = typeof o.org === "string" ? o.org.trim() : "";
    if (!ref || out.has(`${org}\0${ref}`)) continue;
    const note = typeof o.note === "string" ? o.note.replace(/\s+/g, " ").trim() : "";
    out.set(`${org}\0${ref}`, { org, ref, ...(note ? { note } : {}), ...defaultOf(x) });
  }
  return [...out.values()];
}

/** A session's card row: the snapshot the card shows. */
export function sessionItem(s: SessionSummary): SovaConfirmItem {
  const where = s.remoteCwd ?? s.cwd;
  const summary = s.outlineGist ?? s.outlineNow;
  return {
    kind: "session",
    id: s.id,
    title: cut(s.title, 120),
    ...(where ? { project: basename(where) || where } : {}),
    ...(s.lastActiveAt ? { lastActiveAt: s.lastActiveAt } : {}),
    ...(summary?.trim() ? { summary: cut(summary, 200) } : {}),
    ...(s.workers?.working ? { workers: s.workers.working } : {}),
  };
}

/** Resolve `items` to card rows, refusing (all at once, each named) unknown ids, the overseer's own
    conversation and over-long notes, and more than the cap. */
export async function resolveConfirmItems(raw: unknown, lookup: ConfirmLookup, refusal: (m: string) => Error): Promise<ResolvedItem[]> {
  if (raw === undefined || raw === null) return [];
  const orgs = !!(lookup.person && lookup.project);
  const kinds = orgs ? [...ITEM_KINDS, ...ORG_KINDS] : ITEM_KINDS;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw refusal(`items is an object: { sessions?: [...], ideas?: [...], todos?: [...]${orgs ? ", people?: [...], projects?: [...]" : ""} }, each entry an id or { id, note }${orgs ? " (a person or project also names its org: { org, id, note })" : ""}.`);
  const r = raw as Record<string, unknown>;
  const stray = Object.keys(r).filter((k) => !kinds.includes(k));
  if (stray.length)
    throw refusal(
      `No card was shown. items takes only ${orgs ? "sessions, ideas, todos, people and projects" : "sessions, ideas and todos"}, each a list; this one has ${stray.join(", ")}. Put each entry in its list, e.g. ${ITEMS_EXAMPLE}${orgs ? `, and ${ORG_EXAMPLE}` : ""}.`,
    );
  const want = { sessions: wanted(r.sessions), ideas: wanted(r.ideas), todos: wanted(r.todos), people: orgs ? wantedOrg(r.people) : [], projects: orgs ? wantedOrg(r.projects) : [] };
  const total = want.sessions.length + want.ideas.length + want.todos.length + want.people.length + want.projects.length;
  if (total > CONFIRM_ITEMS_MAX) throw refusal(`A card lists at most ${CONFIRM_ITEMS_MAX} items; this one has ${total}. Split it, or ask about the first ${CONFIRM_ITEMS_MAX}.`);
  const out: ResolvedItem[] = [];
  const unknown = { sessions: [] as string[], ideas: [] as string[], todos: [] as string[], projects: [] as string[], people: [] as string[] };
  const self: string[] = [];
  const long: string[] = [];
  const seen = new Set<string>();
  const noted = <T extends SovaConfirmItem>(item: T, w: Wanted): T & { default?: string } => {
    if (w.note && w.note.length > CONFIRM_NOTE_MAX) long.push(`${w.ref} (${w.note.length})`);
    return { ...item, ...(w.note ? { note: w.note } : {}), ...(w.default ? { default: w.default } : {}) };
  };
  for (const w of want.sessions) {
    const s = await lookup.session(w.ref);
    if (!s) unknown.sessions.push(w.ref);
    else if (lookup.isSelf(s)) self.push(w.ref);
    else if (!seen.has(s.id)) {
      seen.add(s.id);
      out.push(noted(sessionItem(s), w));
    }
  }
  for (const w of want.ideas) {
    const i = lookup.idea(w.ref);
    if (!i) unknown.ideas.push(w.ref);
    else if (!seen.has(i.id)) {
      seen.add(i.id);
      out.push(noted({ kind: "idea", id: i.id, title: cut(i.title, 120) }, w));
    }
  }
  for (const w of want.todos) {
    const t = lookup.todo(w.ref);
    if (!t) unknown.todos.push(w.ref);
    else if (!seen.has(t.id)) {
      seen.add(t.id);
      out.push(noted({ kind: "todo", id: t.id, text: cut(t.text, 200) }, w));
    }
  }
  // Projects, then people: the card shows them after ideas and todos, before sessions.
  for (const w of want.projects) {
    const p = w.org ? lookup.project!(w.org, w.ref) : null;
    if (!p) unknown.projects.push(w.org ? `${w.ref} in ${w.org}` : `${w.ref} (no org)`);
    else if (!seen.has(`${p.orgId}/${p.id}`)) {
      seen.add(`${p.orgId}/${p.id}`);
      out.push(noted({ ...p, name: cut(p.name, 120) }, w));
    }
  }
  for (const w of want.people) {
    const p = w.org ? lookup.person!(w.org, w.ref) : null;
    if (!p) unknown.people.push(w.org ? `${w.ref} in ${w.org}` : `${w.ref} (no org)`);
    else if (!seen.has(`${p.orgId}/${p.id}`)) {
      seen.add(`${p.orgId}/${p.id}`);
      out.push(noted({ ...p, name: cut(p.name, 120) }, w));
    }
  }
  const problems: string[] = [];
  const missing = (Object.entries(unknown) as [string, string[]][]).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(", ")}`);
  if (missing.length)
    problems.push(`These ids match nothing (${missing.join("; ")}). List them again (sova_list_sessions, sova_ideas, sova_todos${orgs ? ", sova_orgs" : ""}) and use the ids exactly as printed.`);
  if (self.length) problems.push(`${self.join(", ")} is your own conversation; a card never lists it. Leave it out.`);
  if (long.length) problems.push(`A note is at most ${CONFIRM_NOTE_MAX} characters (two short sentences); these are longer: ${long.join(", ")}. Shorten them.`);
  if (problems.length) throw refusal(`No card was shown. ${problems.join(" ")}`);
  return out;
}

/** Whether a card may gate an act that reaches people or ends something (§app.overseer/org-people-facing):
    only the global Overseer's (the one that resolves people and projects), when it lists a person, a
    project or a gathering session. A click on it opens the only turn that act runs in; typed text never does. */
export async function clickOnlyCard(items: SovaConfirmItem[], lookup: ConfirmLookup): Promise<boolean> {
  if (!lookup.person || !lookup.project) return false;
  if (items.some((i) => i.kind === "person" || i.kind === "project")) return true;
  for (const i of items) {
    if (i.kind !== "session") continue;
    const s = await lookup.session(i.id);
    if (s?.baton || s?.org?.kind === "gathering" || s?.org?.kind === "offer") return true;
  }
  return false;
}

const NOTE_DESC =
  `What the item is, then why the action fits it: at most 2 short sentences, ${CONFIRM_NOTE_MAX} characters, plain text. ` +
  'E.g. "Push notifications for Overseer briefs. Merged to master yesterday, nothing running." ' +
  `For an idea or todo a button also acts on, say the effect: "Covered by the push session's final report. Ticking marks it done."`;
const DEFAULT_DESC = 'With choices: the choice letter this item starts on ("a"), your recommendation for it.';
const idList = (description: string) => ({
  type: "array",
  items: {
    anyOf: [
      { type: "string" },
      { type: "object", properties: { id: { type: "string" }, note: { type: "string", description: NOTE_DESC }, default: { type: "string", description: DEFAULT_DESC } }, required: ["id"], additionalProperties: false },
    ],
  },
  description: `${description} Each entry is { id, note, default? } (a bare id still works).`,
});
const orgList = (description: string) => ({
  type: "array",
  items: {
    type: "object",
    properties: { org: { type: "string" }, id: { type: "string" }, note: { type: "string", description: NOTE_DESC }, default: { type: "string", description: DEFAULT_DESC } },
    required: ["org", "id"],
    additionalProperties: false,
  },
  description,
});

/** The JSON schema of a card's `items`, for a caller with (`orgs`) or without people and projects. */
export function itemsSchema(orgs: boolean): Record<string, unknown> {
  return {
    type: "object",
    // Not closed: a misplaced key reaches execute, whose refusal says where it goes (pi's own
    // "schema is false" does not).
    properties: {
      sessions: idList("Session ids (or sova://s/<id> links)."),
      ideas: idList("Idea ids (§ns/name)."),
      todos: idList("Todo ids (td_…)."),
      ...(orgs
        ? { people: orgList("Roster people: { org, id, note }, the org and the person each by id or exact name."), projects: orgList("Projects: { org, id, note }, each by id or exact name.") }
        : {}),
    },
    description: `Every ${orgs ? "session, idea, todo, person or project" : "session, idea or todo"} the question is about, at most ${CONFIRM_ITEMS_MAX}. Required when the card acts on specific things (archive, tick, send, …); then give every item a note. The card numbers them 1..N. Shape: ${ITEMS_EXAMPLE}${orgs ? `; people and projects: ${ORG_EXAMPLE}. An act that reaches people or ends something (a gathering session, a person leaving, a project archived, an overseer cleared) runs only in the turn this card's click opens, and only on what it lists` : ""}.`,
  };
}
