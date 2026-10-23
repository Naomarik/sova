import type { Context } from "hono";
import { CALLER_HEADER, extensionCaller, isExtensionKey, TOKEN_HEADER } from "./auth";
import { localRequest } from "./mesh/proxy";
import { isSenderSecret, OVERSEER_SENDER_HEADER } from "./overseer-sender";

/** The refusals of an act only the operator's own page on this machine may take, one per kind of caller. */
export interface PageOnlyWords {
  overseer: string;
  local: string;
  chat: string;
  script: string;
  extension: string;
}

/**
 * Why this request isn't the operator's own page on this machine, or null when it is: a request with the
 * Overseer's sender mark, a peer's, a chat's key, the token in a header (a script, a chat's terminal, a tool)
 * or an extension's key is refused. The page sends the token as the install's cookie; telling the page from a
 * program holding the token is a heuristic (§chat.mode-menu/project-mode-hooks).
 */
export function pageOnlyRefusal(c: Context, words: PageOnlyWords): string | null {
  if (isSenderSecret(c.req.header(OVERSEER_SENDER_HEADER))) return words.overseer;
  if (!localRequest(c)) return words.local;
  if (c.req.header(CALLER_HEADER) !== undefined) return words.chat;
  if (c.req.header(TOKEN_HEADER) !== undefined) return words.script;
  const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  if (extensionCaller(c.req.header(TOKEN_HEADER)) !== null || (bearer !== undefined && isExtensionKey(bearer.trim()))) return words.extension;
  return null;
}
