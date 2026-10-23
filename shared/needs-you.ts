import type { AttentionItem } from "./protocol";

/**
 * Whether a digest item lists in Needs you (§app.session-list/needs-you), and so counts in the
 * Overseer's "need you" (§app.overseer/attention-digest): ONE rule for both, so the two numbers
 * agree. Every act item (a blocker), a roster proposal, and a soft item (a turn card's guess:
 * `asks-you`, `unverified`).
 */
export const listsInNeedsYou = (it: Pick<AttentionItem, "tier" | "kind" | "soft">): boolean =>
  it.tier === "act" || it.kind === "roster-proposal" || it.soft === true;
