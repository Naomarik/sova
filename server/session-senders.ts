// Who started a chat and who typed each message (§app.extensions/senders), recorded only while an active
// extension's offers name `senders` (shared/extension-offers.ts RECORD_KINDS), asked of the cached active list
// (server/extensions.ts recordsAsked), never of a file on the hot path. Who typed each message is the
// `sova-member-sent` marker in the chat's own file (server/harness/state-kinds.ts MEMBER_SENT, written by the chat:
// server/chat-manager.ts). Who started it is a sidecar, `<state root>/session-started-by.jsonl`, a line per chat:
// never a byte into a JSONL, and never created while nothing asks. Neither is ever the model's to read.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "hono";
import { MEMBER_SENT } from "./harness/state-kinds";
import { stateView } from "./harness/state-view";
import { readBranch } from "./harness/pi/reader";
import { stateRoot } from "./state-root";
import { extensionCaller, showsToken, TOKEN_HEADER } from "./auth";
import { recordsAsked } from "./extensions";
import type { MemberCaller } from "./member-frame";
import { EXTENSION_SENDER_PREFIX, OPERATOR_CALLER, peerCaller } from "../shared/senders";

/** GET /api/sessions/senders's answer (§app.extensions/senders). */
export interface SessionSenders {
  /** Who started it, when that was recorded; null: started while nothing asked, or not by POST /api/sessions. */
  startedBy: (MemberCaller & { at: number }) | null;
  /** Each user message's caller, oldest first, on the chat's current branch. */
  messages: Array<MemberCaller & { entryId: string }>;
}

/** Whether Sova records senders now: an active extension asks (the cached list, no file read). */
export const sendersAsked = (): boolean => recordsAsked("senders");

/**
 * Who this request is, as a caller string: a linked computer by its mesh node identity, an extension by its key,
 * else this machine's operator (its page, its token, a chat or the Overseer on it).
 */
export function callerOf(c: Context): MemberCaller {
  const peer = (c.env as { meshPeer?: { nodeId: string; label: string } } | undefined)?.meshPeer;
  if (peer) return { by: peerCaller(peer.nodeId), ...(peer.label ? { label: peer.label } : {}) };
  const token = c.req.header(TOKEN_HEADER);
  const ext = token !== undefined && !showsToken(token) ? extensionCaller(token) : null;
  if (ext) return { by: `${EXTENSION_SENDER_PREFIX}${ext}` };
  return { by: OPERATOR_CALLER };
}

/** Who typed a chat socket's prompt or steer (server/ws.ts), while senders are asked: this machine's page
    (`who` null), or a linked computer's socket (`local`, with the peer the listener named). A program's socket
    (a script, a chat, a key, the Overseer) names no one. Nothing asked: undefined, at the cost of one set lookup. */
export function memberOfSocket(who: string | null, peer: { nodeId: string; label: string } | undefined): MemberCaller | undefined {
  if (!sendersAsked()) return undefined;
  if (who === null) return { by: OPERATOR_CALLER };
  if (who === "local" && peer) return { by: peerCaller(peer.nodeId), ...(peer.label ? { label: peer.label } : {}) };
  return undefined;
}

/** The caller beside a REST send, while senders are asked: a linked computer's, or the operator's own page or token. */
export function memberOfSend(c: Context): MemberCaller | undefined {
  if (!sendersAsked()) return undefined;
  const caller = callerOf(c);
  return caller.by.startsWith(EXTENSION_SENDER_PREFIX) ? undefined : caller;
}

// ---- who started it ----------------------------------------------------------------------------

/** One line per chat started while senders were asked, appended (a create costs one short write whatever the file
    holds; several servers on one root append side by side). Read only by the extensions' read, newest line wins. */
export const startedByFile = (): string => join(stateRoot(), "session-started-by.jsonl");

type StartedBy = MemberCaller & { at: number };

/** Record who started `sessionId`, only while senders are asked. */
export function noteStartedBy(sessionId: string, c: Context): void {
  if (!sendersAsked()) return;
  const caller = callerOf(c);
  try {
    const file = startedByFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ id: sessionId, ...caller, at: Date.now() })}\n`);
  } catch (err) {
    console.warn(`[senders] could not record who started ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Who started `sessionId`, if recorded: its newest good line. */
export function startedByOf(sessionId: string): StartedBy | null {
  let text: string;
  try {
    text = readFileSync(startedByFile(), "utf8");
  } catch {
    return null;
  }
  let out: StartedBy | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes(sessionId)) continue;
    let r: { id?: unknown; by?: unknown; label?: unknown; at?: unknown } | null;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a line cut short by a crash costs only itself
    }
    if (!r || r.id !== sessionId || typeof r.by !== "string" || !r.by || typeof r.at !== "number") continue;
    out = { by: r.by, ...(typeof r.label === "string" && r.label ? { label: r.label } : {}), at: r.at };
  }
  return out;
}

/** Both, for the session file at `path` with id `sessionId`: the read extensions use. */
export async function sessionSenders(path: string, sessionId: string): Promise<SessionSenders> {
  const branch = await readBranch(path);
  const messages = stateView(branch)
    .list(MEMBER_SENT)
    .map((r) => ({ entryId: r.data.targetId, by: r.data.by, ...(r.data.label ? { label: r.data.label } : {}) }));
  return { startedBy: startedByOf(sessionId), messages };
}
