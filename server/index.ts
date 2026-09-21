import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { disposeAllChats, getModelRuntime, heldChat, warmClaudeCodeProvider } from "./chat-manager";
import { canonicalPath, resolveSessionPath } from "./paths";
import { claudeCodeModelCount, listModels, resolveContext } from "./models";
import { markOwned } from "./write-guard";
import { addWebSession } from "./web-sessions";
import { draftForClient, setDraft } from "./drafts";
import { getAgentsInsight, getSessionInsight, getUsageInsight } from "./insights";
import { archiveSession, cleanupSessions, getSessionSummary, idOf, listCwds, listSessions } from "./sessions-index";
import { contextForBranch, normalizeEntries, readActiveBranch } from "./transcript";
import { checkTmpImage, deleteAttachment, MAX_ATTACHMENT_BYTES, readTmpImage, saveUploadedImage, sessionAttachmentsDir, UploadError } from "./attachments";
import { listFolders } from "./folders";
import { assignSession, createGroup, deleteGroup, readGroups, renameGroup } from "./session-groups";
import { findTarget, isTargetName, listRemoteFolders, listTargets, normalizeRemotePath, targetDir, targetsFile } from "./targets";
import { isExplanationId, listExplanations, readExplanationPage } from "./explanations";
import { switchMode } from "./mode";
import { readSubagentPolicy, writeSubagentPolicy } from "./settings";
import { readWebSettings, writeWebSettings } from "./web-settings";
import { claudeCliStatus } from "./claude-status";
import { modeInfo, parseModePatch, readMode } from "./mode-state";
import { attachWebSockets } from "./ws";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4800; // PORT=0: an ephemeral port (tests)
// Loopback by default; set HOST=0.0.0.0 to deliberately expose on the LAN.
const HOST = process.env.HOST || "127.0.0.1";
const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
/** AGENTS.md for the connection agent (owned by pi-config's remote extension team; read per request). */
const CONNECT_TEMPLATE = fileURLToPath(new URL("./connect-agent-template.md", import.meta.url));

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

/** Create a new empty webapp-owned session in `cwd` (an existing absolute directory) → 201 SessionSummary. */
async function createWebSession(c: Context, cwd: string) {
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
}

// { cwd } for a local session, or { target, remoteCwd } for a remote one: its cwd is the local
// placeholder mirroring the remote path (server/targets.ts), created here; chat-manager passes the
// `target` flag, so the remote extension runs every tool on the far side.
app.post("/api/sessions", async (c) => {
  let body: { cwd?: unknown; target?: unknown; remoteCwd?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { cwd } or { target, remoteCwd }" }, 400);
  }
  if (body.target !== undefined) {
    if (!isTargetName(body.target)) return c.json({ error: "target must be a target name" }, 400);
    const remoteCwd = normalizeRemotePath(typeof body.remoteCwd === "string" ? body.remoteCwd.trim() : "");
    if (!remoteCwd) return c.json({ error: "remoteCwd must be an absolute path" }, 400);
    const target = findTarget(body.target);
    if (!target) return c.json({ error: `Unknown target: ${body.target}` }, 404);
    const dir = targetDir(body.target, remoteCwd);
    mkdirSync(dir, { recursive: true });
    return createWebSession(c, dir);
  }
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd || !isAbsolute(cwd)) return c.json({ error: "cwd must be an absolute path" }, 400);
  try {
    if (!statSync(cwd).isDirectory()) return c.json({ error: "cwd is not a directory" }, 400);
  } catch {
    return c.json({ error: "cwd does not exist" }, 400);
  }
  return createWebSession(c, cwd);
});

// The connection agent: a new session in a fixed seed dir whose AGENTS.md (the remote-runtime
// template, re-copied on every spawn) teaches it to probe, verify and write a targets.json entry.
app.post("/api/sessions/connect", async (c) => {
  let template: string;
  try {
    template = readFileSync(CONNECT_TEMPLATE, "utf8");
  } catch {
    return c.json({ error: `connect-agent template missing: ${CONNECT_TEMPLATE}` }, 500);
  }
  const dir = join(getAgentDir(), "pi-web", "connect");
  mkdirSync(dir, { recursive: true });
  const agents = template.replaceAll("{{TARGETS_FILE}}", targetsFile()).replaceAll("{{AGENT_DIR}}", getAgentDir());
  const tmp = join(dir, `AGENTS.md.${process.pid}.tmp`);
  writeFileSync(tmp, agents);
  renameSync(tmp, join(dir, "AGENTS.md"));
  return createWebSession(c, dir);
});

// The sidebar's user-made groups (spec/02-session-list.md §2 "Groups"): pi-web's own grouping of
// sessions, stored in ~/.pi/agent/pi-web/session-groups.json. Keyed by session id, like the archive,
// and purely additive: a grouped session still shows in its region. Never writes a session file.
app.get("/api/session-groups", (c) => c.json(readGroups()));

app.post("/api/session-groups", async (c) => {
  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { name }" }, 400);
  }
  const r = createGroup(body.name);
  return r.ok ? c.json(r.group, 201) : c.json({ error: r.error }, r.status);
});

app.patch("/api/session-groups/:id", async (c) => {
  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { name }" }, 400);
  }
  const r = renameGroup(c.req.param("id"), body.name);
  return r.ok ? c.json(r.group) : c.json({ error: r.error }, r.status);
});

app.delete("/api/session-groups/:id", (c) =>
  deleteGroup(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Group not found" }, 404),
);

// One session into one group (or out of it, with `groupId: null`).
app.post("/api/session-groups/assign", async (c) => {
  let body: { path?: unknown; groupId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { path, groupId }" }, 400);
  }
  if (body.groupId !== null && typeof body.groupId !== "string") return c.json({ error: "groupId must be a group id or null" }, 400);
  const path = resolveSessionPath(typeof body.path === "string" ? body.path : null);
  if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  const r = assignSession(idOf(path), body.groupId);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
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

// Permanently deletes transcript files from disk: sessions older than 7 or 30 days, empty
// zero-input husks, or the named sessions of paths mode (spec/02-session-list.md §2 "Deleting one
// session" — one archived row at a time). dryRun reports what would go (deletedIds) without
// deleting. Live, mid-turn and just-written sessions are always skipped and counted in the response;
// paths mode also refuses anything without the archive mark, with the reason per path.
app.post("/api/sessions/cleanup", async (c) => {
  let body: { mode?: unknown; minAgeDays?: unknown; paths?: unknown; dryRun?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { mode, dryRun }" }, 400);
  }
  const dryRun = body.dryRun === true;
  if (body.mode === "age" && (body.minAgeDays === 7 || body.minAgeDays === 30))
    return c.json(await cleanupSessions({ mode: "age", minAgeDays: body.minAgeDays, dryRun }));
  if (body.mode === "husks") return c.json(await cleanupSessions({ mode: "husks", dryRun }));
  if (body.mode === "paths") {
    if (!Array.isArray(body.paths) || body.paths.length === 0 || body.paths.length > 100 || !body.paths.every((p) => typeof p === "string"))
      return c.json({ error: "paths must be 1–100 session paths" }, 400);
    // Each path validated exactly like the archive route's, so nothing outside the sessions dir
    // reaches the delete loop.
    const paths: string[] = [];
    for (const raw of body.paths) {
      const path = resolveSessionPath(raw);
      if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
      paths.push(path);
    }
    return c.json(await cleanupSessions({ mode: "paths", paths, dryRun }));
  }
  return c.json({ error: 'mode must be "husks", "paths", or "age" with minAgeDays 7 or 30' }, 400);
});

// Composer drafts, kept by pi-web beside the session (server/drafts.ts), never in its file: a
// reload keeps what the user typed, and a never-sent new session stays listed as a draft row.
const MAX_DRAFT_CHARS = 1_000_000;

app.get("/api/sessions/draft", (c) => {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  // Mutable state read at open time: a cached draft would come back missing what was just attached.
  return c.json(draftForClient(idOf(path)), 200, { "Cache-Control": "no-store" });
});

app.put("/api/sessions/draft", async (c) => {
  let body: { path?: unknown; text?: unknown; attachments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { path, text, attachments? }" }, 400);
  }
  if (typeof body.text !== "string") return c.json({ error: "text must be a string" }, 400);
  const path = resolveSessionPath(typeof body.path === "string" ? body.path : null);
  if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  if (body.text.length > MAX_DRAFT_CHARS) return c.json({ error: "Draft too long" }, 400);
  if (body.attachments !== undefined && !Array.isArray(body.attachments)) return c.json({ error: "attachments must be an array" }, 400);
  // Invalid entries are dropped by the store rather than failing the whole write.
  setDraft(idOf(path), body.text, body.attachments);
  return c.json({ ok: true });
});

app.get("/api/cwds", async (c) => c.json(await listCwds()));

// Configured remote targets with a cached, bounded reachability probe (server/targets.ts).
app.get("/api/targets", async (c) => c.json(await listTargets()));

// The folder picker's Remote tab: subfolders on a target, over its argv builder. Never hangs: 502 on
// an unreachable target, with the reason.
app.get("/api/targets/:name/folders", async (c) => {
  const r = await listRemoteFolders(c.req.param("name"), c.req.query("path"), { hidden: c.req.query("hidden") === "1" });
  return r.ok ? c.json(r.listing) : c.json({ error: r.error }, r.status);
});

// Subfolders for the New Session folder picker. Directory names only, never files (server/folders.ts).
app.get("/api/folders", async (c) => {
  const r = await listFolders(c.req.query("path"), { hidden: c.req.query("hidden") === "1" });
  return r.ok ? c.json(r.listing) : c.json({ error: r.error }, r.status);
});

app.get("/api/models", async (c) => c.json(await listModels()));

// The subagent model policy (spec/12-settings-dialog.md §12): GET reads it (empty = nothing
// disabled), PUT replaces the whole policy. The subagents extension picks the file up per spawn.
app.get("/api/settings/subagents", (c) => c.json(readSubagentPolicy()));
app.put("/api/settings/subagents", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { disabledProviders, disabledModels }" }, 400);
  }
  const result = writeSubagentPolicy(body);
  return "error" in result ? c.json({ error: result.error }, 400) : c.json(result);
});

// pi-web's own settings (server/web-settings.ts): today one experimental switch. GET reads the
// stored value, PUT replaces it. The switch drives the `claude-code-provider` extension flag, so
// it applies to sessions created after the change — an open chat keeps the runtime it started with.
app.get("/api/settings", (c) => c.json(readWebSettings()));
app.put("/api/settings", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { experimental: { claudeCodeProvider } }" }, 400);
  }
  const result = writeWebSettings(body);
  return "error" in result ? c.json({ error: result.error }, 400) : c.json(result);
});

// Is the Claude Code CLI actually usable? `claude --version` plus how many of its models the
// shared runtime holds. Answering from the runtime rather than a second live probe keeps the
// Settings dialog free of CLI spawns beyond the version check, and reports what the picker will
// really show.
app.get("/api/settings/claude-status", async (c) => {
  const status = await claudeCliStatus();
  return c.json(status.error === undefined ? { ...status, models: await claudeCodeModelCount() } : status);
});

// The mode is per session (spec/04g-mode-menu.md §4g). ~/.pi/agent/mode.json is the default new sessions
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
// directly in /tmp or in a session's attachments folder, after resolving symlinks. no-store:
// /tmp names get reused and cleaned.
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

// Removes one composer-draft upload (a chip's remove button). Only under the attachments root:
// /tmp holds the TUI's clipboard pastes, which are not ours to delete.
app.delete("/api/attachment", (c) => {
  const r = deleteAttachment(c.req.query("path"));
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true });
});

// A web upload becomes a /tmp file like a TUI clipboard paste; the prompt text then references
// the path. Raw bytes + Content-Type (no multipart). 413 by middleware before we buffer.
// With ?draft=<session path> it lands in that session's attachments folder instead, durable
// across a reload (the draft store carries it) and after the send (the prompt names it).
app.post(
  "/api/upload",
  bodyLimit({
    maxSize: MAX_ATTACHMENT_BYTES,
    onError: () => new Response(JSON.stringify({ error: "Image exceeds the 20MB limit" }), { status: 413, headers: { "Content-Type": "application/json" } }),
  }),
  async (c) => {
    try {
      const draft = c.req.query("draft");
      let dir: string | undefined;
      if (draft !== undefined) {
        const path = resolveSessionPath(draft);
        const d = path ? sessionAttachmentsDir(idOf(path)) : null;
        if (!path || !d) return c.json({ error: "Invalid ?draft= (must be a .jsonl under the pi sessions dir)" }, 400);
        if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
        dir = d;
      }
      const mime = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim();
      const saved = saveUploadedImage(new Uint8Array(await c.req.arrayBuffer()), mime, dir);
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

// /explain artifacts (server/explanations.ts). The store is read-only here: listing never fails,
// a missing or corrupt entry is simply absent. ?session=<sessionId> filters by parentSessionId.
app.get("/api/explanations", async (c) => c.json(await listExplanations(c.req.query("session"))));

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// The explanation page itself, raw: a standalone HTML document the gallery iframes and phones
// open directly. Registered before the static/SPA handlers below so those never shadow it; the
// query string is passed through untouched (the page reads ?theme= itself). The id must be a
// plain store dir name — anything with a slash, a ".." or nothing at all is a 404, not a read.
app.get("/explain/:id", async (c) => {
  const id = c.req.param("id");
  const html = isExplanationId(id) ? await readExplanationPage(id) : null;
  if (html === null) return c.text("Explanation not found", 404);
  return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" });
});

// Anything else under /explain (bare "/explain", a nested path, an encoded slash that didn't
// survive validation) is a missing explanation, not the SPA shell.
app.all("/explain", (c) => c.text("Explanation not found", 404));
app.all("/explain/*", (c) => c.text("Explanation not found", 404));

// Built frontend (vite build → dist/) with SPA fallback. Checked per request so a build made
// after the server started is picked up.
const hasDist = () => existsSync(join(DIST_DIR, "index.html"));
const staticFiles = serveStatic({ root: DIST_DIR });
const spaIndex = serveStatic({ root: DIST_DIR, path: "index.html" });
app.use("*", (c, next) => (hasDist() ? staticFiles(c, next) : next()));
app.get("*", (c, next) => (hasDist() ? spaIndex(c, next) : next()));

// Exported for server/explanations.test.ts, which drives routes through app.request() (no socket).
export { app };

export const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`pi-web server on http://${HOST}:${info.port}`);
}) as Server;
server.on("error", (err) => {
  // e.g. EADDRINUSE: don't linger half-alive behind the uncaughtException handler
  console.error("[server] listen failed:", err.message);
  process.exit(1);
});
attachWebSockets(server);

// With the experimental switch on, register the Claude Code provider now rather than when the
// user first opens a session, so its models are in GET /api/models for the picker straight away.
// A no-op when the switch is off, and never fatal: see warmClaudeCodeProvider.
void (async () => {
  try {
    await warmClaudeCodeProvider(await getModelRuntime(), getAgentDir());
  } catch (err) {
    console.warn("[server] claude-code warm-up skipped:", err instanceof Error ? err.message : String(err));
  }
})();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  // Hosted subagent workers (PI_WORKER_TRANSPORT=host) outlive this process: the
  // subagents extension's session_shutdown detaches them instead of killing them.
  // No-op for the default inline transport. See pi-config/extensions/subagents/hosting.ts.
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-web:detach-workers")] = true;
  await Promise.race([disposeAllChats(), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
