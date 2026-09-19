import { existsSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { disposeAllChats } from "./chat-manager";
import { resolveSessionPath } from "./paths";
import { markOwned } from "./write-guard";
import { getSessionSummary, listCwds, listSessions } from "./sessions-index";
import { readTranscript } from "./transcript";
import { attachWebSockets } from "./ws";

const PORT = Number(process.env.PORT) || 4800;
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
  const path = sm.getSessionFile();
  const header = sm.getHeader();
  if (!path || !header) return c.json({ error: "SessionManager did not produce a session file" }, 500);
  // SessionManager defers writing until the first assistant reply; write the header now so
  // the session exists on disk (listable, watchable, openable by path).
  writeFileSync(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
  markOwned(path); // fresh mtime is ours, not a foreign writer's
  const summary = await getSessionSummary(path);
  if (!summary) return c.json({ error: "Failed to read back new session" }, 500);
  return c.json(summary, 201);
});

app.get("/api/cwds", async (c) => c.json(await listCwds()));

app.get("/api/transcript", async (c) => {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  return c.json({ items: await readTranscript(path) });
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// Built frontend (vite build → dist/) with SPA fallback. Checked per request so a build made
// after the server started is picked up.
const hasDist = () => existsSync(join(DIST_DIR, "index.html"));
const staticFiles = serveStatic({ root: DIST_DIR });
const spaIndex = serveStatic({ root: DIST_DIR, path: "index.html" });
app.use("*", (c, next) => (hasDist() ? staticFiles(c, next) : next()));
app.get("*", (c, next) => (hasDist() ? spaIndex(c, next) : next()));

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`pi-web server on http://localhost:${info.port}`);
}) as Server;
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
