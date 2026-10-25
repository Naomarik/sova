// The People tab's owner card (§app.owner-page/owner, /link): the words for the owner link's state.
// Pure, so each state's sentence is testable without a DOM.
import type { OwnerChange, OwnerPageInfo } from "../../shared/orgs";
import type { ProjectUpdate } from "../../shared/owner";
import { relativeIn, relativeTime } from "./format";
import { firstName } from "./person-page";

const DAY = 86_400_000;
/** The link turns itself off this long after its last use (server/person-links.ts OWNER_IDLE_DAYS). */
export const OWNER_IDLE_DAYS = 7;

const times = (n: number) => (n === 1 ? "1 time" : `${n} times`);

/** The link line and whether it warns (§app.owner-page/controls). Live: "Owner link made 3d ago ·
    last used yesterday · turns off in 6d if unused · opened 4 times" ("not used yet" before its
    first use). Turned off unused: "The owner link turned off 2d ago: nobody used it for a week."
    (warn), and once the owner asked: "Kim asked for a new link 1h ago." (warn). `null` with no owner. */
export function ownerLinkLine(info: OwnerPageInfo | undefined, now = Date.now()): { text: string; warn: boolean } | null {
  if (!info?.person) return null;
  const l = info.link;
  if (!l) return { text: "No owner link yet.", warn: false };
  if (l.state === "off") return { text: "The owner link is turned off.", warn: false };
  if (l.state === "expired" || Date.parse(l.expiresAt) <= now) {
    if (l.askedAt) return { text: `${firstName(info.person.name)} asked for a new link ${relativeTime(l.askedAt, now)}.`, warn: true };
    return { text: `The owner link turned off ${relativeTime(l.expiresAt, now)}: nobody used it for a week.`, warn: true };
  }
  const lastUse = Date.parse(l.expiresAt) - OWNER_IDLE_DAYS * DAY;
  const used = lastUse > Date.parse(l.createdAt) + 60_000 ? `last used ${relativeTime(new Date(lastUse).toISOString(), now)}` : "not used yet";
  return { text: `Owner link made ${relativeTime(l.createdAt, now)} · ${used} · turns off ${relativeIn(l.expiresAt, now) ?? "soon"} if unused · opened ${times(info.opened)}`, warn: false };
}

/** "Set by you 2d ago." for the newest change by the operator; "" when the newest isn't theirs
    (a leave is said by the banner). */
export function ownerChangeLine(history: OwnerChange[] | undefined, now = Date.now()): string {
  const last = history?.at(-1);
  return last && last.why === "operator" ? `Set by you${last.via === "overseer" ? ", via the Overseer" : ""} ${relativeTime(last.at, now)}.` : "";
}

/**
 * The owner card's link buttons (§app.owner-page/controls), from the card's own data: Copy Owner
 * Link (its URL) while the live owner link is kept, else Get Owner Link, which asks first while a
 * live link that can't be shown again would be replaced; Get New Owner Link and Delete Owner Link
 * while one is live. Nothing without an owner but a disabled Get Owner Link.
 */
export function ownerLinkActions(info: Pick<OwnerPageInfo, "person" | "link"> | undefined): { copy?: string; get: "now" | "ask" | null; rotate: boolean; remove: boolean } {
  const live = !!info?.person && info.link?.state === "live";
  const copy = live ? info!.link!.url : undefined;
  return { ...(copy ? { copy } : {}), get: copy ? null : live ? "ask" : "now", rotate: live, remove: live };
}

/** The confirm under Get New Owner Link (and Get Owner Link while the live link is not kept): minting turns that one off. */
export const rotateLine = (name: string) => `${firstName(name)}'s current link stops working at once. The new one works from now.`;
export const deleteOwnerLine = (name: string) => `${firstName(name)}'s owner link stops working for good. The conversations and updates stay.`;

/** An update's line in the project page's log: who posted it and when. */
export const updateMeta = (u: Pick<ProjectUpdate, "by" | "at">, now = Date.now()): string =>
  u.by === "operator" ? `Posted when you asked ${relativeTime(u.at, now)}` : `Posted by the overseer ${relativeTime(u.at, now)}`;
