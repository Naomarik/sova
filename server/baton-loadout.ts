import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  BATON_DECISION_ENTRY,
  BATON_DONE_ENTRY,
  BATON_ENTRY,
  BATON_HANDOFF_ENTRY,
  BATON_LEASE_ENTRY,
  BATON_OFFER_ENTRY,
  BATON_PROPOSAL_ENTRY,
  LIMIT_QUESTION,
  OPERATOR,
  type BatonDecisionData,
  type BatonDoneData,
  type BatonHandoffData,
  type BatonLeaseData,
  type BatonOfferData,
  type BatonProposalData,
  type BatonSession,
  type PersonRef,
} from "../shared/baton";
import {
  BRIEFING_MAX,
  QUESTION_MAX,
  allBatons,
  batonById,
  batonOfPath,
  budgetSpent,
  currentOffer,
  expireLease,
  handTo,
  lapsedLeases,
  leaseMs,
  markDone,
  moveRefusal,
  nameOf,
  namesOf,
  noteMessage,
  offerRefusal,
  resolveTarget,
  sessionPathOf,
  setReplyProbe,
  startOffer,
  touchLease,
  undoNote,
} from "./baton";
import { revokeLinks } from "./baton-links";
import { ownerAreaChoices, pickOwnerArea } from "./decisions";
import { OWNER_AREA_NONE } from "../shared/decisions";
import type { Person } from "../shared/orgs";
import { emitBatonEvent } from "./baton-events";
import { handoffChosen } from "./baton-guards";
import { authorNotes, labelAuthors, streamingText } from "./baton-view";
import { runWrapup, wantsWrapup, WRAPUP_SYSTEM, WRAPUP_TOOL, wrapupActive, wrapupTool } from "./baton-wrapup";
import { acquireChat, BusyError, type ChatSession, isSessionBusy, RefusedError, registerSpecialLoadout } from "./chat-manager";
import { applyChange, contactProblems, holderSteering, onPersonLeft, operatorName, OrgError, participantLine, profileRedactTexts, proposedGaps, publicTerms, readRoster } from "./orgs";
import { redactExtensionMessages, serverRedactor } from "./overseer-redact";
import { refreshShare, streamShare } from "./share/hub";
import { loadDefaults } from "./web-defaults";
import { redactPhrases, secretPhrases } from "./baton-view";

/**
 * The baton runtime (§app.baton/goal-and-loadout, /hand-off): what a baton session file opens with.
 *
 * - NO pi-config extension, skill, prompt template, theme or context file: `noExtensions` and
 *   friends, verified (the §3.0 spike) to leave `extensionFactories` loading, so the inline
 *   `sova-baton` extension is the only one. Nothing of the operator's setup (vision-delegate's
 *   input handler, the mode extension, APPEND_SYSTEM.md) touches an outsider's conversation.
 * - The SDK tool list is exactly the three tools below: `tools` IS the allowlist, and naming no
 *   built-in leaves the model no file, shell or subagent access.
 * - The system prompt is Sova's, rendered at the start of every run from the registry and the
 *   roster as they are then; the prompt's cwd line is blanked, and it never names the org (an
 *   outsider learns nothing of it beyond the public title).
 */

/** The tools a baton conversation has. */
export const BATON_TOOLS = ["hand_to", "goal_done", "record_decision", "propose_roster_edit"] as const;
/** The runtime's allowlist: the conversation's tools plus the wrap-up's, which is active only
    during the wrap-up turn (and refuses outside it). */
export const LOADOUT_TOOLS = [...BATON_TOOLS, WRAPUP_TOOL] as const;
const PROMPT_FILE = join(import.meta.dirname, "baton-prompt.md");

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** The system prompt for the session's next run. */
export function renderBatonPrompt(sessionId: string, template = readFileSync(PROMPT_FILE, "utf8")): string {
  const hit = batonById(sessionId);
  if (!hit) throw new Error("Unknown baton session");
  const row = hit.row;
  const roster = readRoster(row.orgId);
  const holder = row.holder && row.holder !== OPERATOR ? roster.find((p) => p.id === row.holder) : undefined;
  const others = roster.filter((p) => p.status === "active" && p.id !== holder?.id);
  // People who left (not declined referrals: those were never with the org), so a name the holder
  // mentions is known to be gone rather than new (§app.organizations/roster).
  const former = roster.filter((p) => p.status === "left" && !p.referral);
  const values: Record<string, string> = {
    OPERATOR: operatorName(),
    TITLE: row.publicTitle,
    GOAL: row.goal,
    HOLDER: row.holder === OPERATOR ? `${operatorName()} (the operator)` : (holder?.name ?? "nobody (the conversation is over)"),
    HOLDER_ROLE: holder?.role ? `, ${holder.role}` : "",
    STEERING: holder ? holderSteering(holder) : "",
    PEOPLE: others.length ? others.map(participantLine).join("\n") : "(nobody else on the roster yet)",
    OWNERS: ownersBlock(roster, holder?.id),
    FORMER: former.length
      ? `\n# People who have left the organization\n\nNever hand to them or propose them as new people. If someone names one of them, say they have left and ask who covers their area now.\n\n${former.map((p) => `- ${p.name}${p.role ? ` — was ${p.role}` : ""}`).join("\n")}\n`
      : "",
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => values[k] ?? "");
}

/** The private "who decides what" list (§app.requirements/owner-area): every active person, the
    holder included, with their job title and decision areas. Only for picking an owner area. */
function ownersBlock(roster: readonly Person[], holderId: string | undefined): string {
  const lines = roster
    .filter((p) => p.status === "active")
    .map((p) => `- ${p.name}${p.id === holderId ? " (the person you are talking to)" : ""}${p.role ? ` — ${p.role}` : ""}: ${p.decides.length ? p.decides.join(", ") : "(no decision areas)"}`);
  return lines.length ? lines.join("\n") : "(nobody on the roster yet)";
}

/** record_decision's `ownerArea` parameter: the roster's owner areas as they are now, and "none". */
export function ownerAreaSchema(roster: readonly Person[]) {
  const choices = ownerAreaChoices(roster);
  return {
    type: "string",
    enum: [...choices, OWNER_AREA_NONE],
    description: `Who decides it: the one decision area from "Who decides what" that covers it, exactly as written there, or "${OWNER_AREA_NONE}" when none does.`,
  };
}

/**
 * Stop the reply being written, for an operator's move that can't wait (Take back, a hand-off, an
 * offer, someone leaving; §app.baton/hand-off "at any time"). Nothing queued behind the reply is
 * dropped: every message still waiting enters the transcript as its sender's, after the stopped
 * reply and before the move's entry, with no reply of its own (counted when it was accepted), so
 * whoever holds the baton next reads it and the model sees it with the next turn. A queue wake
 * could start another run as this one settles, so it checks again, a few times at most.
 */
async function interruptReply(chat: ChatSession): Promise<void> {
  const since = chat.leafId();
  const kept = [];
  for (let i = 0; i < 3 && (chat.session.isStreaming || chat.isCompacting() || chat.turnStarting); i++) {
    // A turn that is starting (a message just handed over) can't be aborted until its run begins.
    await chat.whenStarted();
    kept.push(...(await chat.stopRun(() => true)));
  }
  chat.enterQueued(kept, since);
}

/** Move the baton from outside a turn (Take back, the budget stop): registry, then the transcript
    entry through the session's runtime, then every share page. `interrupt`: an operator's move,
    which stops a reply in flight instead of waiting for it. */
export async function moveBaton(sessionId: string, to: PersonRef, question: string, briefing = "", opts: { interrupt?: boolean } = {}): Promise<number> {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  const chat = await acquireChat(sessionPathOf(hit.dir, hit.row));
  // A turn that is starting is a reply in flight too.
  if (chat.session.isStreaming || chat.turnStarting) {
    if (!opts.interrupt) throw new OrgError("Wait for the reply to finish first.", 409);
    // A move that would be refused leaves the reply alone.
    const refused = moveRefusal(batonById(sessionId)?.row ?? hit.row, to);
    if (refused) throw refused;
    await interruptReply(chat);
  }
  const { n, from } = handTo(sessionId, to, question, briefing);
  chat.appendSpecialEntry(BATON_HANDOFF_ENTRY, { v: 1, n, from, to, question, briefing } satisfies BatonHandoffData);
  refreshShare(sessionId);
  return n;
}

export { LIMIT_QUESTION };

/**
 * The budget stop (§app.baton/goal-and-loadout): once a session's messages reach its limit, the
 * baton goes to the operator and the session needs them — after the reply to the last message, or
 * at once when a person tries to write past it. A no-op unless a person (or an offer's pool) holds
 * an open session at its limit. Best effort: a refusal (a reply still running) is logged, and the
 * next settle or share message tries again.
 */
export async function budgetStop(sessionId: string): Promise<void> {
  const row = batonById(sessionId)?.row;
  if (!row || row.state !== "open" || row.holder === OPERATOR || !budgetSpent(row)) return;
  try {
    await moveBaton(sessionId, OPERATOR, LIMIT_QUESTION);
  } catch (err) {
    console.warn(`[baton] budget stop on ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Offer the baton to several people at once (§app.baton/offers-and-leases), from outside a turn:
 * registry (withdrawing any current offer), then the `sova-baton-offer` entry through the
 * session's runtime, then every share page. Returns one token per invitee.
 */
export async function offerBaton(sessionId: string, to: readonly unknown[], question: string, briefing = "", opts: { mintLink?: boolean; interrupt?: boolean } = {}) {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  const chat = await acquireChat(sessionPathOf(hit.dir, hit.row));
  if (chat.session.isStreaming || chat.turnStarting) {
    if (!opts.interrupt) throw new OrgError("Wait for the reply to finish first.", 409);
    const refused = offerRefusal(batonById(sessionId)?.row ?? hit.row, to);
    if (refused) throw refused;
    await interruptReply(chat);
  }
  const out = startOffer(sessionId, to, question, briefing, new Date(), opts.mintLink !== false);
  chat.appendSpecialEntry(BATON_OFFER_ENTRY, {
    v: 1,
    n: out.n,
    offerId: out.offer.id,
    from: out.from,
    to: out.offer.to,
    question: out.offer.question,
    briefing: out.offer.briefing,
  } satisfies BatonOfferData);
  refreshShare(sessionId);
  return out;
}

/** Lease entries that met a reply in flight, per session file: written when the run settles. */
const pendingLease = new Map<string, Omit<BatonLeaseData, "v">[]>();

/** Record a lease event in the transcript. Mid-reply the transcript takes no entry, so it waits
    for the reply's end (flushLeases) rather than being lost: the registry already has it. */
export function recordLease(chat: ChatSession, data: Omit<BatonLeaseData, "v">): void {
  const waiting = pendingLease.get(chat.path);
  if (waiting) {
    waiting.push(data);
    return;
  }
  try {
    chat.appendSpecialEntry(BATON_LEASE_ENTRY, { v: 1, ...data } satisfies BatonLeaseData);
  } catch (err) {
    if (err instanceof BusyError) pendingLease.set(chat.path, [data]);
    else console.warn(`[baton] lease entry not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Write the lease entries a reply held back, in order (after the run settled). */
export async function flushLeases(path: string): Promise<void> {
  const waiting = pendingLease.get(path);
  if (!waiting) return;
  const chat = await acquireChat(path);
  if (chat.session.isStreaming || chat.isCompacting()) return; // the next settle writes them
  pendingLease.delete(path);
  for (const data of waiting) recordLease(chat, data);
}

/** A share message was accepted (server/share/routes.ts): write what the lease did on the way. */
export function recordNoted(chat: ChatSession, by: PersonRef, noted: ReturnType<typeof noteMessage>): void {
  const renewedOwn = !!noted.claimed && noted.expired?.by === by;
  if (noted.expired && !renewedOwn) recordLease(chat, { n: noted.expired.n, offerId: noted.expired.offerId, event: "expired", by: noted.expired.by });
  if (noted.claimed && !renewedOwn) recordLease(chat, { n: noted.claimed.n, offerId: noted.claimed.offerId, event: "claimed", by });
}

/**
 * The lease ticker: a lapsed lease goes back to the pool and every waiting page is told (they may
 * write again). The message route enforces the lease on its own (a lapsed lease is claimable there
 * even between ticks); this only makes the change visible. Skips a session mid-reply: the reply's
 * end renews the lease.
 */
export async function tickLeases(now = Date.now()): Promise<void> {
  for (const sessionId of lapsedLeases(now)) {
    const hit = batonById(sessionId);
    if (!hit) continue;
    try {
      const chat = await acquireChat(sessionPathOf(hit.dir, hit.row));
      if (chat.session.isStreaming) continue;
      const expired = expireLease(sessionId, now);
      if (!expired) continue;
      recordLease(chat, { n: expired.n, offerId: expired.offerId, event: "expired", by: expired.by });
      refreshShare(sessionId);
    } catch (err) {
      console.warn(`[baton] lease tick on ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
/**
 * Someone was marked left (§app.organizations/roster: only active people take part). Their links
 * stop at once, every one (410): they are no longer with the organization, so they don't read its
 * conversations either. A session they hold, or an offer waiting on a pool they are in, goes to
 * the operator (Needs you says so), stopping a reply in flight. An offer someone else holds carries
 * on; the message route refuses them if it lapses back to the pool.
 */
export async function personLeft(orgId: string, personId: string): Promise<void> {
  revokeLinks((l) => l.orgId === orgId && l.personId === personId);
  const name = nameOf(orgId, personId);
  const affected = (sessionId: string): "holder" | "invitee" | null => {
    const row = batonById(sessionId)?.row;
    if (!row || (row.state !== "open" && row.state !== "needs-you")) return null;
    if (row.holder === personId) return "holder";
    const o = currentOffer(row);
    return o && o.state === "open" && o.to.includes(personId) ? "invitee" : null;
  };
  for (const row of allBatons().filter((r) => r.orgId === orgId)) {
    refreshShare(row.sessionId);
    if (!affected(row.sessionId)) continue;
    try {
      const hit = batonById(row.sessionId)!;
      await interruptReply(await acquireChat(sessionPathOf(hit.dir, hit.row)));
      // The reply may itself have moved the baton on before it stopped: decide on the row as it is now.
      const why = affected(row.sessionId);
      if (!why) continue;
      await moveBaton(row.sessionId, OPERATOR, why === "holder" ? "(left the organization)" : `(${name} left the organization; offer withdrawn)`, "", { interrupt: true });
    } catch (err) {
      console.warn(`[baton] moving ${row.sessionId.slice(0, 8)} off a person who left: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
onPersonLeft((orgId, personId) => void personLeft(orgId, personId));

// A lease never lapses while a reply to its holder is being written (the reply's end renews it).
setReplyProbe((sessionId) => {
  const hit = batonById(sessionId);
  return !!hit && isSessionBusy(sessionPathOf(hit.dir, hit.row));
});

/** Every 30 s, or a quarter of a shortened lease (hermetic tests). */
const LEASE_TICK_MS = Math.max(1000, Math.min(30_000, Math.floor(leaseMs() / 4)));
setInterval(() => void tickLeases(), LEASE_TICK_MS).unref();

/** Start the wrap-up of a session that wants one (after its run settles, or on close). */
export function scheduleWrapup(sessionId: string, delayMs = 50): void {
  const t = setTimeout(() => {
    const row = batonById(sessionId)?.row;
    if (!row || !wantsWrapup(row)) return;
    void runWrapup(sessionId, BATON_TOOLS).catch((err) => console.warn(`[baton] wrap-up of ${sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`));
  }, delayMs);
  t.unref?.();
}

type AppendEntry = (customType: string, data: unknown) => void;

/** The three tools, bound to one session. `append` is the extension's own appendEntry. */
export function batonTools(sessionId: string, append: AppendEntry): ToolDefinition<any, any>[] {
  const hit = batonById(sessionId);
  const roster = hit ? readRoster(hit.row.orgId) : [];
  const [handTo, goalDone, ...rest] = conversationTools(sessionId, append);
  return [handTo!, goalDone!, recordDecisionTool(sessionId, append, roster), ...rest];
}

/** record_decision, its owner areas listed as the roster has them now (the call itself always
    checks the roster as it is then). */
export function recordDecisionTool(sessionId: string, append: AppendEntry, roster: readonly Person[]): ToolDefinition<any, any> {
  return {
    name: "record_decision",
    label: "Record decision",
    description: "Record a decision the person you are talking to just stated, with their exact words. The conversation carries on.",
    parameters: obj(
      {
        area: str('The topic of the decision, a few words ("invoicing", "bank access").'),
        ownerArea: ownerAreaSchema(roster),
        statement: str("The decision in one sentence."),
        quote: str("Their exact words."),
      },
      ["area", "ownerArea", "statement", "quote"],
    ) as any,
    // Before pi's schema check: a case or spacing variant becomes the roster's spelling, and an
    // unknown value is refused with every choice named (the enum's own error names none).
    prepareArguments(args: unknown) {
      const hit = batonById(sessionId);
      if (!hit || typeof args !== "object" || args === null) return args as any;
      const owner = pickOwnerArea(readRoster(hit.row.orgId), (args as { ownerArea?: unknown }).ownerArea);
      if (!owner.ok) throw new Error(owner.error);
      return { ...(args as object), ownerArea: owner.ownerArea } as any;
    },
    async execute(_id, params: any, _signal, _update, ctx) {
      const hit = batonById(sessionId);
      if (!hit) throw new Error("This conversation is no longer registered.");
      const area = clip(params.area, 60);
      const statement = clip(params.statement, 500);
      const quote = clip(params.quote, 1000);
      if (!area || !statement || !quote) throw new Error("Give the area, the statement and their exact words.");
      const owner = pickOwnerArea(readRoster(hit.row.orgId), params.ownerArea);
      if (!owner.ok) throw new Error(owner.error);
      append(BATON_DECISION_ENTRY, { v: 1, area, ownerArea: owner.ownerArea, statement, quote, by: hit.row.holder ?? OPERATOR } satisfies BatonDecisionData);
      const leaf = ctx?.sessionManager?.getLeafId?.();
      const entry = leaf ? (ctx.sessionManager.getEntry(leaf) as { type?: string; customType?: string } | undefined) : undefined;
      emitBatonEvent({
        type: "decision",
        orgId: hit.row.orgId,
        projectId: hit.row.projectId,
        sessionId,
        ...(leaf && entry?.type === "custom" && entry.customType === BATON_DECISION_ENTRY ? { entryId: leaf } : {}),
      });
      refreshShare(sessionId);
      // pi ends the run only when EVERY tool of the batch terminates: when this call rides with a
      // hand_to or goal_done, it must agree, or the model writes one more reply after the turn ended.
      return { ...say("Recorded."), ...(batchEndsTurn(ctx?.sessionManager) ? { terminate: true } : {}) };
    },
  };
}

/** hand_to, goal_done and propose_roster_edit. */
function conversationTools(sessionId: string, append: AppendEntry): ToolDefinition<any, any>[] {
  return [
    {
      name: "hand_to",
      label: "Hand to",
      description:
        "Hand the conversation to another person on the roster (by name or id), or to the operator (\"operator\"). " +
        "Give the question you need them to answer and a briefing written for them. Ends your turn.",
      parameters: obj(
        {
          person: str('The person\'s name or id from the roster, or "operator".'),
          question: str("What you need them to answer, in one or two sentences."),
          briefing: str("For them only, in their language: who asked, what is known so far, what exactly you need."),
        },
        ["person", "question", "briefing"],
      ) as any,
      async execute(_id, params: any, _signal, _update, ctx) {
        const hit = batonById(sessionId);
        if (!hit) throw new Error("This conversation is no longer registered.");
        const row = hit.row;
        if (row.state === "done" || row.state === "closed") throw new Error(`This conversation is ${row.state}.`);
        const target = resolveTarget(readRoster(row.orgId), String(params.person ?? ""), operatorName());
        if (!target.ok) throw new Error(target.error);
        // The person talking chooses who answers next, unless the operator's goal already did.
        if (row.holder && row.holder !== OPERATOR && target.ref !== OPERATOR) {
          const [holderName, targetName] = [nameOf(row.orgId, row.holder), nameOf(row.orgId, target.ref)];
          if (!handoffChosen(ctx?.sessionManager?.getBranch() ?? [], row.holder, targetName, row.goal))
            throw new Error(
              `Not handed over: ${holderName} has not chosen ${targetName}. Tell ${holderName} who could answer (name and decision area, from the list) and ask them to choose; hand over once they name or confirm someone.`,
            );
        }
        const question = clip(params.question, QUESTION_MAX);
        const briefing = clip(params.briefing, BRIEFING_MAX);
        if (!question) throw new Error("Give the question you need them to answer.");
        const { n, from } = handTo(sessionId, target.ref, question, briefing);
        append(BATON_HANDOFF_ENTRY, { v: 1, n, from, to: target.ref, question, briefing } satisfies BatonHandoffData);
        refreshShare(sessionId);
        if (target.ref === OPERATOR) emitBatonEvent({ type: "asked-operator", orgId: row.orgId, projectId: row.projectId, sessionId, question });
        const who = nameOf(row.orgId, target.ref);
        return { ...say(`Handed to ${who}. Your turn has ended.`), terminate: true };
      },
    },
    {
      name: "goal_done",
      label: "Goal done",
      description: "The goal is met and the answers are checked. Give a short summary of what was established. Ends the conversation.",
      parameters: obj({ summary: str("What was established, in a few sentences. Everyone in the conversation sees it: say it in your own words (never the goal's), and name people by name only, never by role or job title.") }, ["summary"]) as any,
      async execute(_id, params: any) {
        const summary = clip(params.summary, BRIEFING_MAX);
        if (!summary) throw new Error("Give a summary of what was established.");
        markDone(sessionId);
        append(BATON_DONE_ENTRY, { v: 1, summary } satisfies BatonDoneData);
        refreshShare(sessionId);
        return { ...say("Recorded as done. The conversation is over."), terminate: true };
      },
    },
    {
      name: "propose_roster_edit",
      label: "Propose a person",
      description:
        "Propose adding someone who is not on the roster, as the person you are talking to referred them. Needs their full name, " +
        "at least one contact channel, their role, why they are the right person, and the referrer's exact words. " +
        "The operator approves them before anyone can hand to them. The conversation carries on.",
      parameters: obj(
        {
          name: str("Their full name."),
          role: str('Their role ("IT lead").'),
          contact: {
            type: "object",
            additionalProperties: false,
            properties: { email: str("Email"), phone: str("Phone"), whatsapp: str("WhatsApp"), other: str('Any other channel ("Slack: @bob")') },
            description: "At least one way to reach them.",
          },
          why: str("Why they are the right person, in one sentence."),
          quote: str("The exact words of the person who referred them."),
          decides: { type: "array", items: { type: "string" }, description: "Decision areas they own, if said." },
        },
        ["name", "role", "contact", "why", "quote"],
      ) as any,
      async execute(_id, params: any) {
        const hit = batonById(sessionId);
        if (!hit) throw new Error("This conversation is no longer registered.");
        const row = hit.row;
        if (row.state === "done" || row.state === "closed") throw new Error(`This conversation is ${row.state}.`);
        const referrer = row.holder ?? OPERATOR;
        const referrerName = nameOf(row.orgId, referrer);
        const name = clip(params.name, 80);
        const role = clip(params.role, 300);
        const why = clip(params.why, 300);
        const quote = clip(params.quote, 300);
        const contact = typeof params.contact === "object" && params.contact !== null ? params.contact : {};
        const roster = readRoster(row.orgId);
        const same = roster.find((p) => name && p.name.toLowerCase() === name.toLowerCase() && p.status !== "left");
        const former = same ? undefined : roster.find((p) => name && p.name.toLowerCase() === name.toLowerCase() && p.status === "left");
        if (former)
          throw new Error(
            former.referral
              ? `${former.name} was proposed before and the operator declined. Ask ${referrerName} who else could answer.`
              : `${former.name} has left the organization. Tell ${referrerName} so and ask who covers their area now; if this is a different person with the same name, hand to the operator.`,
          );
        if (same?.status === "active") throw new Error(`${same.name} is already on the roster: hand_to them if they should answer.`);
        if (same?.status === "proposed") throw new Error(`${same.name} was already proposed and waits for the operator's approval. Hand to the operator if you need them now.`);
        const gaps = proposedGaps({ name, role, contact, referral: { why, referredBy: referrer } });
        const bad = contactProblems(contact);
        if (bad.length) gaps.push(`a real contact channel (${bad.join("; ")}; never write a placeholder)`);
        if (!quote) gaps.push(`${referrerName}'s exact words referring them`);
        if (gaps.length)
          throw new Error(`Not recorded yet: still missing ${gaps.join(", ")}. Ask ${referrerName} for it, then call propose_roster_edit again with everything.`);
        let person;
        try {
          person = applyChange(
            row.orgId,
            null,
            {
              name,
              status: "proposed",
              role,
              contact,
              ...(Array.isArray(params.decides) ? { decides: params.decides } : {}),
              referral: { why, referredBy: referrer, sessionId, quote },
            },
            { kind: "referral", sessionId, quote },
          );
        } catch (err) {
          throw new Error(`Not recorded: ${err instanceof Error ? err.message : String(err)} Ask ${referrerName} and try again.`);
        }
        append(BATON_PROPOSAL_ENTRY, { v: 1, personId: person.id, name: person.name, role: person.role, why, by: referrer } satisfies BatonProposalData);
        emitBatonEvent({ type: "proposal", orgId: row.orgId, projectId: row.projectId, sessionId });
        return say(
          `Proposed ${person.name}. The operator must approve them before anyone can hand the conversation to them. ` +
            `Tell ${referrerName} so; if you need ${person.name}'s answer to go on, hand_to the operator.`,
        );
      },
    },
    wrapupTool(sessionId),
  ];
}

/** Whether the assistant message that made the current tool calls also calls a turn-ending tool. */
function batchEndsTurn(sm: { getBranch(): readonly any[] } | undefined): boolean {
  const branch = sm?.getBranch() ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    const content = Array.isArray(e.message.content) ? e.message.content : [];
    return content.some((b: any) => b?.type === "toolCall" && (b.name === "hand_to" || b.name === "goal_done"));
  }
  return false;
}

/** The text of the people's messages in a model context (the conversation's own words). */
const userTexts = (messages: readonly unknown[]): string[] =>
  messages.flatMap((m) => {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "user") return [];
    return [typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((b: any) => (b?.type === "text" ? String(b.text ?? "") : "")).join("") : ""];
  });

/** The holder's profile phrases that are secrets in this model context: none that is ordinary
    vocabulary (a name, role, decision area, the title, or what someone wrote here). */
export function holderPhrases(row: Pick<BatonSession, "orgId" | "holder" | "publicTitle">, messages: readonly unknown[]): string[] {
  if (!row.holder || row.holder === OPERATOR) return [];
  const roster = readRoster(row.orgId);
  const holder = roster.find((p) => p.id === row.holder);
  return holder ? secretPhrases(profileRedactTexts(holder), [...publicTerms(roster), row.publicTitle, ...userTexts(messages)]) : [];
}

/** Redact message text for the model's own context: secrets everywhere, and the holder's profile
    phrases from the model's own earlier replies. What people wrote reaches it as they wrote it. */
export function redactContext<M>(messages: M[], phrases: readonly string[]): M[] {
  const secrets = serverRedactor();
  const redactMsgs = redactExtensionMessages(messages, secrets);
  if (!phrases.length) return redactMsgs;
  let changed = redactMsgs !== messages;
  const out = redactMsgs.map((m) => {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "assistant") return m;
    if (typeof msg.content === "string") {
      const t = redactPhrases(msg.content, phrases);
      if (t === msg.content) return m;
      changed = true;
      return { ...msg, content: t } as M;
    }
    if (!Array.isArray(msg.content)) return m;
    let hit = false;
    const content = msg.content.map((b: any) => {
      if (b?.type !== "text" || typeof b.text !== "string") return b;
      const t = redactPhrases(b.text, phrases);
      if (t === b.text) return b;
      hit = true;
      return { ...b, text: t };
    });
    if (!hit) return m;
    changed = true;
    return { ...msg, content } as M;
  });
  return changed ? out : messages;
}

const isBatonMarked = (sm: { getEntries(): readonly any[] }) => sm.getEntries().some((e) => e.type === "custom" && e.customType === BATON_ENTRY);

registerSpecialLoadout({
  kind: "baton",
  // The org's workspace repo on THIS host: a restored clone lives elsewhere than the header's cwd.
  cwd: (path) => batonOfPath(path)?.dir ?? null,
  // The marker AND a registry row in an attached org: a copy of the file anywhere else (a fork, a
  // detached org) opens as an ordinary session.
  matches: (sm, path) => isBatonMarked(sm) && !!batonOfPath(path),
  async loadout(path) {
    const hit = batonOfPath(path);
    if (!hit) throw new Error("Not a registered baton session.");
    const sessionId = hit.row.sessionId;
    const defaults = loadDefaults();
    return {
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // Not the operator's APPEND_SYSTEM.md: nothing of their own setup reaches an outsider's model.
        appendSystemPromptOverride: () => [],
        extensionFactories: [
          {
            name: "sova-baton",
            factory: (pi) => {
              const append: AppendEntry = (type, data) => pi.appendEntry(type, data);
              for (const t of batonTools(sessionId, append)) pi.registerTool(t);
              let offered = JSON.stringify(ownerAreaSchema(readRoster(hit.row.orgId)).enum);
              pi.on("before_agent_start", (event) => {
                // The owner areas follow the roster: a change reaches the schema at the next run
                // (§app.requirements/owner-area). Re-registering refreshes the tool registry, which
                // re-activates every allowed tool, so the conversation's own set is restored.
                if (!wrapupActive(sessionId)) {
                  const roster = readRoster(hit.row.orgId);
                  const now = JSON.stringify(ownerAreaSchema(roster).enum);
                  if (now !== offered) {
                    offered = now;
                    pi.registerTool(recordDecisionTool(sessionId, append, roster));
                    pi.setActiveTools([...BATON_TOOLS]);
                  }
                }
                const o = event.systemPromptOptions;
                o.customPrompt = wrapupActive(sessionId) ? WRAPUP_SYSTEM : renderBatonPrompt(sessionId);
                o.appendSystemPrompt = "";
                o.contextFiles = [];
                o.skills = [];
                o.cwd = "(none)";
              });
              pi.on("context", (event, ctx) => {
                const row = batonById(sessionId)?.row;
                const redacted = redactContext(event.messages, row ? holderPhrases(row, event.messages) : []);
                // Who wrote each message, added after the redaction (names are no secret).
                const branch = (ctx?.sessionManager?.getBranch() ?? []) as Record<string, any>[];
                const messages = row ? labelAuthors(redacted, authorNotes(branch, namesOf(row.orgId), row.holder), event.messages) : redacted;
                return messages === event.messages ? undefined : { messages };
              });
            },
          },
        ],
      },
      tools: [...LOADOUT_TOOLS],
      model: hit.row.model ?? defaults.model ?? null,
      thinking: hit.row.thinking ?? defaults.thinking ?? null,
    };
  },
  async opened(chat) {
    // The wrap-up's tool is in the allowlist, and active only during the wrap-up turn.
    chat.session.setActiveToolsByName([...BATON_TOOLS]);
  },
  watchSession(session, path) {
    const sessionId = batonOfPath(path)?.row.sessionId;
    if (!sessionId) return;
    session.subscribe((event) => {
      const e = event as { type: string; message?: { role?: string } };
      // The wrap-up's words are nobody's business on a share page.
      if (e.type === "message_update" && e.message?.role === "assistant") {
        if (!wrapupActive(sessionId)) streamShare(sessionId, streamingText(e.message));
      } else if (e.type === "message_end" || e.type === "agent_settled" || e.type === "entry_appended") refreshShare(sessionId);
      if (e.type === "agent_settled") {
        // Lease entries that arrived mid-reply (the transcript takes none then).
        setTimeout(() => void flushLeases(path).catch(() => {}), 0);
        if (!wrapupActive(sessionId)) {
          // The reply renews the holder's lease (the later of their message and the reply).
          touchLease(sessionId);
          // goal_done (or a close mid-turn) ended it: the wrap-up runs once this run is over.
          scheduleWrapup(sessionId);
          // The reply to the last message the limit allows: the baton goes to the operator.
          setTimeout(() => void budgetStop(sessionId), 50).unref?.();
        }
      }
    });
  },
  clientSend(path, msg) {
    const hit = batonOfPath(path);
    if (!hit) throw new RefusedError("Not a registered baton session.");
    // Text only, both ways (§app.baton/outsider-view): the operator's images never reach the model.
    if (msg.images > 0) throw new RefusedError("A hand-off session is text only: images can't be sent.");
    const sessionId = hit.row.sessionId;
    let noted: ReturnType<typeof noteMessage>;
    try {
      noted = noteMessage(sessionId, OPERATOR);
    } catch (err) {
      // Someone else holds the baton, it is done, the budget is spent: a refusal, said as it is.
      if (err instanceof OrgError) throw new RefusedError(err.message);
      throw err;
    }
    refreshShare(sessionId);
    // The runtime refused the message after all: it neither counts nor clears Needs you.
    return {
      by: OPERATOR,
      undo: () => {
        undoNote(sessionId, noted);
        refreshShare(sessionId);
      },
    };
  },
  refuses(gesture) {
    if (gesture === "mode") return "A baton session has no mode.";
    return "Every message in a baton session is someone's: it can't be rewound or regenerated.";
  },
});
