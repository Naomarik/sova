// POST /api/sessions/fork: fork an ordinary, idle Sova chat through a delivered assistant reply
// into a new web-owned session on the same host. Registered by server/index.ts. The route owns
// every refusal the UI cannot know (the strip shows the server's sentence); server/session-fork.ts
// owns the read-only source parse and the fork's bytes. The source is never written, opened as a
// runtime, prompted or notified — and no model is called: creating the fork is file work only.
import type { Hono } from "hono";
import { existsSync } from "node:fs";
import { assertNotLive, BusyError, heldChat } from "./chat-manager";
import { resolveSessionPath } from "./paths";
import { forkSessionFile } from "./session-fork";
import { markSeen } from "./seen";
import { getSessionSummary } from "./sessions-index";
import { validateNewSessionCwd } from "./targets";
import { addWebSession } from "./web-sessions";
import { markOwned, recentForeignWriteAgeSec } from "./write-guard";

/** The source kinds this version refuses, by the summary field that names them. */
function unsupportedBecause(s: {
  overseer?: true;
  baton?: unknown;
  projectOverseer?: unknown;
  org?: unknown;
  workerSession?: true;
  target?: string;
}): string | null {
  if (s.overseer) return "Overseer conversations cannot be forked.";
  if (s.baton) return "Baton conversations cannot be forked.";
  if (s.projectOverseer) return "Project overseer conversations cannot be forked.";
  if (s.org) return "Organization conversations cannot be forked.";
  if (s.workerSession) return "Subagent sessions cannot be forked.";
  if (s.target) return "Sessions on a remote target cannot be forked yet.";
  return null;
}

export function registerSessionForkRoutes(app: Hono): void {
  // Body { path, entryId } → 201 SessionSummary (the fork), or { error } with 400/404/409/500.
  app.post("/api/sessions/fork", async (c) => {
    let body: { path?: unknown; entryId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Expected JSON body { path, entryId }" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Expected JSON body { path, entryId }" }, 400);
    if (typeof body.entryId !== "string" || !body.entryId.trim())
      return c.json({ error: "entryId must be a non-empty string" }, 400);
    const path = resolveSessionPath(typeof body.path === "string" ? body.path : null);
    if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
    if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);

    // Classification comes from the same summary the sidebar lists: a fork of an Overseer file
    // that state no longer knows is an ordinary session and stays forkable, exactly like its
    // own open path (chat-manager's isOverseerFile rule).
    const summary = await getSessionSummary(path);
    if (!summary) return c.json({ error: "Session file not found" }, 404);
    const unsupported = unsupportedBecause(summary);
    if (unsupported) return c.json({ error: unsupported }, 400);
    // Working subagents make the source no more idle than a streaming turn does: their parent's
    // file keeps changing, and the workers themselves belong to the source's runtime, never to
    // a fork of it.
    if ((summary.workers?.working ?? 0) > 0)
      return c.json({ error: "Subagents are working in that session. Stop them or wait for them to finish before forking." }, 409);
    // The fork opens in the source's own cwd; a vanished folder would make an unopenable chat.
    const cwdError = await validateNewSessionCwd(summary.cwd);
    if (cwdError) return c.json({ error: `Cannot fork that session: its folder ${cwdError.slice("cwd ".length)}.` }, 400);

    // Idle. A TUI-held session is read-only here. A chat this server holds answers from its own
    // runtime — mid-turn, compacting, or with a message still on its way out (a steer can sit in
    // an extension input handler after the turn it meant to interrupt has ended) — and its own
    // writes are owned, so the recent foreign-write guard never applies to it. Anything else
    // that changed within the guarded window may still be written by a process Sova cannot
    // identify, and a torn tail line would make the fork's strict parse refuse anyway.
    try {
      assertNotLive(path);
    } catch (err) {
      if (!(err instanceof BusyError)) throw err;
      return c.json({ error: err.message }, 409);
    }
    const chat = heldChat(path);
    if (chat) {
      if (chat.disposed || chat.session.isStreaming)
        return c.json({ error: "Stop the current turn before forking that session." }, 409);
      if (chat.isCompacting()) return c.json({ error: "Wait for the compaction to finish before forking that session." }, 409);
      if (chat.hasPendingSends())
        return c.json({ error: "A message is still on its way out. Wait for it to send, or press Stop, then fork." }, 409);
      try {
        chat.assertNoForeignWrites();
      } catch (err) {
        if (!(err instanceof BusyError)) throw err;
        return c.json({ error: err.message }, 409);
      }
    } else {
      const recent = recentForeignWriteAgeSec(path);
      if (recent !== null)
        return c.json(
          { error: `That session changed ${recent}s ago by a process Sova can't identify. Wait a moment, then fork.` },
          409,
        );
    }

    const fork = forkSessionFile(path, body.entryId.trim());
    if (!fork.ok) return c.json({ error: fork.message }, fork.status);
    markOwned(fork.path); // the fresh fork file is this server's write, never a foreign one's
    addWebSession(fork.sessionId); // origin "web" in every list, this server's and restarts' alike
    markSeen(fork.sessionId); // seen at birth: whoever forked it is about to look at it
    const made = await getSessionSummary(fork.path);
    if (!made) return c.json({ error: "Failed to read back the forked session." }, 500);
    return c.json(made, 201);
  });
}
