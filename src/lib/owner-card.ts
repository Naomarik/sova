// The People tab's owner card (§app.owner-page/owner, /link): the words for the owner link's state.
// Pure, so each state's sentence is testable without a DOM.
import type { OwnerChange, OwnerPageInfo } from "../../shared/orgs";
import type { ProjectUpdate } from "../../shared/owner";
import { relativeIn, relativeTime } from "./format";
import { firstName } from "./person-page";

const DAY = 86_400_000;
/** Under this many days left, the line says only when it expires, as a warning. */
export const OWNER_LINK_WARN_DAYS = 14;

const times = (n: number) => (n === 1 ? "1 time" : `${n} times`);

/** The link line and whether it warns: "Owner link made 3d ago · expires in 80d · opened 4 times";
    under 14 days left "Owner link expires in 9d." (warn); expired "The owner link expired 2d ago."
    (warn). `null` when there is no owner. */
export function ownerLinkLine(info: OwnerPageInfo | undefined, now = Date.now()): { text: string; warn: boolean } | null {
  if (!info?.person) return null;
  const l = info.link;
  if (!l) return { text: "No owner link yet.", warn: false };
  if (l.state === "expired" || (l.state === "live" && Date.parse(l.expiresAt) <= now)) return { text: `The owner link expired ${relativeTime(l.expiresAt, now)}.`, warn: true };
  if (l.state === "off") return { text: "The owner link is turned off.", warn: false };
  const expires = relativeIn(l.expiresAt, now) ?? "soon";
  if (Date.parse(l.expiresAt) - now < OWNER_LINK_WARN_DAYS * DAY) return { text: `Owner link expires ${expires}.`, warn: true };
  return { text: `Owner link made ${relativeTime(l.createdAt, now)} · expires ${expires} · opened ${times(info.opened)}`, warn: false };
}

/** "Set by you 2d ago." for the newest change by the operator; "" when the newest isn't theirs
    (a leave is said by the banner). */
export function ownerChangeLine(history: OwnerChange[] | undefined, now = Date.now()): string {
  const last = history?.at(-1);
  return last && last.why === "operator" ? `Set by you${last.via === "overseer" ? ", via the Overseer" : ""} ${relativeTime(last.at, now)}.` : "";
}

/** The confirm under Get Owner Link while a link is live: minting turns that one off. */
export const rotateLine = (name: string) => `${firstName(name)}'s current link stops working at once. The new one works from now.`;
export const deleteOwnerLine = (name: string) => `${firstName(name)}'s owner link stops working for good. The conversations and updates stay.`;

/** An update's line in the project page's log: who posted it and when. */
export const updateMeta = (u: Pick<ProjectUpdate, "by" | "at">, now = Date.now()): string =>
  u.by === "operator" ? `Posted when you asked ${relativeTime(u.at, now)}` : `Posted by the overseer ${relativeTime(u.at, now)}`;
