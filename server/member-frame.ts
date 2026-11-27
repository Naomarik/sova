// Who typed a pane's message (§app.extensions/senders), carried beside the frame, never in it: the browser's own
// frame can't say who it is. The server sets it per prompt or steer only while an active extension asks for
// `senders` (server/ws.ts), the remote handle sends it in its `client.msg` frame (server/chat-handle-remote.ts),
// and the chat process puts it back beside the same message (server/chat-runtime/host.ts) for the chat to mark
// (server/chat-manager.ts). Pure and pi-free: the chat process and the server both import it.

/** A caller, as the `sova-member-sent` marker records it: `peer:<nodeId>` or `operator`, and the computer's name then. */
export interface MemberCaller {
  by: string;
  label?: string;
}

const members = new WeakMap<object, MemberCaller>();

/** Put `member` beside this one message object. */
export function setFrameMember(msg: object, member: MemberCaller): void {
  members.set(msg, member);
}

/** The caller set beside this message, if any. */
export const frameMember = (msg: object): MemberCaller | undefined => members.get(msg);

/** A caller read from a frame field that crossed a process link: only its two strings, each checked. */
export function memberOf(raw: unknown): MemberCaller | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { by?: unknown; label?: unknown };
  if (typeof r.by !== "string" || !r.by || r.by.length > 200) return undefined;
  return { by: r.by, ...(typeof r.label === "string" && r.label && r.label.length <= 200 ? { label: r.label } : {}) };
}
