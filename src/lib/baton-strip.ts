// The baton strip's words (§app/baton): who has the baton, or the offer, in one phrase. Pure, so
// every state is pinned by tsx --test.

import { OPERATOR, type BatonInfo, type BatonSummaryField, type OfferLink, type WrapupInfo } from "../../shared/baton";

/** "Ana", "Ana and Bob", "Ana, Bob, and Carl" (serial comma). */
export function namesList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Whole minutes left on a lease, never below 0. */
export const leaseMinutes = (leaseUntil: string, now: number): number => Math.max(0, Math.ceil((Date.parse(leaseUntil) - now) / 60_000));

/** The current offer, when the session's baton is out as one right now. */
export function liveOffer(i: Pick<BatonInfo, "offer" | "session">): NonNullable<BatonInfo["offer"]> | null {
  const o = i.offer;
  return o && i.session.offerId === o.id && o.state !== "withdrawn" ? o : null;
}

/** The strip's phrase for where the baton is. */
export function whereLine(i: Pick<BatonInfo, "offer" | "session" | "names">, now: number): string {
  const s = i.session;
  if (s.state === "done") return "done";
  if (s.state === "closed") return "closed";
  const offer = liveOffer(i);
  if (offer) {
    const invited = namesList(offer.to.map((p) => p.name));
    if (offer.state === "held" && offer.holder) {
      const ms = offer.leaseUntil ? Date.parse(offer.leaseUntil) - now : null;
      const left = offer.leaseUntil ? leaseMinutes(offer.leaseUntil, now) : null;
      const quiet = ms === null ? "" : ms < 60_000 ? " — theirs for less than a minute more of quiet" : ` — theirs for ${left} more ${left === 1 ? "minute" : "minutes"} of quiet`;
      return `${offer.holder.name} is answering (offered to ${invited})${quiet}`;
    }
    // Someone answered before and went quiet: the offer is open again, not untouched.
    return offer.lastActivityAt ? `offered to ${invited} — open again; nobody is answering right now` : `offered to ${invited} — nobody has answered yet`;
  }
  if (s.holder === OPERATOR) return s.budget && s.budget.messagesUsed >= s.budget.messagesMax ? "with you — extend the limit to write" : "with you — you can write now";
  if (s.holder) return `with ${i.names[s.holder] ?? "someone"} — you can write once you take it back`;
  return "with nobody";
}

/**
 * Links on screen belong to one hand-off (`at`, its number). They go only once a LATER hand-off
 * exists: never on a refetch, an unchanged count, or an info not read yet (undefined) — a reset on
 * any change of the count wiped a link the moment the refetch after minting it landed.
 */
export const linksStale = (at: number | null, count: number | undefined): boolean => at !== null && count !== undefined && count > at;

/**
 * A link on screen that a Get Link elsewhere (another tab) turned off: its person has a newer live
 * link now. Never guessed: a link with no mint time, or no newer one (turned off, or none read
 * yet), is not replaced.
 */
export function linkReplaced(link: Pick<OfferLink, "personId" | "at">, info: Pick<BatonInfo, "linkAt"> | undefined): boolean {
  const newest = info?.linkAt?.[link.personId];
  return !!link.at && !!newest && Date.parse(newest) > Date.parse(link.at);
}

/**
 * The decision areas a referral asks the operator to grant, said on the approval card: a referred
 * person's `decides` is the referrer's say-so until the operator approves, and approving makes it
 * the operator's (it then routes conflicts to them, §app/requirements).
 */
export function proposedAreasLine(name: string, decides: readonly string[] | undefined): string | null {
  // Not sent at all: unknown, which is not the same as none — say nothing rather than "none".
  if (decides === undefined) return null;
  const areas = (decides ?? []).map((a) => a.trim()).filter(Boolean);
  if (!areas.length) return "No decision areas.";
  return `Decides: ${areas.join(", ")} — approving ${name} approves ${areas.length === 1 ? "this area" : "these areas"}.`;
}

/**
 * The strip's wrap-up line, and whether it offers Review or Revert: only when a wrap-up ran to an
 * end that can have changed a profile. "skipped" means no turn ran at all (only the operator wrote).
 */
export function wrapupLine(w: WrapupInfo): { text: string; review: boolean } {
  switch (w.state) {
    case "running":
      return { text: "Wrap-up running: reading this session for profile updates.", review: false };
    case "skipped":
      return { text: "Wrap-up skipped: nobody but you wrote in this session.", review: false };
    case "failed":
      return { text: `Wrap-up stopped${w.error ? `: ${w.error.replace(/\.$/, "")}.` : "."} Profiles it didn't reach are unchanged.`, review: true };
    case "done":
      return {
        text: `Wrap-up: ${w.applied} profile ${w.applied === 1 ? "field" : "fields"} updated${w.refused.length ? `, ${w.refused.length} refused` : ""}.`,
        review: true,
      };
  }
}

/**
 * Why the operator's composer can't write in a baton session (§app.baton/attribution), or null
 * when it can. `mine` is the strip's own read of the holder (undefined until it has read): it wins
 * over the list's state, which lags a hand-off made from the strip until the next list read. Either
 * way the box is read-only, Send gone: a box that takes typing and says "Enter sends" reads as
 * sendable whatever the button looks like.
 */
export function batonComposerGate(baton: BatonSummaryField | undefined, mine: boolean | undefined): { ended: boolean; text: string } | null {
  if (!baton) return null;
  if (baton.state === "done" || baton.state === "closed") return { ended: true, text: `This hand-off session is ${baton.state}.` };
  if (baton.offer?.state === "held") return { ended: false, text: `${baton.offer.holder ?? "Someone"} took the offer and is answering. Withdraw it to write.` };
  if (baton.offer?.state === "open") return { ended: false, text: `Offered to ${baton.offer.invited} people; nobody is answering right now. Withdraw it to write.` };
  // "needs-you" is the operator's turn, and so is "open" once the operator has written after Take
  // Back: the list carries only the holder's display name, so the strip says whose it is.
  const others = mine === false || (mine === undefined && baton.state === "open");
  return others ? { ended: false, text: `${baton.holder ?? "Someone"} holds the baton. Take it back to write.` } : null;
}

/**
 * The goal the strip folds under Goal, trimmed; null when there is
 * none to show, so the disclosure is left out rather than opening on nothing.
 */
export function goalShown(session: { goal?: string | null } | undefined): string | null {
  const g = typeof session?.goal === "string" ? session.goal.trim() : "";
  return g || null;
}
