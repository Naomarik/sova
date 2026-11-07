import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { extensionCaller, showsToken, TOKEN_HEADER } from "./auth";
import { readExtensions } from "./extensions";
import { EXTENSION_SENDER_PREFIX } from "../shared/senders";

/** An extension's message as the chat marks it (§app.extensions/name-badge): the session marker's sender, no hop. */
export interface ExtensionSender {
  sessionId: string;
  title: string;
  hop: 0;
}

/** Who a press on a card sends as: an extension by its id, or a project's card by its own name. */
export type PressSender = { ext: string } | { sessionId: string; title: string };

/** What a card's press sends in-process carries (server/transcript-cards.ts, server/session-offers.ts): a secret made at
    server start, held in memory, sent to no client. No HTTP caller can name a sender with it. */
const CARD_SENDER_HEADER = "x-sova-card-sender";
const CARD_SENDER_SECRET = randomBytes(32).toString("hex");
export const cardSenderHeaders = (sender: PressSender): Record<string, string> => ({ [CARD_SENDER_HEADER]: `${CARD_SENDER_SECRET}:${encodeURIComponent(JSON.stringify(sender))}` });
function cardSender(header: string | undefined): PressSender | null {
  const at = header?.indexOf(":") ?? -1;
  if (!header || at <= 0) return null;
  const got = Buffer.from(header.slice(0, at));
  const want = Buffer.from(CARD_SENDER_SECRET);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return JSON.parse(decodeURIComponent(header.slice(at + 1))) as PressSender;
}

/** The manifest's title as it is now, or the id when it has none usable; null: this server doesn't install it. */
function senderFor(id: string, mustBeInstalled: boolean): ExtensionSender | null {
  const entry = readExtensions().find((e) => e.id === id);
  if (!entry && mustBeInstalled) return null;
  return { sessionId: `${EXTENSION_SENDER_PREFIX}${id}`, title: entry?.title?.trim() || id, hop: 0 };
}

/** The installed extension whose page sent this: a same-host `Referer` under `/ext/<id>/` (§app.extensions/page-badge). */
function pageExtensionOf(referer: string | undefined, host: string | undefined): string | null {
  if (!referer || !host) return null;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  if (url.host !== host) return null;
  const m = /^\/ext\/([^/]+)\//.exec(url.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Who this send is from, when an extension: its key, or failing that a page of an installed extension. Read from
 * the request alone, never a body. The Overseer's own sends and a peer's aren't asked: a page's `Referer` guards
 * against accidents only; a key's name can't be left out.
 */
export function extensionSenderOf(c: Context): ExtensionSender | null {
  if ((c.env as { meshPeer?: unknown } | undefined)?.meshPeer) return null;
  const token = c.req.header(TOKEN_HEADER);
  const key = token !== undefined && !showsToken(token) ? extensionCaller(token) : null;
  if (key) return senderFor(key, false);
  const card = cardSender(c.req.header(CARD_SENDER_HEADER));
  if (card) return "ext" in card ? senderFor(card.ext, false) : { sessionId: card.sessionId, title: card.title, hop: 0 };
  return pageExtensionSender(c);
}

/** The installed extension whose page sent this, by its `Referer` (§app.extensions/page-badge), or null. */
export function pageExtensionSender(c: Context): ExtensionSender | null {
  if ((c.env as { meshPeer?: unknown } | undefined)?.meshPeer) return null;
  const page = pageExtensionOf(c.req.header("referer"), c.req.header("host"));
  return page ? senderFor(page, true) : null;
}
