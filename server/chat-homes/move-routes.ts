/**
 * The Chats folder setting's routes (Settings → General, "Chats · this computer"; §app.chat-homes/chats-folder):
 * GET /api/chats-folder (the folder in force, where it comes from, the latest move), GET /api/chats-folder/preview
 * (what a move to a folder would do, or why it can't), POST /api/chats-folder/move (only your own click on the page)
 * and POST /api/chats-folder/move/cancel. The move itself is move-root.ts; this wires it to the running server.
 */
import type { Hono } from "hono";
import { jobAlive } from "../background-jobs";
import { rehomeWorkerChats, stopEveryChatProcess, workingChatPaths } from "../chat-host";
import { holdChatReaders, releaseChatReaders } from "../extension-loader";
import { sessionsChanged } from "../list-generation";
import { yourClickRefusal } from "../page-only";
import { resyncFeedWatches } from "../session-feed-watch";
import { cachedTitleOf, forgetHomedSessions, listSessionsAfresh } from "../sessions-index";
import { cancelMove, chatsFolderInfo, type MoveDeps, previewMove, recoverMove, startMove } from "./move-root";

const log = (line: string) => console.log(`[chats-folder] ${line}`);

export const liveMoveDeps: MoveDeps = {
  working: () => workingChatPaths().map((p) => cachedTitleOf(p) || p),
  jobAlive: (j) => jobAlive(j),
  stopChats: (message) => stopEveryChatProcess(message),
  holdReaders: holdChatReaders,
  releaseReaders: releaseChatReaders,
  afterSwitch: async (oldRoot) => {
    const helpers = rehomeWorkerChats(oldRoot);
    const dropped = forgetHomedSessions(oldRoot);
    log(`switched: ${helpers} helper records read again, ${dropped} cached rows of the old folder dropped`);
    resyncFeedWatches();
    await listSessionsAfresh().catch((err: unknown) => log(`the list didn't rebuild: ${err instanceof Error ? err.message : String(err)}`));
    sessionsChanged();
  },
  log,
};

export function mountChatsFolder(app: Hono, deps: MoveDeps = liveMoveDeps): void {
  recoverMove(log);
  app.get("/api/chats-folder", (c) => c.json(chatsFolderInfo(), 200, { "Cache-Control": "no-store" }));
  app.get("/api/chats-folder/preview", async (c) => c.json(await previewMove(c.req.query("path") ?? "", deps), 200, { "Cache-Control": "no-store" }));
  app.post("/api/chats-folder/move", async (c) => {
    const notYou = yourClickRefusal(c, "chatsFolder");
    if (notYou) return notYou;
    const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null;
    if (!body || typeof body.path !== "string") return c.json({ error: "Expected { path: string }" }, 400);
    const r = await startMove(body.path, deps);
    return r.ok ? c.json({ move: r.move }, 202) : c.json({ error: r.error }, r.status);
  });
  app.post("/api/chats-folder/move/cancel", (c) => {
    const notYou = yourClickRefusal(c, "chatsFolder");
    if (notYou) return notYou;
    return cancelMove() ? c.json({ ok: true }) : c.json({ error: "No move can be cancelled now: none is running, or it is already switching." }, 409);
  });
}
