import { existsSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { disposeAllChats, heldChat } from "./chat-manager";
import { canonicalPath, resolveSessionPath } from "./paths";
import { listModels, resolveContext } from "./models";
import { markOwned } from "./write-guard";
import { addWebSession } from "./web-sessions";
import { getAgentsInsight, getSessionInsight, getUsageInsight } from "./insights";
import { archiveSession, cleanupSessions, getSessionSummary, listCwds, listSessions } from "./sessions-index";
import { contextForBranch, normalizeEntries, readActiveBranch } from "./transcript";
import { checkTmpImage, MAX_ATTACHMENT_BYTES, readTmpImage, saveUploadedImage, UploadError } from "./attachments";
import { listFolders } from "./folders";
import { switchMode } from "./mode";
import { modeInfo, parseModePatch, readMode } from "./mode-state";
import { attachWebSockets } from "./ws";

const PORT = Number(process.env.PORT) || 4800;
// Loopback by default; set HOST=0.0.0.0 to deliberately expose on the LAN.
const HOST = process.env.HOST || "127.0.0.1";
const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

// Embedded pi runtimes / extensions must never take the server down.
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));

const app = new Hono();

app.onError((err, c) => {
  console.error("[api]", err);
  return c.json({ error: err.message }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/sessions", async (c) => c.json(await listSessions()));

app.post("/api/sessions", async (c) => {
  let body: { cwd?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { cwd }" }, 400);
  }
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd || !isAbsolute(cwd)) return c.json({ error: "cwd must be an absolute path" }, 400);
  try {
    if (!statSync(cwd).isDirectory()) return c.json({ error: "cwd is not a directory" }, 400);
  } catch {
    return c.json({ error: "cwd does not exist" }, 400);
  }
  const sm = SessionManager.create(resolve(cwd));
  const rawPath = sm.getSessionFile();
  const header = sm.getHeader();
  if (!rawPath || !header) return c.json({ error: "SessionManager did not produce a session file" }, 500);
  // SessionManager defers writing until the first assistant reply; write the header now so
  // the session exists on disk (listable, watchable, openable by path).
  writeFileSync(rawPath, `${JSON.stringify(header)}\n`, { flag: "wx" });
  const path = canonicalPath(rawPath); // same key resolveSessionPath() will produce
  markOwned(path); // fresh mtime is ours, not a foreign writer's
  addWebSession(header.id);
  const summary = await getSessionSummary(path);
  if (!summary) return c.json({ error: "Failed to read back new session" }, 500);
  return c.json(summary, 201);
});

// Moves a web-spawned session between the sidebar regions. Changes pi-web's own id list only.
app.post("/api/sessions/archive", async (c) => {
  let body: { path?: unknown; archived?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { path, archived }" }, 400);
  }
  if (typeof body.archived !== "boolean") return c.json({ error: "archived must be true or false" }, 400);
  const path = resolveSessionPath(typeof body.path === "string" ? body.path : null);
  if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  const r = await archiveSession(path, body.archived);
  return r.ok ? c.json(r.summary) : c.json({ error: r.error }, r.status);
});

// Permanently deletes transcript files from disk: sessions older than 7 or 30 days, or empty
// zero-input husks. dryRun reports what would go (deletedIds) without deleting. Live, mid-turn
// and just-written sessions are always skipped and counted in the response.
app.post("/api/sessions/cleanup", async (c) => {
  let body: { mode?: unknown; minAgeDays?: unknown; dryRun?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { mode, dryRun }" }, 400);
  }
  const dryRun = body.dryRun === true;
  if (body.mode === "age" && (body.minAgeDays === 7 || body.minAgeDays === 30))
    return c.json(await cleanupSessions({ mode: "age", minAgeDays: body.minAgeDays, dryRun }));
  if (body.mode === "husks") return c.json(await cleanupSessions({ mode: "husks", dryRun }));
  return c.json({ error: 'mode must be "husks", or "age" with minAgeDays 7 or 30' }, 400);
});

app.get("/api/cwds", async (c) => c.json(await listCwds()));

// Subfolders for the New Session folder picker. Directory names only, never files (server/folders.ts).
app.get("/api/folders", async (c) => {
  const r = await listFolders(c.req.query("path"), { hidden: c.req.query("hidden") === "1" });
  return r.ok ? c.json(r.listing) : c.json({ error: r.error }, r.status);
});

app.get("/api/models", async (c) => c.json(await listModels()));

// The mode is per session (DESIGN_NOTES §4g). ~/.pi/agent/mode.json is the default new sessions
// start from; GET reads it, POST without ?path= writes it and changes no open chat.
app.get("/api/mode", (c) => c.json(modeInfo(readMode())));

// With ?path=<session .jsonl>: switch that one held chat, from its next message (server/chat-manager
// applyMode), leaving the default alone. Without it: write the default (server/mode.ts).
app.post("/api/mode", async (c) => {
  const rawPath = c.req.query("path");
  const path = rawPath === undefined ? null : resolveSessionPath(rawPath);
  if (rawPath !== undefined && !path)
    return c.json({ error: "Invalid ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { mode?, minorModes? }" }, 400);
  }
  const patch = parseModePatch(body);
  if ("error" in patch) return c.json({ error: patch.error }, 400);
  if (path === null) return c.json(await switchMode(patch));
  const chat = heldChat(path);
  if (!chat) return c.json({ error: "That session isn't open on this server; open the chat first" }, 404);
  return c.json(await chat.switchMode(patch));
});

app.get("/api/transcript", async (c) => {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  const branch = await readActiveBranch(path);
  return c.json({ items: normalizeEntries(branch), context: await resolveContext(contextForBranch(branch)) });
});

// Bytes of an image a user message names by path (TranscriptItem.attachments). Only image files
// directly in /tmp, after resolving symlinks. no-store: /tmp names get reused and cleaned.
app.get("/api/attachment", async (c) => {
  const check = checkTmpImage(c.req.query("path"));
  if (!check.ok) return c.json({ error: check.error }, check.status);
  const bytes = await readTmpImage(check.realPath);
  if (!bytes) return c.json({ error: "File not found" }, 404);
  return c.body(new Uint8Array(bytes), 200, {
    "Content-Type": check.mimeType,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
});

// A web upload becomes a /tmp file like a TUI clipboard paste; the prompt text then references
// the path. Raw bytes + Content-Type (no multipart). 413 by middleware before we buffer.
app.post(
  "/api/upload",
  bodyLimit({
    maxSize: MAX_ATTACHMENT_BYTES,
    onError: () => new Response(JSON.stringify({ error: "Image exceeds the 20MB limit" }), { status: 413, headers: { "Content-Type": "application/json" } }),
  }),
  async (c) => {
    try {
      const mime = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim();
      const saved = saveUploadedImage(new Uint8Array(await c.req.arrayBuffer()), mime);
      return c.json(saved, 201);
    } catch (err) {
      if (err instanceof UploadError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  },
);

// Insights: read-only views of extension state (docs/insights-research.md). Missing or
// corrupt sources come back as empty/unavailable payloads, not errors.
app.get("/api/insights/usage", async (c) => c.json(await getUsageInsight()));

app.get("/api/insights/agents", async (c) => c.json(await getAgentsInsight()));

app.get("/api/insights/session", async (c) => {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  return c.json(await getSessionInsight(path));
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// Built frontend (vite build → dist/) with SPA fallback. Checked per request so a build made
// after the server started is picked up.
const hasDist = () => existsSync(join(DIST_DIR, "index.html"));
const staticFiles = serveStatic({ root: DIST_DIR });
const spaIndex = serveStatic({ root: DIST_DIR, path: "index.html" });
app.use("*", (c, next) => (hasDist() ? staticFiles(c, next) : next()));
app.get("*", (c, next) => (hasDist() ? spaIndex(c, next) : next()));

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`pi-web server on http://${HOST}:${info.port}`);
}) as Server;
server.on("error", (err) => {
  // e.g. EADDRINUSE: don't linger half-alive behind the uncaughtException handler
  console.error("[server] listen failed:", err.message);
  process.exit(1);
});
attachWebSockets(server);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  await Promise.race([disposeAllChats(), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
