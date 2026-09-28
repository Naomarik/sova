import { basename } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CONFIRM_NOTE_MAX, type SessionSummary, type SovaConfirmDetails, type SovaConfirmItem } from "../shared/protocol";

/**
 * `sova_confirm`, shared by the Overseer and the project overseer: an inline card with a question
 * and buttons that does not wait (`terminate: true` ends the run; the pick arrives as the next user
 * message). `items` names what the card is about; each id is resolved here, an unknown one refuses
 * the whole card, and the resolved rows are snapshotted into the card and echoed in the result, so
 * the answering turn acts on exactly what the user saw.
 */

type Tool = ToolDefinition<any, any>;
type Out = { content: { type: "text"; text: string }[]; details: SovaConfirmDetails; terminate: true };

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

export interface ConfirmToolDeps {
  /** Who answers the card, in the tool's words. */
  audience: "user" | "operator";
  lookup: ConfirmLookup;
  /** The caller's act wrapper (audit, unattended/autonomy rules). */
  wrap(run: (params: any) => Promise<Out>): Tool["execute"];
  refusal(message: string): Error;
}

const cut = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const ITEM_KINDS = ["sessions", "ideas", "todos"];
const ORG_KINDS = ["people", "projects"];
const ITEMS_EXAMPLE = '{"sessions": [{"id": "<session id>", "note": "What it is. Why it fits."}], "todos": [{"id": "td_…", "note": "…"}]}';
const ORG_EXAMPLE = '"people": [{"org": "<org id or name>", "id": "<person id or name>", "note": "…"}], "projects": [{"org": "…", "id": "<project id or name>", "note": "…"}]';

/** One requested item: its id as the model wrote it, and its note (whitespace collapsed). */
type Wanted = { ref: string; note?: string };
/** A list of ids, each a bare string or `{id, note}`; the first mention of an id wins. */
function wanted(v: unknown): Wanted[] {
  const out = new Map<string, Wanted>();
  for (const x of Array.isArray(v) ? v : []) {
    const ref = (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" ? (x as { id: string }).id : "").trim();
    if (!ref || out.has(ref)) continue;
    const raw = x && typeof x === "object" ? (x as { note?: unknown }).note : undefined;
    const note = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    out.set(ref, note ? { ref, note } : { ref });
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
    out.set(`${org}\0${ref}`, { org, ref, ...(note ? { note } : {}) });
  }
  return [...out.values()];
}
const link = (s: { id: string; title: string }) => `[${s.title.replace(/[[\]]/g, "")}](sova://s/${s.id})`;

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
export async function resolveConfirmItems(raw: unknown, lookup: ConfirmLookup, refusal: (m: string) => Error): Promise<SovaConfirmItem[]> {
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
  const out: SovaConfirmItem[] = [];
  const unknown = { sessions: [] as string[], ideas: [] as string[], todos: [] as string[], projects: [] as string[], people: [] as string[] };
  const self: string[] = [];
  const long: string[] = [];
  const seen = new Set<string>();
  const noted = <T extends SovaConfirmItem>(item: T, w: Wanted): T => {
    if (w.note && w.note.length > CONFIRM_NOTE_MAX) long.push(`${w.ref} (${w.note.length})`);
    return w.note ? { ...item, note: w.note } : item;
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

/** The tool result's text: the card's items again, with exact ids, so the answering turn acts on exactly these. */
export function confirmResult(items: SovaConfirmItem[], audience: "user" | "operator"): string {
  const head = `Shown to the ${audience} under your reply. The card ends your turn; their pick arrives as their next message.`;
  if (!items.length) return head;
  const lines = [`${head} The card lists ${items.length} ${items.length === 1 ? "item" : "items"}; a pick refers to exactly these:`];
  const sessions = items.filter((i) => i.kind === "session");
  const ideas = items.filter((i) => i.kind === "idea");
  const todos = items.filter((i) => i.kind === "todo");
  const projects = items.filter((i) => i.kind === "project");
  const people = items.filter((i) => i.kind === "person");
  const note = (i: SovaConfirmItem) => (i.note ? ` — ${i.note}` : "");
  if (sessions.length) lines.push("Sessions:", ...sessions.map((s) => `- ${link(s)} (${s.id})${note(s)}`));
  if (ideas.length) lines.push("Ideas:", ...ideas.map((i) => `- ${i.id} — ${i.title}${note(i)}`));
  if (todos.length) lines.push("Todos:", ...todos.map((t) => `- ${t.id} · ${t.text}${note(t)}`));
  if (projects.length) lines.push("Projects:", ...projects.map((p) => `- ${p.name} (${p.id}) in ${p.orgName} (${p.orgId})${note(p)}`));
  if (people.length) lines.push("People:", ...people.map((p) => `- ${p.name} (${p.id}, ${p.status}) in ${p.orgName} (${p.orgId})${note(p)}`));
  return lines.join("\n");
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const NOTE_DESC =
  `What the item is, then why the action fits it: at most 2 short sentences, ${CONFIRM_NOTE_MAX} characters, plain text. ` +
  'E.g. "Push notifications for Overseer briefs. Merged to master yesterday, nothing running." ' +
  `For an idea or todo a button also acts on, say the effect: "Covered by the push session's final report. Ticking marks it done."`;
const idList = (description: string) => ({
  type: "array",
  items: { anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" }, note: { type: "string", description: NOTE_DESC } }, required: ["id"], additionalProperties: false }] },
  description: `${description} Each entry is { id, note } (a bare id still works).`,
});

const orgList = (description: string) => ({
  type: "array",
  items: { type: "object", properties: { org: { type: "string" }, id: { type: "string" }, note: { type: "string", description: NOTE_DESC } }, required: ["org", "id"], additionalProperties: false },
  description,
});

export function confirmTool(d: ConfirmToolDeps): Tool {
  const who = d.audience;
  return {
    name: "sova_confirm",
    label: "Confirm",
    description:
      `Show the ${who} an inline card with a question and buttons, under the reply you wrote. Use it when a request is ambiguous or an action is dangerous or large. ` +
      `Write your reply first (what you found, and why you ask), then call this LAST: the card ends your turn, and the ${who}'s choice arrives as their next message (the option's reply text, or its label). ` +
      `A card about specific things (archive, tick, send, …) lists every one of them in items, so the ${who} sees exactly what the buttons act on, ` +
      `and gives each one a note: what it is, then why the action fits it, in at most 2 short sentences (e.g. "Push notifications for Overseer briefs. Merged to master yesterday, nothing running."); ` +
      `an idea or todo a button also acts on says the effect in its note ("… Ticking marks it done."). Every option's reply says exactly what it does to which items.`,
    promptSnippet: `ask the ${who} with inline buttons, as the last call of your reply`,
    parameters: obj(
      {
        title: str("The question, short."),
        detail: str("One or two sentences of context."),
        options: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "The buttons.",
          items: obj(
            {
              label: str("Button text, Title Case, short."),
              reply: str(
                'What is sent back when picked: exactly what this button does to which items, e.g. "Archive the 13 sessions listed and tick td_dbd3f3f5; leave §sova/tidy-sweeps open." (default: the label).',
              ),
              tone: str("default | danger", { enum: ["default", "danger"] }),
            },
            ["label"],
          ),
        },
        // Not closed: a misplaced key reaches execute, whose refusal says where it goes (pi's own
        // "schema is false" does not).
        items: {
          type: "object",
          properties: {
            sessions: idList("Session ids (or sova://s/<id> links)."),
            ideas: idList("Idea ids (§ns/name)."),
            todos: idList("Todo ids (td_…)."),
            ...(d.lookup.person && d.lookup.project
              ? { people: orgList("Roster people: { org, id, note }, the org and the person each by id or exact name."), projects: orgList("Projects: { org, id, note }, each by id or exact name.") }
              : {}),
          },
          description: `Every ${d.lookup.person ? "session, idea, todo, person or project" : "session, idea or todo"} the question is about, at most ${CONFIRM_ITEMS_MAX}. Required when the card acts on specific things (archive, tick, send, …); then give every item a note. The card lists them. Shape: ${ITEMS_EXAMPLE}${d.lookup.person ? `; people and projects: ${ORG_EXAMPLE}. An act that reaches people or ends something (a gathering session, a person leaving, a project archived, an overseer cleared) runs only in the turn this card's click opens, and only on what it lists` : ""}.`,
        },
      },
      ["title", "options"],
    ),
    execute: d.wrap(async (p) => {
      const options = (Array.isArray(p.options) ? p.options : [])
        .slice(0, 4)
        .filter((o: any) => o && typeof o.label === "string" && o.label.trim())
        .map((o: any) => ({ label: cut(o.label, 40), ...(typeof o.reply === "string" && o.reply.trim() ? { reply: o.reply } : {}), ...(o.tone === "danger" ? { tone: "danger" as const } : {}) }));
      if (!options.length) throw d.refusal("Give at least one option with a label.");
      const items = await resolveConfirmItems(p.items, d.lookup, d.refusal);
      const details: SovaConfirmDetails = {
        title: cut(String(p.title ?? ""), 200),
        ...(p.detail ? { detail: cut(String(p.detail), 600) } : {}),
        options,
        ...(items.length ? { items } : {}),
        ...((await clickOnlyCard(items, d.lookup)) ? { clickOnly: true as const } : {}),
      };
      return { content: [{ type: "text", text: confirmResult(items, who) }], details, terminate: true };
    }),
  };
}
