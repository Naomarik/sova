import {
  BATON_DECISION_ENTRY,
  BATON_DONE_ENTRY,
  BATON_HANDOFF_ENTRY,
  BATON_OFFER_ENTRY,
  BATON_SENT_ENTRY,
  BATON_WRAPUP_ENTRY,
  OPERATOR,
  type BatonSession,
  type BatonView,
  type BatonViewItem,
  type PersonRef,
} from "../shared/baton";
import { REDACTED } from "./overseer-redact";

/**
 * The outsider view (§app.baton/outsider-view): a baton session's active branch reduced to what a
 * participant may see. Pure: the caller reads the branch, the names and the redaction phrases.
 *
 * An ALLOWLIST over raw entries, never a denylist over rendered rows: a user message, the reply's
 * text blocks, and the three baton cards. Thinking, tool calls and results, system messages,
 * model/thinking changes, compactions, every other custom entry and anything pi adds later are
 * dropped because nothing here names them.
 */

type Entry = Record<string, any>;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
};

/** Replace every case-insensitive occurrence of each phrase with [redacted]. Pure. */
export function redactPhrases(text: string, phrases: readonly string[]): string {
  let out = text;
  for (const p of phrases) {
    if (!p) continue;
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, REDACTED);
  }
  return out;
}

export interface ViewInput {
  row: Pick<BatonSession, "publicTitle" | "state" | "holder">;
  /** The active branch, oldest first (server/transcript.ts readActiveBranch). */
  branch: Entry[];
  /** personId (and "operator") → display name. */
  names: Record<string, string>;
  /** The viewer: a person id (the share page) or undefined (the operator's replay: every briefing). */
  viewer?: PersonRef;
  /** Applied to every string that reaches the view. */
  redact: (text: string) => string;
  /** An invitee who has not held the offer: the view ends with offer card `untilOffer`, and the
      holder is not named. */
  untilOffer?: number;
}

export function batonView(input: ViewInput): BatonView {
  const { branch, names, viewer, redact } = input;
  const name = (ref: unknown): string => (typeof ref === "string" && names[ref]) || (ref === OPERATOR ? "Operator" : "Someone");
  const by = new Map<string, string>();
  for (const e of branch)
    if (e.type === "custom" && e.customType === BATON_SENT_ENTRY && typeof e.data?.targetId === "string" && typeof e.data?.by === "string") by.set(e.data.targetId, e.data.by);
  let lastUserId: string | undefined;
  for (const e of branch) if (e.type === "message" && e.message?.role === "user") lastUserId = e.id;

  const items: BatonViewItem[] = [];
  for (const e of branch) {
    // The wrap-up is the operator's: nothing from its marker on is anyone else's to see.
    if (e.type === "custom" && e.customType === BATON_WRAPUP_ENTRY) break;
    const id = typeof e.id === "string" ? e.id : "";
    const at = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (e.type === "message") {
      const role = e.message?.role;
      if (role === "user") {
        const text = textOf(e.message.content).trim();
        if (!text) continue;
        // Its marker lands a microtask after the message: until then, the last message is the holder's.
        const sender = by.get(id) ?? (id === lastUserId && input.row.holder ? input.row.holder : "");
        items.push({ kind: "message", id, by: sender, name: sender ? name(sender) : "Someone", text: redact(text), ...(at ? { at } : {}) });
      } else if (role === "assistant") {
        const text = textOf(e.message.content).trim();
        if (text) items.push({ kind: "reply", id, text: redact(text), ...(at ? { at } : {}) });
      }
      continue;
    }
    if (e.type !== "custom") continue;
    const d = e.data ?? {};
    if (e.customType === BATON_HANDOFF_ENTRY && typeof d.n === "number") {
      const addressee = viewer === undefined || viewer === d.to;
      items.push({
        kind: "handoff",
        id,
        n: d.n,
        from: name(d.from),
        to: name(d.to),
        question: redact(String(d.question ?? "")),
        ...(addressee && typeof d.briefing === "string" && d.briefing.trim() ? { briefing: redact(d.briefing) } : {}),
      });
    } else if (e.customType === BATON_OFFER_ENTRY && typeof d.n === "number" && Array.isArray(d.to)) {
      const invited = viewer === undefined || d.to.includes(viewer);
      items.push({
        kind: "offer",
        id,
        n: d.n,
        from: name(d.from),
        // Nobody on a share page learns who else was asked (with two, "someone else" would name them).
        to: viewer === undefined ? d.to.map((t: unknown) => name(t)) : [],
        invited: d.to.length,
        question: redact(String(d.question ?? "")),
        ...(invited && typeof d.briefing === "string" && d.briefing.trim() ? { briefing: redact(d.briefing) } : {}),
      });
      if (input.untilOffer === d.n) break;
    } else if (e.customType === BATON_DECISION_ENTRY) {
      items.push({ kind: "decision", id, by: name(d.by), area: redact(String(d.area ?? "")), statement: redact(String(d.statement ?? "")) });
    } else if (e.customType === BATON_DONE_ENTRY) {
      items.push({ kind: "done", id, summary: redact(String(d.summary ?? "")) });
    }
  }
  return {
    publicTitle: redact(input.row.publicTitle),
    state: input.row.state,
    holder: input.row.holder === null || input.untilOffer !== undefined ? null : name(input.row.holder),
    items,
  };
}

/** The reply's text so far from a streaming assistant message: text blocks only. */
export const streamingText = (message: unknown): string => textOf((message as { content?: unknown } | null)?.content);
