import type { HEntry, ToolCtx, ToolSpec } from "../shared/harness";
import { OFFER_DETAILS_VERSION, OFFER_TOOL, offerToolDescription, offerToolParameters, type OfferDetails, type OfferSnapshot } from "../shared/session-offers";
import { OfferRefusal, offerSnapshotFor, showOffer } from "./session-offers";

/**
 * The `offer` tool (§chat.offers/tool): built only from the session's snapshot, so its declaration
 * never changes for the session; each call reads the project's file again (server/session-offers.ts).
 * Hosted on the server like every served tool; it never ends the turn.
 */

/** The user message the turn answers: once-per-reply's moment. */
const lastUserId = (branch: readonly HEntry[]): string | undefined => {
  for (let i = branch.length - 1; i >= 0; i--) if (branch[i]!.kind === "user") return branch[i]!.id ?? undefined;
  return undefined;
};

export function offerToolSpec(sessionId: string, path: string, snapshot: OfferSnapshot): ToolSpec {
  return {
    name: OFFER_TOOL,
    label: "Offer",
    // Its card reads the recorded result: never a codemode script's call.
    exposure: "model-only",
    description: offerToolDescription(snapshot),
    promptSnippet: "show one of this project's offers: a card of the project's own buttons under your reply",
    parameters: offerToolParameters(snapshot),
    executionMode: "sequential",
    async execute(toolCallId: string, params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: unknown) {
      const p = (params ?? {}) as { offer?: unknown; note?: unknown; rows?: unknown };
      if (typeof p.offer !== "string") throw new Error("offer names one of the offers listed in the tool's description. Nothing was shown.");
      const branch = (ctx as ToolCtx | undefined)?.branch?.() ?? [];
      const replyId = lastUserId(branch);
      try {
        const card = await showOffer({ path, sessionId, offer: p.offer, ...(typeof p.note === "string" ? { note: p.note } : {}), by: "agent", toolCallId, ...(replyId ? { replyId } : {}), ...(p.rows !== undefined ? { rows: p.rows } : {}) });
        const details: OfferDetails = { v: OFFER_DETAILS_VERSION, card };
        return {
          content: [{ type: "text", text: `Shown ${card.id} (${card.name}) under your reply: "${card.title}". The user answers with its buttons; a click arrives as their message, or as a note at your next turn for a button that runs an action.` }],
          details,
        };
      } catch (err) {
        if (err instanceof OfferRefusal) throw new Error(err.message);
        throw err;
      }
    },
  } as ToolSpec;
}

/** The session's `offer` tool, or none: from its snapshot, taken at its first build. */
export async function sessionOfferTools(sessionId: string, path: string, cwd?: string): Promise<ToolSpec[]> {
  const snapshot = await offerSnapshotFor(sessionId, path, cwd).catch((err) => {
    console.warn(`[offers] ${sessionId}: no snapshot (${err instanceof Error ? err.message : String(err)})`);
    return null;
  });
  return snapshot ? [offerToolSpec(sessionId, path, snapshot)] : [];
}
