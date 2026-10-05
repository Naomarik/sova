import { statSync } from "node:fs";
import { acquireChat } from "./chat-manager";
import { readOverseerState } from "./overseer-store";
import { projectOverseerOfPath } from "./project-overseer-store";
import { getSessionSummary, idOf, indexedSessionPaths, listSessionFiles } from "./sessions-index";

/**
 * Prompting one session and finding sessions by id, as every caller does it (the Overseer, a project
 * overseer, a build's effects, the routes): no caller's own state lives here.
 */

export type PromptDelivery = "followUp" | "steer";
/** `kind`: "prompt" = it started a turn now; otherwise it was queued behind the running turn (or a
    compaction) as that kind. */
export type PromptResult =
  | { ok: true; queued: boolean; kind: "prompt" | PromptDelivery; compacting?: true }
  | { ok: false; status: 400 | 404 | 409; error: string };

const promptedHooks: (() => void)[] = [];
/** After a prompt went into a session (the Overseer's digest is read again). */
export function onSessionPrompted(fn: () => void): void {
  promptedHooks.push(fn);
}

/** Session id → path: the listing cache first, else one walk of the sessions dir. */
export async function pathOfId(id: string): Promise<string | null> {
  const known = indexedSessionPaths().get(id);
  if (known) return known;
  for (const p of await listSessionFiles()) if (idOf(p) === id) return p;
  return null;
}

/** When a session was last active (its file's mtime, as the session list says), by id, for the
    cards note's "may be stale" lines; paths come from the listing cache, so an id it doesn't hold
    reads as unknown. Shared with the project overseer. */
export function sessionActivity(): (sessionId: string) => string | undefined {
  const paths = indexedSessionPaths();
  return (id) => {
    const path = paths.get(id);
    if (!path) return undefined;
    try {
      return new Date(statSync(path).mtimeMs).toISOString();
    } catch {
      return undefined;
    }
  };
}

/** The tool catalogue for the prompt: one line per tool, from the same definitions the runtime registers. */
export function toolCatalogue(tools: { name: string; promptSnippet?: string; description: string }[]): string {
  return tools.map((t) => `- \`${t.name}\`: ${t.promptSnippet ?? t.description.split(". ")[0]}`).join("\n");
}

/**
 * POST /api/sessions/prompt: one message to one session, as its composer would send it. Idle (even
 * with subagents working) it starts a turn; mid-turn, or while a compaction runs, it joins the
 * session's queue as `delivery` (default a follow-up behind the turn; "steer" goes into the turn at
 * its next step), visible and removable there. With `sentBy` (the current Overseer's id, vouched
 * for by `overseerSender`) the message is marked as the Overseer's in the target's file once it
 * enters the context.
 */
export async function promptSession(path: string, text: string, sentBy?: string, delivery: PromptDelivery = "followUp"): Promise<PromptResult> {
  if (!text.trim()) return { ok: false, status: 400, error: "text must not be blank" };
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  const overseerId = sentBy && sentBy === readOverseerState()?.current ? sentBy : undefined;
  if (s.overseer) return { ok: false, status: 409, error: "That is the Overseer's own conversation." };
  if (projectOverseerOfPath(path)) return { ok: false, status: 409, error: "That is a project overseer's own conversation." };
  // Only a baton session's participants write in it, each through their own channel (§app.baton/attribution).
  if (s.baton) return { ok: false, status: 409, error: "That is a baton session: only its participants write in it." };
  if (s.live) return { ok: false, status: 409, error: `It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.` };
  let chat;
  try {
    chat = await acquireChat(path);
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  // Queue or start is decided by acceptPrompt from the runtime's own state, in one synchronous step.
  let queued: boolean;
  const compacting = !chat.harness.isRunning() && chat.isCompacting();
  try {
    chat.assertModelAllowed();
    const r = chat.acceptPrompt(text, undefined, "server", undefined, { delivery, ...(overseerId ? { sentByOverseer: { overseerId } } : {}) });
    queued = r.queued;
    void r.turn.catch((err) => chat.reportTurnFailure(err));
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  for (const fn of promptedHooks) fn();
  return queued ? { ok: true, queued, kind: delivery, ...(compacting ? { compacting: true as const } : {}) } : { ok: true, queued, kind: "prompt" };
}
