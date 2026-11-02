import type { ToolSpec } from "../shared/harness";
import { agentTypes, CARD_DETAILS_VERSION, CARD_TOOL, cardToolDescription, cardToolParameters, type CardDetails, type CardSnapshot } from "../shared/transcript-cards";
import { CardRefusal, cardSnapshotFor, raiseCard } from "./transcript-cards";

/**
 * The `card` tool (§chat.transcript-cards/card-tool): built only from the session's snapshot, so its
 * declaration never changes for the session. Hosted on the server like every served tool; a call
 * never ends the turn.
 */
export function cardToolSpec(sessionId: string, path: string, snapshot: CardSnapshot): ToolSpec {
  return {
    name: CARD_TOOL,
    label: "Card",
    // Its card reads the recorded result: never a codemode script's call.
    exposure: "model-only",
    description: cardToolDescription(snapshot),
    promptSnippet: "raise one of this project's transcript cards (a question, a checklist, buttons…) where your call stands",
    parameters: cardToolParameters(snapshot),
    executionMode: "sequential",
    async execute(toolCallId: string, params: unknown) {
      const p = (params ?? {}) as { type?: unknown; data?: unknown; key?: unknown };
      try {
        const card = await raiseCard({ path, sessionId, type: p.type, data: p.data, ...(p.key !== undefined ? { key: p.key } : {}), by: { kind: "agent" }, toolCallId });
        const details: CardDetails = { v: CARD_DETAILS_VERSION, card };
        const answers = card.answerMode === "at-once" ? " The user's answer reaches you as a note at your next turn." : card.answerMode === "gather" ? " The user's answer comes with their next message." : "";
        return { content: [{ type: "text", text: `Raised ${card.id} (${card.type})${card.revision ? `, revision ${card.revision} of "${card.key}"` : ""}.${answers}` }], details };
      } catch (err) {
        if (err instanceof CardRefusal) throw new Error(err.message);
        throw err;
      }
    },
  } as ToolSpec;
}

/** The session's `card` tool, or none: from its snapshot, taken at its first build; only types with a `when` make one. */
export async function sessionCardTools(sessionId: string, path: string, cwd?: string): Promise<ToolSpec[]> {
  const snapshot = await cardSnapshotFor(sessionId, path, cwd).catch((err) => {
    console.warn(`[cards] ${sessionId}: no snapshot (${err instanceof Error ? err.message : String(err)})`);
    return null;
  });
  return snapshot && agentTypes(snapshot).length ? [cardToolSpec(sessionId, path, snapshot)] : [];
}
