// Saved sessions' routes (§chat/saved-sessions), all under /api/saved-sessions. Registered by server/app.ts.
// The work is server/saved-sessions/service.ts; this file parses requests, and gives the service the chat and
// model plumbing it needs (SessionHooks): a session held by a chat is written through that chat, a closed one
// directly, and one a TUI holds is never written.
import type { Context, Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNotLive, BusyError, chatHandle, closeChat, heldChatState } from "./chat-handle";
import { holderAlive, readLock } from "./chat-runtime/writer-lock";
import { appendNoteToClosedFile, imageOfSession } from "./harness/pi/bundle";
import { appendToClosedFile } from "./harness/pi/state";
import { listModels } from "./models";
import { modelAllowed, readModelPolicy } from "./model-policy";
import { resolveSessionPath } from "./paths";
import {
  continueInto,
  fetchAndList,
  listSaved,
  onMain,
  preparedPath,
  prepareSave,
  preview,
  prune,
  purgeFromMain,
  removeFromMain,
  save,
  savedForSession,
  type SessionHooks,
  setUpWorktrees,
} from "./saved-sessions/service";
import { cleanSessionTitle, setSessionTitle } from "./session-titles";
import { agentRoot } from "./state-root";
import { markOwned } from "./write-guard";

const NO_STORE = { "Cache-Control": "no-store" };

function liveElsewhere(path: string): boolean {
  try {
    assertNotLive(path);
    return false;
  } catch (err) {
    if (err instanceof BusyError) return true;
    throw err;
  }
}

/** A file no chat process holds right now (a recorded writer that is still alive). */
function heldByProcess(path: string): boolean {
  const lock = readLock(path);
  return !!lock && holderAlive(lock);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const sessionHooks: SessionHooks = {
  liveElsewhere,
  async appendState(path, kind, data) {
    const chat = chatHandle(path);
    if (chat) {
      await chat.appendState(kind, data);
      return;
    }
    if (heldByProcess(path)) throw new Error("That session is open in a chat process.");
    appendToClosedFile(path, kind, data);
    markOwned(path);
  },
  async appendNote(path, noteType, text, display = true) {
    const chat = chatHandle(path);
    if (chat && (await chat.appendNote(noteType, text, display))) return;
    if (heldByProcess(path)) throw new Error("That session is open in a chat process.");
    const r = appendNoteToClosedFile(path, noteType, text, undefined, display);
    if (!r.ok) throw new Error(r.message);
    markOwned(path);
  },
  async closeForImport(path) {
    const chat = chatHandle(path);
    if (chat) {
      if (chat.mirror.running || chat.mirror.compacting || chat.mirror.pendingSends) throw new Error("That session is busy. Wait for it, then continue.");
      await closeChat(path, "A saved session is being loaded into this chat.");
    }
    // The chat's process lets go of the file on its own schedule: wait for it, briefly.
    for (let i = 0; i < 50 && heldByProcess(path); i++) await sleep(100);
    if (heldByProcess(path)) throw new Error("That session is still open in a chat process. Try again in a moment.");
  },
  imported(path) {
    markOwned(path);
  },
  setTitle(sessionId, title) {
    const clean = cleanSessionTitle(title);
    if (clean) setSessionTitle(sessionId, clean, "user");
  },
  async models() {
    const policy = readModelPolicy();
    return (await listModels()).filter((m) => modelAllowed(policy, m.ref)).map((m) => ({ ref: m.ref, window: m.contextWindow ?? null }));
  },
  async defaultModel(path) {
    const held = path ? heldChatState(path)?.model : null;
    if (held) return held;
    try {
      const s = JSON.parse(readFileSync(join(agentRoot(), "settings.json"), "utf8"));
      if (typeof s?.defaultProvider === "string" && typeof s?.defaultModel === "string") return `${s.defaultProvider}/${s.defaultModel}`;
    } catch {
      /* no settings */
    }
    return null;
  },
};

async function bodyOf(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const cwdOf = (v: unknown): string | null => (typeof v === "string" && v.startsWith("/") ? v : null);
const statusOf = (r: { ok?: boolean; reason?: string }): 200 | 400 | 404 | 409 | 500 =>
  r.ok !== false ? 200 : r.reason === "internal" ? 500 : r.reason === "not-found" || r.reason === "expired" ? 404 : r.reason === "invalid" || r.reason === "not-a-repo" ? 400 : 409;

export function registerSessionBundleRoutes(app: Hono, hooks: SessionHooks = sessionHooks): void {
  app.post("/api/saved-sessions/prepare", async (c) => {
    const b = await bodyOf(c);
    const path = resolveSessionPath(typeof b?.path === "string" ? b.path : null);
    if (!path) return c.json({ ok: false, reason: "invalid", message: "Expected { path } of a session." }, 400);
    const r = await prepareSave(path);
    return c.json(r, statusOf(r as { ok?: boolean; reason?: string }), NO_STORE);
  });

  app.get("/api/saved-sessions/prepare/:prepareId/image/:id{.+}", async (c) => {
    const path = preparedPath(c.req.param("prepareId"));
    if (!path) return c.json({ error: "That save was prepared too long ago." }, 404);
    const img = imageOfSession(path, decodeURIComponent(c.req.param("id")));
    if (!img || !/^image\/[a-z0-9.+-]+$/i.test(img.mimeType)) return c.json({ error: "No such image." }, 404);
    return c.body(new Uint8Array(img.data), 200, { "Content-Type": img.mimeType, ...NO_STORE });
  });

  app.post("/api/saved-sessions/save", async (c) => {
    const b = await bodyOf(c);
    const path = resolveSessionPath(typeof b?.path === "string" ? b.path : null);
    if (!b || !path || typeof b.prepareId !== "string") return c.json({ ok: false, reason: "invalid", message: "Expected the save request." }, 400);
    const r = await save({ ...(b as any), path }, hooks);
    return c.json(r, statusOf(r), NO_STORE);
  });

  app.get("/api/saved-sessions/for-session", async (c) => {
    const path = resolveSessionPath(c.req.query("path") ?? null);
    if (!path) return c.json({ error: "Give the session's path." }, 400);
    return c.json(await savedForSession(path), 200, NO_STORE);
  });

  app.get("/api/saved-sessions", async (c) => {
    const cwd = cwdOf(c.req.query("cwd"));
    if (!cwd) return c.json({ error: "Give the folder (cwd)." }, 400);
    return c.json(await listSaved(cwd), 200, NO_STORE);
  });

  app.post("/api/saved-sessions/fetch", async (c) => {
    const cwd = cwdOf((await bodyOf(c))?.cwd);
    if (!cwd) return c.json({ ok: false, reason: "internal", message: "Give the folder (cwd)." }, 400);
    const r = await fetchAndList(cwd);
    return c.json(r, r.ok ? 200 : r.reason === "internal" ? 500 : 409, NO_STORE);
  });

  app.get("/api/saved-sessions/preview", async (c) => {
    const cwd = cwdOf(c.req.query("cwd"));
    const bundleId = c.req.query("bundleId") ?? "";
    if (!cwd || !bundleId) return c.json({ ok: false, reason: "invalid", message: "Give cwd and bundleId." }, 400);
    const path = resolveSessionPath(c.req.query("path") ?? null);
    const r = await preview(cwd, bundleId, path, hooks);
    return c.json(r, statusOf(r as { ok?: boolean; reason?: string }), NO_STORE);
  });

  app.post("/api/saved-sessions/continue", async (c) => {
    const b = await bodyOf(c);
    const path = resolveSessionPath(typeof b?.path === "string" ? b.path : null);
    const cwd = cwdOf(b?.cwd);
    if (!b || !path || !cwd || typeof b.bundleId !== "string") return c.json({ ok: false, reason: "invalid", message: "Expected { path, cwd, bundleId, rev }." }, 400);
    const r = await continueInto({ path, cwd, bundleId: b.bundleId, rev: typeof b.rev === "number" ? b.rev : 0 }, hooks);
    return c.json(r, statusOf(r), NO_STORE);
  });

  app.post("/api/saved-sessions/worktrees", async (c) => {
    const b = await bodyOf(c);
    const path = resolveSessionPath(typeof b?.path === "string" ? b.path : null);
    if (!path || !Array.isArray(b?.branches)) return c.json({ ok: false, reason: "invalid", message: "Expected { path, branches }." }, 400);
    const r = await setUpWorktrees(path, b.branches as string[], hooks);
    return c.json(r, "ok" in r && r.ok === false ? statusOf(r) : 200, NO_STORE);
  });

  app.get("/api/saved-sessions/on-main", async (c) => {
    const cwd = cwdOf(c.req.query("cwd"));
    if (!cwd) return c.json({ error: "Give the folder (cwd)." }, 400);
    return c.json(await onMain(cwd), 200, NO_STORE);
  });

  app.post("/api/saved-sessions/remove-from-main", async (c) => {
    const b = await bodyOf(c);
    const cwd = cwdOf(b?.cwd);
    if (!cwd || !Array.isArray(b?.dirs)) return c.json({ ok: false, reason: "internal", message: "Expected { cwd, dirs }." }, 400);
    const r = await removeFromMain(cwd, b.dirs as string[]);
    return c.json(r, statusOf(r), NO_STORE);
  });

  app.post("/api/saved-sessions/purge-from-main", async (c) => {
    const b = await bodyOf(c);
    const cwd = cwdOf(b?.cwd);
    if (!cwd || !Array.isArray(b?.dirs)) return c.json({ ok: false, reason: "internal", message: "Expected { cwd, dirs }." }, 400);
    const r = await purgeFromMain(cwd, b.dirs as string[]);
    return c.json(r, statusOf(r), NO_STORE);
  });

  app.post("/api/saved-sessions/prune", async (c) => {
    const b = await bodyOf(c);
    const cwd = cwdOf(b?.cwd);
    if (!cwd || typeof b?.branch !== "string") return c.json({ ok: false, reason: "invalid", message: "Expected { cwd, branch }." }, 400);
    const r = await prune(cwd, b.branch);
    return c.json(r, statusOf(r as { ok?: boolean; reason?: string }), NO_STORE);
  });
}
