import type { HEntry, ToolCtx, ToolSpec } from "../shared/harness";
import {
  applyCardCall,
  CARD_ANSWERS_MAX,
  CARD_CHOICES_MAX,
  CARD_CHOICES_MIN,
  CARD_LINKS_MAX,
  CARD_OP_FIELDS,
  CARD_OPS,
  CARD_TOOL,
  CardError,
  checkCardCall,
  foldCardDetails,
  type CardDetails,
  type CardOpName,
  type CardPrepared,
  type OverseerCard,
} from "../shared/overseer-card";
import { GRANTABLE_ACTS } from "../shared/overseer-grants";
import { CONFIRM_NOTE_MAX } from "../shared/protocol";
import { clickOnlyCard, itemsSchema, resolveConfirmItems, type ConfirmLookup } from "./overseer-confirm";
import { cardDetailsOf } from "./overseer-run-note";

/**
 * `sova_card`, shared by the Overseer and the project overseer (§app.overseer/confirm): the
 * model's decision cards, a clone of the align tool (pi-config/extensions/mode/align-tool.ts). The
 * model (shared/overseer-card.ts) applies a call atomically and returns the touched card's snapshot
 * as the result's `details`; this file resolves what needs the host first (a create's items and link
 * targets), and returns WITHOUT `terminate`: the run goes on, so no call is ever held while the user
 * answers.
 */

type Tool = ToolSpec;
type Out = { content: { type: "text"; text: string }[]; details: CardDetails };

/** A link option's target, as the model gives it: sova_navigate's fields, the org pages, or a URL. */
export interface CardLinkInput {
  session?: string;
  group?: string;
  page?: string;
  team?: string;
  settings_tab?: string;
  org?: string;
  project?: string;
  person?: string;
  url?: string;
}

export interface CardToolDeps {
  /** Who answers the card, in the tool's words. */
  audience: "user" | "operator";
  /** Options may approve for later or propose a standing rule (the global Overseer only). */
  grants?: boolean;
  lookup: ConfirmLookup;
  /** Resolves a link option's target to its href (`#/…`, `settings:…` or an https URL); throws a refusal. */
  link(target: CardLinkInput): Promise<string>;
  /** The caller's act wrapper (audit, unattended/autonomy rules). */
  wrap(run: (params: any) => Promise<Out>): Tool["execute"];
  refusal(message: string): Error;
  /** The session's branch when the call's context has none (tests). */
  branch?(): readonly HEntry[];
}

type Ctx = ToolCtx | undefined;

const S = (description?: string, extra: Record<string, unknown> = {}) => ({ type: "string", minLength: 1, ...(description ? { description } : {}), ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({ type: "object", properties, required, additionalProperties: false, ...extra });

function linkSchema(orgs: boolean) {
  return obj(
    {
      session: S("A session id: open it (alone, or focused inside group)."),
      group: S("A group id: open its workspace."),
      page: orgs ? S("usage | agents | overseer | settings | orgs", { enum: ["usage", "agents", "overseer", "settings", "orgs"] }) : S("usage | agents | overseer | settings", { enum: ["usage", "agents", "overseer", "settings"] }),
      team: S("With page agents: a team id."),
      settings_tab: S("With page settings: the tab."),
      ...(orgs ? { org: S("An organization, by id or exact name: its page, or with project/person theirs."), project: S("With org: a project, by id or exact name."), person: S("With org: a roster person, by id or exact name.") } : {}),
      url: S("An outside https URL (a PR, a doc). Opens in a new tab. No other scheme, no credentials."),
    },
    [],
    { description: "Makes the option a link: it opens this target and never answers the card (no letter, no message, no turn). In-app targets open in the same tab." },
  );
}

function opSchemas(orgs: boolean, grants: boolean): Record<CardOpName, { description: string; fields: Record<string, unknown> }> {
  const option = obj(
    {
      label: S("Button text, Title Case, short."),
      reply: S('Sent back when picked, after the card id and letter: exactly what this button does to which items, e.g. "Archive the 13 sessions listed and tick td_dbd3f3f5; leave §sova/tidy-sweeps open." (default: the label).'),
      tone: S("default | danger", { enum: ["default", "danger"] }),
      link: linkSchema(orgs),
      ...(grants
        ? {
            at: S('An approval for later: when you mean to act (ISO with offset, e.g. "2026-09-30T18:00:00+03:00"; set a wake_nudge for it). The click lets your unattended runs do ANY act on the card\'s listed sessions until until (default an hour after at; at most 7 days ahead). Only when the user wants it done without them.'),
            until: S("With at: the approval's deadline (ISO with offset)."),
            rule: obj(
              {
                text: S('The standing instruction, e.g. "Send continue to a session after its usage limit resets."'),
                acts: { type: "array", minItems: 1, items: { type: "string", enum: [...GRANTABLE_ACTS] }, description: "The acts it covers (default: all of them)." },
                any_session: { type: "boolean", description: "Cover any session on this host, not only the card's listed ones." },
              },
              ["text"],
              { description: "Propose a standing rule the click adopts: it lets unattended runs do these acts until the user revokes it. Only when the user asked for a standing instruction." },
            ),
          }
        : {}),
    },
    ["label"],
  );
  return {
    create: {
      description: "Raise a new card (c_N) under your reply. Alone in its call.",
      fields: {
        title: S("The question, short."),
        detail: S("One or two sentences of context."),
        options: {
          type: "array",
          maxItems: CARD_ANSWERS_MAX + CARD_LINKS_MAX,
          description: `The buttons: up to ${CARD_ANSWERS_MAX} answer options (lettered a, b, c…) and up to ${CARD_LINKS_MAX} link options (with link: they open a page and answer nothing). Leave answer options out of a per-item card (every item has choices): its Apply button is the answer, and an "Apply" option would send no item's pick.`,
          items: option,
        },
        items: itemsSchema(orgs),
        choices: {
          type: "array",
          minItems: CARD_CHOICES_MIN,
          maxItems: CARD_CHOICES_MAX,
          items: S(),
          description:
            'Per-item choices for every item without its own (e.g. ["Archive", "Keep"]), lettered a, b…: each item row gets its own control and the user applies them per item in one click ("c_4: 1a Archive, 2b Keep"). An item whose actions differ gives its own choices instead (items.sessions[].choices), lettered per row. Give each item a default from its row\'s list.',
        },
        recommendation: obj({ option: S('The answer option you recommend, by letter ("b").', { pattern: "^[a-z]$" }), why: S("Why, in a sentence.") }, ["why"]),
        replaces: S('An open card this one replaces ("c_3"): it becomes superseded, in the same result.', { pattern: "^c_[1-9][0-9]*$" }),
      },
    },
    answer: {
      description: "Record the user's answer, in their words: a card-level option by its letter, or per item. Every item decided (or a card-level answer) closes it as answered; a partial answer keeps it open.",
      fields: {
        text: S("The user's answer in their words (for a click, the message it sent)."),
        option: S('An answer option\'s letter ("b"). Never a link option.', { pattern: "^[a-z]$" }),
        items: { type: "object", additionalProperties: { type: "string", minLength: 1 }, description: 'Item number → a choice letter or the user\'s words, e.g. {"1": "a", "3": "keep it for now"}.' },
      },
    },
    accept: {
      description: 'The user said "your recommendation": the recommended option, or with items, each named item\'s default. Only what they said it for.',
      fields: { items: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, description: "Item numbers, e.g. [1, 3]." } },
    },
    reopen: { description: "Make an answered or dropped card open again (its answers are cleared).", fields: {} },
    drop: { description: "Close an open card that no longer applies, with why. The user sees the reason.", fields: { reason: S("Why it no longer applies.") } },
    get: { description: "Return the card (every open one when there is no card).", fields: {} },
  };
}

export function cardParameters(orgs: boolean, grants = false) {
  const schemas = opSchemas(orgs, grants);
  const branch = (name: CardOpName) => {
    const { description, fields } = schemas[name];
    return obj({ op: { type: "string", const: name }, ...fields }, ["op", ...CARD_OP_FIELDS[name].required], { description });
  };
  return obj(
    {
      card: S('The card to change, e.g. "c_2". Required while more than one card is open. With create, it is read as replaces (the new card gets the next id).', { pattern: "^c_[1-9][0-9]*$" }),
      ops: { type: "array", minItems: 1, items: { anyOf: CARD_OPS.map(branch) }, description: "Operations on ONE card, applied in order and atomically. create stands alone." },
    },
    ["ops"],
  );
}

export function cardDescription(who: "user" | "operator"): string {
  return (
    `Ask the ${who} with a card under your reply, and record their answer. Each card gets an id c_N; its items are numbered 1..N and its answer options lettered a, b, c…, so "c_4 b" is option b and "c_4 2a" is item 2 taking choice a. ` +
    `A call applies its ops to ONE card atomically (pass card to change an existing one); it never ends your turn. ` +
    `Write your reply first (what you found, and why you ask), then create the card, and name it by its id as a link ("see [c_4](#c_4)": it jumps to the card), never "the card above"; never add a typed fallback ("You can also type…") to a card. ` +
    `A card about specific things (archive, tick, send, …) lists every one of them in items, each with a note: what it is, then why the action fits it, in at most 2 short sentences; an idea or todo a button also acts on says the effect ("… Ticking marks it done."). Every option's reply says exactly what it does to which items. ` +
    `When each item wants its own answer, give choices (and each item a default): an item whose actions differ gives its own choices, lettered for its row only, and the card needs no answer option, since its Apply sends every row's pick at once. ` +
    `A card stays open until you record it: when the ${who} answers (a click arrives as "c_4 b: …" or "c_4: 1a Archive, 2b Keep", each letter its own row's; typed text may name the card, an item number or an option letter), call answer with their words (option, or items) or accept for "your recommendation", in the same run you act on it. Replace a card that changed (create with replaces), drop one that no longer applies. ` +
    `Link options (link) open a session, a page${who === "user" ? ", an org, project or person page" : ""} or an https URL without a turn; use them instead of asking to navigate.`
  );
}

/** Details this tool returned that the branch doesn't show yet (a later call in the same batch), per session. */
const PENDING_MS = 10 * 60_000;

export function cardTool(d: CardToolDeps): Tool {
  const orgs = !!(d.lookup.person && d.lookup.project);
  const pending = new Map<string, { session: string; details: CardDetails; at: number }>();
  /** The branch's cards, plus this tool's own results the branch doesn't hold yet. */
  const cardsNow = (ctx: Ctx): OverseerCard[] => {
    const branch = ctx?.branch() ?? d.branch?.() ?? [];
    const session = ctx?.sessionId ?? "";
    const seen = new Set<string>();
    for (const e of branch) if (e.kind === "tool-result" && e.tool === CARD_TOOL && e.callId) seen.add(e.callId);
    const now = Date.now();
    for (const [id, p] of pending) if (seen.has(id) || now - p.at > PENDING_MS) pending.delete(id);
    const extra = [...pending.values()].filter((p) => p.session === session).map((p) => p.details);
    return foldCardDetails([...branch.map(cardDetailsOf), ...extra]);
  };
  const run = async (params: any, toolCallId: string, ctx: Ctx): Promise<Out> => {
    try {
      const ops = checkCardCall(params);
      let prepared: CardPrepared | undefined;
      const cutNotes: string[] = [];
      if (ops[0]!.op === "create") {
        const o = ops[0]!;
        const items = await resolveConfirmItems(o.items, d.lookup, d.refusal, cutNotes);
        const hrefs: (string | undefined)[] = [];
        const bad: string[] = [];
        for (const [i, opt] of (Array.isArray(o.options) ? o.options : []).entries()) {
          const target = opt && typeof opt === "object" ? (opt as { link?: unknown }).link : undefined;
          if (target === undefined) {
            hrefs.push(undefined);
            continue;
          }
          try {
            if (!target || typeof target !== "object" || Array.isArray(target)) throw d.refusal("link is an object, e.g. {session: \"<id>\"} or {url: \"https://…\"}");
            hrefs.push(await d.link(target as CardLinkInput));
          } catch (err) {
            hrefs.push(undefined);
            bad.push(`options[${i}].link: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (bad.length) throw d.refusal(`No card was shown. ${bad.join(" ")}`);
        prepared = { items, hrefs, clickOnly: await clickOnlyCard(items, d.lookup) };
      }
      const outcome = applyCardCall(cardsNow(ctx), params, { now: new Date().toISOString(), audience: d.audience, grants: d.grants === true, ...(prepared ? { prepared } : {}) });
      if (outcome.details.card || outcome.details.closed) pending.set(toolCallId, { session: ctx?.sessionId ?? "", details: outcome.details, at: Date.now() });
      const cutLine = cutNotes.length ? `\nNotes over ${CONFIRM_NOTE_MAX} characters were cut with "…" (item, length): ${cutNotes.join(", ")}. Keep notes to 2 short sentences.` : "";
      return { content: [{ type: "text", text: outcome.text + cutLine }], details: outcome.details };
    } catch (err) {
      if (err instanceof CardError) throw d.refusal(`${err.message}. Nothing was changed.`);
      throw err;
    }
  };
  return {
    name: CARD_TOOL,
    label: "Card",
    // Its card reads the recorded result (EAGER_TOOLS): never a codemode script's call.
    exposure: "model-only",
    description: cardDescription(d.audience),
    promptSnippet: `ask the ${d.audience} with a card (c_N; items 1..N, options a, b…), and record their answer on it`,
    parameters: cardParameters(orgs, d.grants === true),
    // The cards are shared state: calls in one message apply one after another.
    executionMode: "sequential",
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) =>
      (d.wrap((p) => run(p, toolCallId, ctx as Ctx)) as (...a: unknown[]) => Promise<Out>)(toolCallId, params, signal, onUpdate, ctx),
  } as Tool;
}
