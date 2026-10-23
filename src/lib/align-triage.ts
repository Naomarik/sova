// Triage on an alignment card (§app.decisions/align-triage): the chip each open question gets from
// the server's stakes guess, and the key that says when to ask again. Pure: the card and the chat
// view read these, the tests pin them.

import type { AlignStakes, AlignTriage, DecisionProviderId } from "../../shared/protocol";
import { providerName } from "./signals";

const WORD: Record<AlignStakes, string> = {
  "low-risk": "Low risk",
  "deletes-data": "Deletes data",
  "costs-money": "Costs money",
  "changes-architecture-or-contract": "Changes architecture",
};

/** A question's chip: its words, whether it is flagged (the error tone) or low risk (muted ink),
    its tone class, and its source. Never the warn tone of the state chip beside it. */
export function stakesChip(stakes: AlignStakes, src: { provider: DecisionProviderId; model?: string }): { text: string; flagged: boolean; tone: "chip-error" | "text-muted"; title: string } {
  const flagged = stakes !== "low-risk";
  return { text: WORD[stakes], flagged, tone: flagged ? "chip-error" : "text-muted", title: `Guessed by ${providerName(src.provider, src.model)}.` };
}

/** The open cards' versions, "al_1@3 al_4@1": a new version (or a new open card) is a new read. */
export const triageKey = (docs: readonly { id: string; rev: number; open: boolean }[]): string =>
  docs
    .filter((d) => d.open)
    .map((d) => `${d.id}@${d.rev}`)
    .sort()
    .join(" ");

/** One card's answer, only when it answered this version. */
export function triageOf(t: AlignTriage | undefined, doc: string, rev: number): AlignTriage["docs"][string] | undefined {
  const d = t?.docs[doc];
  return d && d.rev === rev ? d : undefined;
}
