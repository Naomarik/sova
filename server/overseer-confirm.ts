import { basename } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionSummary, SovaConfirmDetails, SovaConfirmItem } from "../shared/protocol";

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
  idea(ref: string): { id: string; title: string } | null;
  todo(ref: string): { id: string; text: string } | null;
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
const ids = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))];
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

/** Resolve `items` to card rows, refusing unknown ids (all of them, named) and more than the cap. */
export async function resolveConfirmItems(raw: unknown, lookup: ConfirmLookup, refusal: (m: string) => Error): Promise<SovaConfirmItem[]> {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw refusal("items is an object: { sessions?: [ids], ideas?: [ids], todos?: [ids] }.");
  const r = raw as Record<string, unknown>;
  const want = { sessions: ids(r.sessions), ideas: ids(r.ideas), todos: ids(r.todos) };
  const total = want.sessions.length + want.ideas.length + want.todos.length;
  if (total > CONFIRM_ITEMS_MAX) throw refusal(`A card lists at most ${CONFIRM_ITEMS_MAX} items; this one has ${total}. Split it, or ask about the first ${CONFIRM_ITEMS_MAX}.`);
  const out: SovaConfirmItem[] = [];
  const unknown = { sessions: [] as string[], ideas: [] as string[], todos: [] as string[] };
  const seen = new Set<string>();
  for (const ref of want.sessions) {
    const s = await lookup.session(ref);
    if (!s) unknown.sessions.push(ref);
    else if (!seen.has(s.id)) {
      seen.add(s.id);
      out.push(sessionItem(s));
    }
  }
  for (const ref of want.ideas) {
    const i = lookup.idea(ref);
    if (!i) unknown.ideas.push(ref);
    else if (!seen.has(i.id)) {
      seen.add(i.id);
      out.push({ kind: "idea", id: i.id, title: cut(i.title, 120) });
    }
  }
  for (const ref of want.todos) {
    const t = lookup.todo(ref);
    if (!t) unknown.todos.push(ref);
    else if (!seen.has(t.id)) {
      seen.add(t.id);
      out.push({ kind: "todo", id: t.id, text: cut(t.text, 200) });
    }
  }
  const missing = (Object.entries(unknown) as [string, string[]][]).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(", ")}`);
  if (missing.length)
    throw refusal(
      `No card was shown: these ids match nothing (${missing.join("; ")}). List them again (sova_list_sessions, sova_ideas, sova_todos) and use the ids exactly as printed.`,
    );
  return out;
}

/** The tool result's text: the card's items again, with exact ids, so the answering turn acts on exactly these. */
export function confirmResult(items: SovaConfirmItem[], audience: "user" | "operator"): string {
  const head = `Shown to the ${audience} under your reply. The card ends your turn; their pick arrives as their next message.`;
  if (!items.length) return head;
  const lines = [`${head} The card lists ${items.length} ${items.length === 1 ? "item" : "items"}; a pick refers to exactly these:`];
  const sessions = items.filter((i) => i.kind === "session");
  const ideas = items.filter((i) => i.kind === "idea");
  const todos = items.filter((i) => i.kind === "todo");
  if (sessions.length) lines.push("Sessions:", ...sessions.map((s) => `- ${link(s)} (${s.id})`));
  if (ideas.length) lines.push("Ideas:", ...ideas.map((i) => `- ${i.id} — ${i.title}`));
  if (todos.length) lines.push("Todos:", ...todos.map((t) => `- ${t.id} · ${t.text}`));
  return lines.join("\n");
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const idList = (description: string) => ({ type: "array", items: { type: "string" }, description });

export function confirmTool(d: ConfirmToolDeps): Tool {
  const who = d.audience;
  return {
    name: "sova_confirm",
    label: "Confirm",
    description:
      `Show the ${who} an inline card with a question and buttons, under the reply you wrote. Use it when a request is ambiguous or an action is dangerous or large. ` +
      `Write your reply first (what you found, and why you ask), then call this LAST: the card ends your turn, and the ${who}'s choice arrives as their next message (the option's reply text, or its label). ` +
      `A card about specific things (archive, tick, send, …) lists every one of them in items, so the ${who} sees exactly what the buttons act on.`,
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
              reply: str("What is sent back when picked (default: the label)."),
              tone: str("default | danger", { enum: ["default", "danger"] }),
            },
            ["label"],
          ),
        },
        items: {
          ...obj({
            sessions: idList("Session ids (or sova://s/<id> links)."),
            ideas: idList("Idea ids (§ns/name)."),
            todos: idList("Todo ids (td_…)."),
          }),
          description: `Every session, idea or todo the question is about, at most ${CONFIRM_ITEMS_MAX}. Required when the card acts on specific things (archive, tick, send, …). The card lists them.`,
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
      };
      return { content: [{ type: "text", text: confirmResult(items, who) }], details, terminate: true };
    }),
  };
}
