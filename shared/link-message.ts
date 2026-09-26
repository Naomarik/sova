// The tag of a link message (§mesh.links/delivery, §mesh.links/transcript): the receiving host
// hands a partner's message to the member's agent as a real `role:"user"` message whose first line
// tags it. Shared between the server (classifying transcript rows into kind "link", the Stop split,
// titles, tags, attention signals, regenerate) and the client (the live path, turn starts), so
// every site agrees on what a link message is from the tag alone. The wake-nudge precedent is
// shared/wake.ts. Builtins only: the frontend bundles this file.
//
// The message, verbatim (formatLinkMessage writes it; the model reads it):
//   [link_msg lk_0123456789abcdef lm_0123456789abcdef] from <session title> (<host label>/<session id>)
//   <text, any number of lines>
//
//   Reply with link_send (to: "<session id>").

/** `lk_` / `lm_` plus 16 lowercase hex, minted by `newLinkId` / `newLinkMessageId` (server side). */
export const LINK_ID_RE = /^lk_[0-9a-f]{16}$/;
export const LINK_MESSAGE_ID_RE = /^lm_[0-9a-f]{16}$/;

const TAG_RE = /^\[link_msg (lk_[0-9a-f]{16}) (lm_[0-9a-f]{16})\] from (.*) \(([^()/]*)\/([^()/\s]+)\)$/;
const REPLY_RE = /^Reply with link_send \(to: "[^"]*"\)\.$/;

export interface LinkMessageInfo {
  linkId: string;
  messageId: string;
  /** The sender as the receiving host framed it: its session title, its host's label as the
      receiving host knows it, and its session id. Display only, never identity. */
  from: { title: string; host: string; sessionId: string };
  /** The partner's text, without the tag line and the reply line. */
  text: string;
}

/** A label for the tag line: one line, no parentheses or slashes that would confuse the parse. */
const clean = (s: string): string => s.replace(/[\r\n]+/g, " ").replace(/[()]/g, "").trim() || "?";

export function formatLinkMessage(m: {
  linkId: string;
  messageId: string;
  fromTitle: string;
  fromHost: string;
  fromSessionId: string;
  text: string;
}): string {
  const host = clean(m.fromHost).replace(/\//g, "-");
  return (
    `[link_msg ${m.linkId} ${m.messageId}] from ${clean(m.fromTitle)} (${host}/${m.fromSessionId})\n` +
    `${m.text}\n\nReply with link_send (to: "${m.fromSessionId}").`
  );
}

/** Parses a link message by its tag alone. The tag must be the whole first line; a later line with
    the same shape does not count (that would be a message merely quoting one). */
export function parseLinkMessage(text: string | null | undefined): LinkMessageInfo | null {
  if (!text) return null;
  const lines = text.split(/\r\n|\r|\n/);
  const m = TAG_RE.exec(lines[0] ?? "");
  if (!m) return null;
  let body = lines.slice(1);
  const last = body.length - 1;
  if (last >= 0 && REPLY_RE.test(body[last]!)) body = body.slice(0, last);
  while (body.length && body[body.length - 1] === "") body.pop();
  return {
    linkId: m[1]!,
    messageId: m[2]!,
    from: { title: m[3]!, host: m[4]!, sessionId: m[5]! },
    text: body.join("\n"),
  };
}

/** True when the text is a link message: the cheap test every exclusion site uses. */
export const isLinkMessage = (text: string | null | undefined): boolean => parseLinkMessage(text) !== null;
