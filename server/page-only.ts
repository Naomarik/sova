import type { Context } from "hono";
import { CALLER_HEADER, extensionCaller, isExtensionKey, presentsPageCookie, serverAuthEnabled, TOKEN_HEADER } from "./auth";
import { RELAYED_HEADER } from "./mesh/proxy";
import { isSenderSecret, OVERSEER_SENDER_HEADER } from "./overseer-sender";
import { SANDBOX_LOWER_REFUSAL } from "./sandbox-state";

/** The refusals of an act only the operator's own page on this machine may take, one per kind of caller. */
export interface PageOnlyWords {
  overseer: string;
  local: string;
  chat: string;
  script: string;
  extension: string;
}

export type NotPage = keyof PageOnlyWords;

/** What a request says of itself, from Hono or a raw socket upgrade alike. */
interface Shown {
  header: (name: string) => string | undefined;
  /** It came over a socket of the main listener (no socket: an in-process dispatch). */
  socket: boolean;
  /** It came over the peer listener. */
  peer: boolean;
}

/**
 * Who this is, or null when it is the operator's own page on this machine. The page has to show itself: the
 * install's cookie, on the main listener (with SOVA_AUTH=off, a test rig's cookieless socket). So a call with no
 * mark at all is no page: an in-process dispatch (a transcript card's or an offer's button, a schedule) has no
 * socket and no cookie, and any new caller is refused until it is shown to be the page. A program holding the
 * token can still send it as that cookie: this is a heuristic (§app.access/your-click).
 */
function notPageOf(r: Shown): NotPage | null {
  if (isSenderSecret(r.header(OVERSEER_SENDER_HEADER))) return "overseer";
  if (r.peer || r.header(RELAYED_HEADER)) return "local";
  if (r.header(CALLER_HEADER) !== undefined) return "chat";
  const token = r.header(TOKEN_HEADER);
  const bearer = /^Bearer\s+(.+)$/i.exec(r.header("authorization") ?? "")?.[1];
  if (extensionCaller(token) !== null || (bearer !== undefined && isExtensionKey(bearer.trim()))) return "extension";
  if (token !== undefined) return "script";
  return (serverAuthEnabled() ? presentsPageCookie(r.header("cookie")) : r.socket) ? null : "script";
}

/** The same, for a Hono request. */
export function notPage(c: Context): NotPage | null {
  const env = c.env as { incoming?: unknown; meshPeer?: unknown } | undefined;
  return notPageOf({ header: (n) => c.req.header(n), socket: !!env?.incoming, peer: !!env?.meshPeer });
}

/** The same, for a socket the main listener's gate let in (server/ws.ts). The peer listener's are never the page. */
export function notPageSocket(header: (name: string) => string | undefined): NotPage | null {
  return notPageOf({ header, socket: true, peer: false });
}

/**
 * Why this request isn't the operator's own page on this machine, or null when it is: the Overseer's sender mark,
 * a peer's, a chat's key, the token in a header (a script, a chat's terminal, a tool), an extension's key, or
 * nothing that shows the page (§chat.mode-menu/project-mode-hooks).
 */
export function pageOnlyRefusal(c: Context, words: PageOnlyWords): string | null {
  const who = notPage(c);
  return who === null ? null : words[who];
}

// ---- the approvals only your own click passes (§app.access/your-click, §design.copy-deck/your-click) ------------

const DOORS = {
  runButtons: "Only the user approves a project's run buttons. Ask them to press Approve Run Buttons on the project page's Offers list. Nothing was approved.",
  profile: "Only the user approves a profile's powers. Ask them to press Approve in Settings → Profiles or on the profile picker. Nothing was approved.",
  schedule: "Only the user approves a schedule. Ask them to press Approve in the Playbooks dialog or the Overseer's Approvals & Schedules. Nothing was approved.",
  power: "Turning on a Project Overseer power needs the user's own click. Ask them to turn it on in the project page's Settings tab. Nothing was changed.",
  sandbox: SANDBOX_LOWER_REFUSAL,
  cardClick: "Only the user answers a card. Ask them to click it in that chat. Nothing was sent.",
} as const;
export type YourClickDoor = keyof typeof DOORS | { projectTool: string } | { cardsOf: string };

const THROUGH_A_PEER = "Only the user approves this, on the page of the computer it belongs to. Open Sova on that computer. Nothing changed.";

const SCHEDULE_THROUGH_A_PEER = "This computer couldn't confirm your click with the one the schedule is on. Try Approve again, or approve it on that computer's page. Nothing was approved.";

const doorWords = (door: YourClickDoor): string =>
  typeof door === "object" && "cardsOf" in door
    ? `Only the user trusts a project's or an extension's cards. Ask them to press Trust ${door.cardsOf}'s Cards on the card. Nothing was trusted.`
    : typeof door === "object" ? `Approving a project mode's tools needs the user's own click. Ask them to turn ${door.projectTool} on in that chat's mode menu. Nothing was turned on.` : DOORS[door];

/** A refusal's words and body, for whoever isn't the page. */
export function yourClickBody(door: YourClickDoor, who: NotPage): { error: string; yourClick: true; peer?: true } {
  // A schedule is the one door a click on another computer's page can pass, so it never says that page can't.
  return who === "local" ? { error: door === "schedule" ? SCHEDULE_THROUGH_A_PEER : THROUGH_A_PEER, yourClick: true, peer: true } : { error: doorWords(door), yourClick: true };
}

/** The 403 of a door, or null when this is the page. `overseerKeeps`: what the Overseer can do stays its own. */
export function yourClickRefusal(c: Context, door: YourClickDoor, opts: { overseerKeeps?: boolean } = {}): Response | null {
  const who = notPage(c);
  if (who === null || (who === "overseer" && opts.overseerKeeps)) return null;
  return c.json(yourClickBody(door, who), 403);
}
