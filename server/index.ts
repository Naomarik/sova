import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { disposeAllChats, getModelRuntime, heldChat, onAgentSettled, warmClaudeCodeProvider } from "./chat-manager";
import { canonicalPath, resolveSessionPath } from "./paths";
import { stateRoot } from "./state-root";
import { claudeCodeModelCount, listModels, listRegistryModels, resolveContext } from "./models";
import { setFavorite } from "./model-favorites";
import { markOwned } from "./write-guard";
import { addWebSession } from "./web-sessions";
import { draftForClient, setDraft } from "./drafts";
import { decodeWorkers, getAgentsInsight, getSessionInsight, getUsageInsight, refreshUsageInsight } from "./insights";
import { archiveSession, cleanupSessions, getSessionSummary, idOf, lastReplyAtOf, listCwds, listSessionFiles, listSessions } from "./sessions-index";
import { cleanSessionTitle, SESSION_TITLE_MAX, setSessionTitle } from "./session-titles";
import { contextForBranch, normalizeEntries, readActiveBranch } from "./transcript";
import { checkTmpImage, deleteAttachment, MAX_ATTACHMENT_BYTES, readTmpImage, saveUploadedImage, sessionAttachmentsDir, UploadError } from "./attachments";
import { listFolders } from "./folders";
import { listProjectFiles } from "./files";
import { getGitSummary } from "./git-summary";
import { getSessionSetup } from "./session-setup";
import { assignSession, cleanGroupLabel, createGroup, deleteGroup, GROUP_LABEL_MAX, readGroups, updateGroup } from "./session-groups";
import { promptGroup } from "./group-prompt";
import { runFanout } from "./fanout";
import { runFork } from "./fork";
import type { FanoutRequest, ForkRequest, WorkerResumeResult } from "../shared/protocol";
import { findTarget, isTargetName, listRemoteFolders, listTargets, normalizeRemotePath, targetDir, targetsFile, validateNewSessionCwd } from "./targets";
import { isExplanationId, listExplanations, readExplanationPage } from "./explanations";
import { switchMode } from "./mode";
import { cachedClaudeModels, delegateInfo, delegateOptions, saveDelegateSettings, type DelegateSources } from "./delegate";
import { saveSpecSettings, specInfo, specOptions } from "./spec-settings";
import { readModelPolicy, writeModelPolicy } from "./model-policy";
import { listThemes } from "./themes";
import { listPlaybooks } from "./playbooks";
import { readWebSettings, writeWebSettings } from "./web-settings";
import { readSummarizerSettings, writeSummarizerSettings } from "./topic-outline-settings";
import { claudeCliStatus } from "./claude-status";
import { modeInfo, parseModeRequest, readMode } from "./mode-state";
import { parseSandboxBody } from "./sandbox-state";
import { WORKER_ID_RE } from "./worker-resume";
import { attachWebSockets, upgradeSovaSocket } from "./ws";
import { meshApi, meshRoutes, startMesh, stopMesh } from "./mesh";
import { mountDetails } from "./mesh/details";
import { mountSync } from "./sync";
import { markSeen } from "./seen";
import {
  attentionForWire,
  clearOverseer,
  overseerInfo,
  overseerSettingsInfo,
  pathOfId,
  promptSession,
  overseerSender,
  OVERSEER_SENDER_HEADER,
  saveOverseerSettings,
  setOverseerDispatch,
  startOverseerLoop,
} from "./overseer";
import { readNotes, writeNotes, NOTES_MAX } from "./overseer-store";
import { checkRename, IdeaConflictError, IdeaError, ideaDetail, ideasInfo, parseIdeaId, updateIdea, type IdeaUpdate } from "./overseer-ideas";
import { renameIdeaEverywhere } from "./overseer-idea-tools";
import { addTodo, clearDone, removeTodo, reorderTodos, TodoConflictError, TodoError, TodoNotFoundError, todosInfo, updateTodo } from "./overseer-todos";
import { findExtension, listExtensions, proxyExtension, serveExtensionFile, setSovaPort } from "./extensions";
import { decisionRuntime, decisions, decisionSettings, decisionsReady } from "./decide-runtime";
import { decisionsInfo, decisionsOptions, deleteKey, probeDecisions, putJevKey, saveDecisions } from "./decide-routes";
import { AttentionSignals } from "./attention-signals";
import { configureSessionFeed, nudgeMarks, publishFeed } from "./session-feed";
import { onTagsChanged } from "./session-tags";
import { startSessionTags, tagRoutes } from "./tags-backfill";
import { readLiveRecords } from "./live";
import { defaultAdapters } from "./worker-adapters";
import { serverRedactor } from "./overseer-redact";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4800; // PORT=0: an ephemeral port (tests)
// Loopback by default; set HOST=0.0.0.0 to deliberately expose on the LAN.
const HOST = process.env.HOST || "127.0.0.1";
const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
/** tokens.css and base.css, served as is at /design/* for extension UIs (server/extensions.ts). */
const DESIGN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "design");
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
  // Seen at birth: whoever made it is looking at it, so its first reply can later read as unread.
  markSeen(header.id);
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
  // The one rule, shared with fanout's fresh mode (spec 14b: fresh IS this path N times).
  const cwdError = await validateNewSessionCwd(cwd);
  if (cwdError) return c.json({ error: cwdError }, 400);
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
  const dir = join(stateRoot(), "connect");
  mkdirSync(dir, { recursive: true });
  const agents = template.replaceAll("{{TARGETS_FILE}}", targetsFile()).replaceAll("{{AGENT_DIR}}", getAgentDir());
  const tmp = join(dir, `AGENTS.md.${process.pid}.tmp`);
  writeFileSync(tmp, agents);
  renameSync(tmp, join(dir, "AGENTS.md"));
  return createWebSession(c, dir);
});

// The sidebar's user-made groups: Sova's own grouping of
// sessions, stored in ~/.pi/agent/sova/session-groups.json. Keyed by
// session id, like the archive,
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

// Name, member order and member labels: whatever the body carries, in one write.
app.patch("/api/session-groups/:id", async (c) => {
  let body: { name?: unknown; order?: unknown; labels?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { name?, order?, labels? }" }, 400);
  }
  const r = updateGroup(c.req.param("id"), body);
  return r.ok ? c.json(r.group) : c.json({ error: r.error }, r.status);
});

app.delete("/api/session-groups/:id", (c) =>
  deleteGroup(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Group not found" }, 404),
);

// One session into one group (or out of it, with `groupId: null`).
app.post("/api/session-groups/assign", async (c) => {
  let body: { path?: unknown; groupId?: unknown; label?: unknown; index?: unknown; id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { path, groupId, label? }" }, 400);
  }
  if (body.groupId !== null && typeof body.groupId !== "string") return c.json({ error: "groupId must be a group id or null" }, 400);
  // REMOVAL BY ID — the "This session's file is gone" pane's gesture (spec 14): a member whose
  // file was deleted outside Sova has no path to send, but its assignment is exactly what
  // needs removing and the store keys on ids. Valid for removal ONLY: adding a member requires
  // the file, so an id with a non-null groupId, with a path, or with label/index is a 400.
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !body.id) return c.json({ error: "id must be a session id" }, 400);
    if (body.groupId !== null) return c.json({ error: "id is valid only for removal (groupId: null); use path to assign" }, 400);
    if (body.path !== undefined) return c.json({ error: "send either path or id, not both" }, 400);
    if (body.label !== undefined || body.index !== undefined) return c.json({ error: "label and index belong to an assignment, not a removal" }, 400);
    const out = assignSession(body.id, null);
    // dissolved is set only when this write emptied a fanout group, which the server then deleted.
    return out.ok ? c.json({ ok: true, ...(out.dissolved ? { dissolved: true } : {}) }) : c.json({ error: out.error }, out.status);
  }
  // Omitted keeps the label the session already had (a move between groups carries it).
  const label = body.label === undefined ? { ok: true as const, label: undefined } : cleanGroupLabel(body.label);
  if (!label.ok) return c.json({ error: `label must be a string of at most ${GROUP_LABEL_MAX} characters, or null` }, 400);
  // Where in the target group's order it lands; omitted (or past the end) means the end.
  if (body.index !== undefined && (typeof body.index !== "number" || !Number.isInteger(body.index) || body.index < 0))
    return c.json({ error: "index must be a non-negative integer" }, 400);
  const path = resolveSessionPath(typeof body.path === "string" ? body.path : null);
  if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  const r = assignSession(idOf(path), body.groupId, label.label, body.index as number | undefined);
  // dissolved is set only when this write emptied a fanout group, which the server then deleted.
  return r.ok ? c.json({ ok: true, ...(r.dissolved ? { dissolved: true } : {}) }) : c.json({ error: r.error }, r.status);
});

// The group workspace's shared follow-up: one request, N sessions, all-or-nothing.
// The pre-check refuses the whole batch before a single member is prompted.
app.post("/api/session-groups/:id/prompt", async (c) => {
  let body: { text?: unknown; members?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { text, members? }" }, 400);
  }
  if (typeof body.text !== "string") return c.json({ error: "text must be a string" }, 400);
  if (body.members !== undefined && (!Array.isArray(body.members) || body.members.some((m) => typeof m !== "string")))
    return c.json({ error: "members must be an array of session ids" }, 400);
  const r = await promptGroup(c.req.param("id"), body.text, body.members as string[] | undefined);
  if (r.ok) return c.json(r.result);
  return r.status === 409 ? c.json({ refused: r.refused }, 409) : c.json({ error: r.error }, r.status);
});

// N sessions from one starting point, as one group. Fork mode branches every
// member from one entry of one source; fresh mode makes N independent sessions in a folder.
app.post("/api/session-groups/fanout", async (c) => {
  let body: FanoutRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { name, members, source | cwd }" }, 400);
  }
  const r = await runFanout(body);
  if (r.ok) return c.json(r.result, 201);
  if (r.status === 409) return c.json({ refused: r.refused }, 409);
  // One 400 carries a code (seed-conflict), so the client renders its own sentence for it.
  return c.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status);
});

// One new session branched off one entry of another: the per-message Fork action (server/fork.ts).
// Not a one-member fanout — no group, no seed, no member marker — and nothing is ever sent.
app.post("/api/sessions/fork", async (c) => {
  let body: ForkRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { path, entryId, position }" }, 400);
  }
  const r = await runFork(body);
  if (r.ok) return c.json(r.result, 201);
  if (r.status === 409) return c.json({ refused: r.refused }, 409);
  return c.json({ error: r.error }, r.status);
});

// Moves a web-spawned session between the sidebar regions. Changes Sova's own id list only.
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

// Renames a session, in Sova ONLY (server/session-titles.ts): the id gets a stored title and
// the .jsonl is never opened, let alone written — a session open in a TUI can be renamed here
// without touching the file that TUI owns. `title: null` clears the override, and the derived
// title (the first user message) comes back.
app.post("/api/sessions/title", async (c) => {
  let body: { path?: unknown; title?: unknown };
  try {
    const parsed: unknown = await c.req.json();
    // Valid JSON is not yet a body: `null`, `7`, `"x"` and `[]` all parse, and reading `.title`
    // off any of them is a TypeError the client would see as a 500 rather than its own mistake.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as { path?: unknown; title?: unknown };
  } catch {
    return c.json({ error: "Expected JSON body { path, title }" }, 400);
  }
  if (body.title !== null && typeof body.title !== "string") return c.json({ error: "title must be a string, or null to clear it" }, 400);
  const title = body.title === null ? null : cleanSessionTitle(body.title);
  if (body.title !== null && title === null) return c.json({ error: `title must be 1–${SESSION_TITLE_MAX} characters, and no control characters` }, 400);
  const path = resolveSessionPath(typeof body.path === "string" ? body.path : null);
  if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  // The id comes from the header the summary read, never from the file name: that is the id the
  // archive mark and the group assignment are keyed by too.
  const before = await getSessionSummary(path);
  if (!before) return c.json({ error: "Session file not found" }, 404);
  setSessionTitle(before.id, title);
  const summary = await getSessionSummary(path);
  return c.json(summary ?? { ...before, title: title ?? before.originalTitle ?? before.title });
});

// Permanently deletes transcript files from disk: sessions older than 7 or 30 days, empty
// zero-input husks, or the named sessions of paths mode (one archived row at a time). dryRun reports what would go (deletedIds) without
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

// Composer drafts, kept by Sova beside the session (server/drafts.ts), never in its file: a
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

// The composer's @-mention index (server/files.ts): every non-ignored file under the session
// cwd, gitignore-respecting in git repos, default-ignored elsewhere, cached ~30s server-side.
// 501 for an unmounted remote session's placeholder cwd.
app.get("/api/files", async (c) => {
  const r = await listProjectFiles(c.req.query("cwd"));
  return r.ok ? c.json(r.index) : c.json({ error: r.error }, r.status);
});

// A session's repository (server/git-summary.ts): read-only git of the whole repository around the
// session's stored cwd, here or on its target. Never fetches, never sends contents. A folder with no
// repository, or one that can't be read, is still a 200 whose `state` says so; ?fresh=1 skips the
// ~10s cache (the Refresh button).
app.get("/api/sessions/git", async (c) => {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  return c.json(await getGitSummary(path, { fresh: c.req.query("fresh") === "1" }));
});

// What pi will load for a session's folder (server/session-setup.ts): the context files it writes
// into the prompt and the skills it offers this session, each with its size on disk — the empty
// state of a session with no messages yet. Same 400/404 as the git route above; a folder that can't
// be read is a 200 whose `state` says so; ?fresh=1 skips the ~30s cache. A target session answers
// `state: "remote"` (its cwd is a local placeholder), and the client shows the repository alone.
app.get("/api/sessions/context", async (c) => {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  return c.json(await getSessionSetup(path, { fresh: c.req.query("fresh") === "1" }));
});

app.get("/api/models", async (c) => c.json(await listModels()));
// Star/unstar one model (the picker's favorite toggle), written through the command-palette's own
// store (server/model-favorites.ts), so the TUI's Ctrl+P list and every picker read the same file.
app.put("/api/models/favorite", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Expected { ref: "provider/id", favorite: boolean }' }, 400);
  }
  const result = setFavorite(body);
  return c.json(result.body, result.status);
});

// The model policy: GET reads it (empty = nothing disabled), PUT
// replaces the whole policy. It is a rule, not a filter — this server refuses a disabled model on
// set_model and on the next message of a session already sitting on one, and the pi extensions
// pick the same file up per model change, per turn and per spawn, TUI sessions included.
app.get("/api/settings/models", (c) => c.json(readModelPolicy()));
app.put("/api/settings/models", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body with the four policy lists" }, 400);
  }
  const result = writeModelPolicy(body);
  return "error" in result ? c.json({ error: result.error }, 400) : c.json(result);
});

// Every theme we can find: the 18 shipped ones plus whatever is in
// ~/.pi/agent/sova/themes/, rescanned per request. Read-only — the choice is the browser's, kept
// in localStorage, so there is nothing here to write. Never fails: a file we can't use comes
// back as a row carrying its reason, and an unreadable folder as `error` beside the built-ins.
app.get("/api/themes", (c) => c.json(listThemes()));

// The composer's Playbooks dialog (server/playbooks.ts): the shipped playbooks/, the user's
// ~/.pi/agent/sova/playbooks/ and the session cwd's .sova/marketing/playbooks/, rescanned per
// request. Read-only, and never fails: a cwd that can't be listed (none, remote, missing) is
// `project.state`, an unreadable user folder is `error`, and everything else is still listed.
app.get("/api/playbooks", async (c) => c.json(await listPlaybooks(c.req.query("cwd"))));

// Sova's own settings (server/web-settings.ts): today one experimental switch. GET reads the
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
  if ("error" in result) return c.json({ error: result.error }, 400);
  // Turning the switch on registers the provider now, so the very next GET /api/models offers the
  // Claude Code models without a server restart. Best-effort, like the startup warm-up.
  if (result.experimental.claudeCodeProvider) {
    try {
      await warmClaudeCodeProvider(await getModelRuntime(), getAgentDir());
    } catch (err) {
      console.warn("[server] claude-code warm-up skipped:", err instanceof Error ? err.message : String(err));
    }
  }
  return c.json(result);
});

// Settings → Modes → Delegate: which worker each kind of
// Delegate work goes to. The file is the mode extension's; every Delegate session re-reads it at
// its next turn boundary, so a save here reaches open Delegate chats and TUI sessions alike.
const delegateSources: DelegateSources = {
  piModels: () => listRegistryModels(),
  claudeModels: () => cachedClaudeModels(),
  policy: () => readModelPolicy(),
};
app.get("/api/settings/delegate", (c) => c.json(delegateInfo()));
app.get("/api/settings/delegate/options", async (c) => c.json(await delegateOptions(delegateSources)));
app.put("/api/settings/delegate", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { version: 1, profiles }" }, 400);
  }
  const result = await saveDelegateSettings(body, delegateSources);
  return "error" in result ? c.json({ error: result.error }, 400) : c.json(result);
});

// Settings → Modes → Spec: which worker writes the spec while the spec minor mode is on. The file is
// the mode extension's; every session with spec on re-reads it at its next turn boundary, in either
// major mode. Discovery and the save check are Delegate's.
app.get("/api/settings/spec", (c) => c.json(specInfo()));
app.get("/api/settings/spec/options", async (c) => c.json(await specOptions(delegateSources)));
app.put("/api/settings/spec", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { version: 1, writer }" }, 400);
  }
  const result = await saveSpecSettings(body, delegateSources);
  return "error" in result ? c.json({ error: result.error }, 400) : c.json(result);
});

// Settings → Decisions: the decision seam's providers (Jev, a fallback model) and the two features
// that use it, attention signals and session tags (server/decide-routes.ts). The Jev key is written
// and deleted here but never sent back: only its last four characters and status.
async function jsonOrNull(c: Context): Promise<{ body: unknown } | null> {
  try {
    return { body: await c.req.json() };
  } catch {
    return null;
  }
}
app.get("/api/settings/decisions", (c) => c.json(decisionsInfo(), 200, { "Cache-Control": "no-store" }));
app.get("/api/settings/decisions/options", async (c) => c.json(await decisionsOptions(delegateSources)));
app.put("/api/settings/decisions", async (c) => {
  const req = await jsonOrNull(c);
  if (!req) return c.json({ error: "Expected JSON body { version: 1, jev, fallback, features, exclusions, neverSendTui }" }, 400);
  const r = await saveDecisions(req.body, delegateSources);
  return c.json(r.body, r.status);
});
app.put("/api/settings/decisions/key", async (c) => {
  const req = await jsonOrNull(c);
  if (!req) return c.json({ error: "Expected JSON body { key }" }, 400);
  const r = await putJevKey(req.body);
  return c.json(r.body, r.status);
});
app.delete("/api/settings/decisions/key", (c) => {
  const r = deleteKey();
  return c.json(r.body, r.status);
});
app.post("/api/settings/decisions/probe", async (c) => c.json(await probeDecisions()));

// Session tags (server/tags-backfill.ts): manual tags, and the backfill job of Settings → Decisions.
app.route("/api/sessions/tags", tagRoutes);

// Settings → Summaries: which model writes the sidebar's summary line. The file is the
// topic-outline extension's; the TUI and every runtime read it once per session, at session start,
// so a save applies to sessions started afterwards. Only the chain changes — every other key, and a
// kept summarizer's own timeout and budget, is written back as it was.
app.get("/api/settings/summarizer", (c) => c.json(readSummarizerSettings()));
app.put("/api/settings/summarizer", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { primary: { backend, model }, fallback }" }, 400);
  }
  const result = writeSummarizerSettings(body);
  return "error" in result ? c.json({ error: result.error }, result.status) : c.json(result);
});

// Is the Claude Code CLI actually usable? `claude --version` plus how many of its models the
// shared runtime holds. Answering from the runtime rather than a second live probe keeps the
// Settings dialog free of CLI spawns beyond the version check, and reports what the picker will
// really show.
app.get("/api/settings/claude-status", async (c) => {
  const status = await claudeCliStatus();
  return c.json(status.error === undefined ? { ...status, models: await claudeCodeModelCount() } : status);
});

// The mode is per session. ~/.pi/agent/mode.json is the default new sessions
// start from; GET reads it, POST without ?path= writes it and changes no open chat. A switch never writes
// it (chat-manager switchMode): the default moves when a caller asks for exactly that.
app.get("/api/mode", (c) => c.json(modeInfo(readMode())));

// With ?path=<session .jsonl>: switch that one held chat, from its next message (server/chat-manager
// applyMode), or with { saveDefault: true } make that chat's own mode the default, switching nothing
// (chat-manager saveModeDefault). Without it: write the default directly (server/mode.ts).
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
  const request = parseModeRequest(body);
  if ("error" in request) return c.json({ error: request.error }, 400);
  if (request.kind === "saveDefault") {
    // A chat's own mode is what is saved, so there has to be a chat: no path is a 400, not a write
    // of whatever the file already says.
    if (path === null) return c.json({ error: "saveDefault needs ?path=: it saves that chat's own mode" }, 400);
    const chat = heldChat(path);
    if (!chat) return c.json({ error: "That session isn't open on this server; open the chat first" }, 404);
    return c.json(await chat.saveModeDefault());
  }
  if (path === null) return c.json(await switchMode(request.patch));
  const chat = heldChat(path);
  if (!chat) return c.json({ error: "That session isn't open on this server; open the chat first" }, 404);
  return c.json(await chat.switchMode(request.patch));
});

// The sandbox extension's on/off for one held chat (§chat/sandbox): its /sandbox handler runs
// directly (server/sandbox-state.ts). "unsupported" when the runtime has no sandbox extension.
app.post("/api/sandbox", async (c) => {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const parsed = parseSandboxBody(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const chat = heldChat(path);
  if (!chat) return c.json({ error: "That session isn't open on this server; open the chat first" }, 404);
  return c.json(await chat.applySandbox(parsed.on));
});

// Resume one restored subagent worker of a held chat, idle (server/worker-resume.ts): the subagents
// extension's own `agent-resume` handler runs; its refusal comes back as the 409's reason.
app.post("/api/workers/resume", async (c) => {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
  const id = c.req.query("id") ?? "";
  if (!WORKER_ID_RE.test(id)) return c.json({ error: "Invalid or missing ?id= (a worker id like ag_03)" }, 400);
  const chat = heldChat(path);
  if (!chat) return c.json({ error: "That session isn't open on this server; open the chat first" }, 404);
  const outcome = await chat.resumeWorker(id);
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ worker: chat.workerInfo(id) } satisfies WorkerResumeResult);
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

// Insights: views of extension state (docs/insights-research.md). Missing or corrupt sources
// come back as empty/unavailable payloads, not errors; the refresh route below is the one writer.
app.get("/api/insights/usage", async (c) => c.json(await getUsageInsight()));

app.post("/api/insights/usage/refresh", async (c) => {
  try {
    return c.json(await refreshUsageInsight());
  } catch (err) {
    return c.json({ error: (err as Error).message || "usage refresh failed" }, 502);
  }
});

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

// The Overseer (server/overseer.ts): the one special session that watches and acts on the others.
// GET ensures the current file exists; the list poll never creates it.
app.get("/api/overseer", async (c) => c.json(await overseerInfo(), 200, { "Cache-Control": "no-store" }));
app.post("/api/overseer/clear", async (c) => c.json(await clearOverseer()));
app.get("/api/overseer/attention", async (c) => c.json(await attentionForWire(), 200, { "Cache-Control": "no-store" }));
app.get("/api/overseer/notes", (c) => c.json({ text: readNotes() }, 200, { "Cache-Control": "no-store" }));
// `base` (optional): the notes the editor started from. When the file no longer holds them (the
// Overseer's sova_note wrote meanwhile) the save is refused with 409 and the current text, so a
// Settings save never deletes a note it never saw.
app.put("/api/overseer/notes", async (c) => {
  let body: { text?: unknown; base?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { text }" }, 400);
  }
  if (typeof body?.text !== "string") return c.json({ error: "text must be a string" }, 400);
  if (body.text.length > NOTES_MAX) return c.json({ error: `Notes must be at most ${NOTES_MAX} characters` }, 400);
  if (body.base !== undefined && typeof body.base !== "string") return c.json({ error: "base must be a string" }, 400);
  const current = readNotes();
  if (typeof body.base === "string" && body.base !== current)
    return c.json({ error: "The standing notes changed since you opened them (the Overseer added one). Nothing was saved.", text: current }, 409);
  return c.json({ text: writeNotes(body.text) });
});
// The ideas backlog (server/overseer-ideas.ts). The Overseer's sova_idea and this PATCH are its
// only writers; `base` (the updatedAt the editor started from) makes a stale edit a 409 carrying
// the current idea, so the panel never overwrites what the Overseer appended meanwhile. `newId`
// renames it (checked before anything is saved, applied after the other fields); a former id
// still reads and patches the idea under its new one.
app.get("/api/overseer/ideas", (c) => c.json(ideasInfo(), 200, { "Cache-Control": "no-store" }));
app.get("/api/overseer/idea", (c) => {
  const id = parseIdeaId(c.req.query("id") ?? "")?.id;
  if (!id) return c.json({ error: "id must be an idea id: §<project>/<name> or §<project>.<main>/<name>" }, 400);
  const detail = ideaDetail(id);
  return detail ? c.json(detail, 200, { "Cache-Control": "no-store" }) : c.json({ error: `No idea ${id}` }, 404);
});
app.patch("/api/overseer/idea", async (c) => {
  const id = parseIdeaId(c.req.query("id") ?? "")?.id;
  if (!id) return c.json({ error: "id must be an idea id: §<project>/<name> or §<project>.<main>/<name>" }, 400);
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { base?, title?, status?, tags?, links?, text?, newId? }" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected a JSON object" }, 400);
  const patch: IdeaUpdate = {};
  for (const key of ["base", "title", "status", "text"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") return c.json({ error: `${key} must be a string` }, 400);
    (patch as Record<string, unknown>)[key] = body[key];
  }
  for (const key of ["tags", "links"] as const) {
    if (body[key] === undefined) continue;
    if (!Array.isArray(body[key])) return c.json({ error: `${key} must be a list` }, 400);
    (patch as Record<string, unknown>)[key] = body[key];
  }
  if (body.newId !== undefined && typeof body.newId !== "string") return c.json({ error: "newId must be a string" }, 400);
  const found = ideaDetail(id);
  if (!found) return c.json({ error: `No idea ${id}` }, 404);
  try {
    // A newId equal to the current id is no rename. Refuse a bad one before any field is saved.
    const newId = typeof body.newId === "string" && parseIdeaId(body.newId)?.id !== found.idea.id ? body.newId : undefined;
    if (newId !== undefined) checkRename(found.idea.id, newId);
    const fields = Object.keys(patch).some((k) => k !== "base");
    let out = fields || newId === undefined ? updateIdea(found.idea.id, patch) : found;
    if (newId !== undefined) out = renameIdeaEverywhere(found.idea.id, newId, { base: fields ? out.idea.updatedAt : patch.base }).detail;
    return c.json(out);
  } catch (err) {
    if (err instanceof IdeaConflictError) return c.json({ error: err.message, current: err.current }, 409);
    if (err instanceof IdeaError) return c.json({ error: err.message }, 400);
    throw err;
  }
});
// The user's todos (server/overseer-todos.ts). The Overseer's sova_todo and these routes are its
// writers; every write answers with the whole list, so the panel adopts it as it is. `base` is
// honoured only when sent (the panel sends it for text edits), making a stale edit a 409.
const todoFailure = (c: Context, err: unknown) => {
  if (err instanceof TodoConflictError) return c.json({ error: err.message, current: err.current }, 409);
  if (err instanceof TodoNotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof TodoError) return c.json({ error: err.message }, 400);
  throw err;
};
const todoBody = async (c: Context): Promise<Record<string, unknown> | null> => {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
app.get("/api/overseer/todos", (c) => c.json(todosInfo(), 200, { "Cache-Control": "no-store" }));
app.post("/api/overseer/todos", async (c) => {
  const body = await todoBody(c);
  if (!body) return c.json({ error: "Expected JSON body { text, ideaId?, sessionId? }" }, 400);
  for (const key of ["text", "ideaId", "sessionId"] as const)
    if (body[key] !== undefined && typeof body[key] !== "string") return c.json({ error: `${key} must be a string` }, 400);
  try {
    addTodo({ text: body.text, ideaId: body.ideaId, sessionId: body.sessionId });
    return c.json(todosInfo(), 201, { "Cache-Control": "no-store" });
  } catch (err) {
    return todoFailure(c, err);
  }
});
app.patch("/api/overseer/todo", async (c) => {
  const body = await todoBody(c);
  if (!body) return c.json({ error: "Expected JSON body { base?, text?, done?, ideaId?, sessionId? }" }, 400);
  const patch: Parameters<typeof updateTodo>[1] = {};
  for (const key of ["base", "text"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") return c.json({ error: `${key} must be a string` }, 400);
    patch[key] = body[key];
  }
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") return c.json({ error: "done must be true or false" }, 400);
    patch.done = body.done;
  }
  for (const key of ["ideaId", "sessionId"] as const) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== "string") return c.json({ error: `${key} must be a string or null` }, 400);
    patch[key] = body[key];
  }
  try {
    updateTodo(c.req.query("id") ?? "", patch);
    return c.json(todosInfo(), 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return todoFailure(c, err);
  }
});
app.delete("/api/overseer/todo", (c) => {
  try {
    removeTodo(c.req.query("id") ?? "");
    return c.json(todosInfo(), 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return todoFailure(c, err);
  }
});
app.put("/api/overseer/todos/order", async (c) => {
  const body = await todoBody(c);
  if (!body || !Array.isArray(body.ids)) return c.json({ error: "Expected JSON body { ids: string[] }" }, 400);
  try {
    reorderTodos(body.ids);
    return c.json(todosInfo(), 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return todoFailure(c, err);
  }
});
app.delete("/api/overseer/todos/done", (c) => {
  clearDone();
  return c.json(todosInfo(), 200, { "Cache-Control": "no-store" });
});
app.get("/api/settings/overseer", (c) => c.json(overseerSettingsInfo()));
app.put("/api/settings/overseer", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { version: 1, model, thinking, extraSystemPrompt, proactivity, quickActions, caps, explorer }" }, 400);
  }
  const result = await saveOverseerSettings(body);
  return "error" in result ? c.json({ error: result.error }, 400) : c.json(result);
});

// One session's summary by id, listed or not (an empty web session, an Overseer file): what a
// sova://s/<id> link resolves through when the list doesn't have it.
app.get("/api/sessions/summary", async (c) => {
  const id = c.req.query("id") ?? "";
  if (!/^[\w-]{1,100}$/.test(id)) return c.json({ error: "Invalid or missing ?id= (a session id)" }, 400);
  const path = await pathOfId(id);
  const summary = path ? await getSessionSummary(path) : null;
  if (!summary) return c.json({ error: "No session with that id" }, 404);
  return c.json(summary, 200, { "Cache-Control": "no-store" });
});

// One message to one session, as its composer sends it (sova_send, and a server-side first
// prompt): idle it starts a turn; mid-turn it is queued as `delivery` (followUp by default, or
// steer). Refused TUI-live, for the Overseer's own file, or when a foreign writer holds it.
app.post("/api/sessions/prompt", async (c) => {
  let body: { path?: unknown; text?: unknown; delivery?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON body { path, text }" }, 400);
  }
  if (typeof body?.text !== "string") return c.json({ error: "text must be a string" }, 400);
  if (body.delivery !== undefined && body.delivery !== "followUp" && body.delivery !== "steer")
    return c.json({ error: 'delivery must be "followUp" or "steer"' }, 400);
  const path = resolveSessionPath(typeof body.path === "string" ? body.path : null);
  if (!path) return c.json({ error: "Invalid or missing path (must be a .jsonl under the pi sessions dir)" }, 400);
  if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
  const r = await promptSession(path, body.text, overseerSender(c.req.header(OVERSEER_SENDER_HEADER)), body.delivery);
  return r.ok ? c.json({ ok: true, queued: r.queued, kind: r.kind, ...(r.compacting ? { compacting: true } : {}) }) : c.json({ error: r.error }, r.status);
});
// Installed extensions (server/extensions.ts), with each backend's cached health.
app.get("/api/extensions", async (c) => c.json(await listExtensions()));

// The mesh (server/mesh/): /api/mesh/*, the peer-only /api/peer/*, and the /peer/<id>/ proxy,
// which falls through to the handlers below while no peer is configured.
meshRoutes(app);
// Host-to-host sync (server/sync/): routes under /api/peer/* and mesh hooks only; OFF, inert.
const sync = mountSync(app, meshApi);
// Per-host details and rename (server/mesh/details.ts): /api/mesh/details|label, /api/peer/*; OFF, 404.
mountDetails(app, meshApi, {
  sessions: async () => (await listSessionFiles()).length,
  logins: () => {
    // Read at call time: the sync runtime replaces it on every mesh start. Counts only.
    const entries = sync.credentials?.status().entries;
    if (!entries) return null;
    return { count: entries.filter((e) => e.state === "live" || e.state === "expired").length, conflicts: entries.filter((e) => e.conflictWith?.length).length };
  },
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// Extensions: /ext/<id>/api/* and /ext/<id>/ws/* go to the extension's own backend, everything
// else under /ext/<id>/ is its built UI (a `/x/*` pattern also matches bare `/x`). The manifest is re-read per request. All of it sits
// before the static/SPA handlers so an /ext path is never the Sova shell. The WebSocket upgrade
// itself never reaches Hono (server/ws.ts); a plain GET of a ws path is answered here.
const extTail = (c: Context, id: string) => new URL(c.req.url).pathname.slice(`/ext/${id}`.length);
app.all("/ext/:id/api/*", async (c) => {
  const entry = findExtension(c.req.param("id"));
  return entry ? proxyExtension(c, entry, extTail(c, entry.id)) : c.json({ error: "Unknown extension" }, 404);
});
app.all("/ext/:id/ws/*", (c) =>
  findExtension(c.req.param("id")) ? c.json({ error: "WebSocket upgrade required" }, 426) : c.json({ error: "Unknown extension" }, 404),
);
// Relative asset URLs in the extension's index.html need the trailing slash.
app.get("/ext/:id", (c) => (findExtension(c.req.param("id")) ? c.redirect(`/ext/${c.req.param("id")}/`) : c.text("Unknown extension", 404)));
app.get("/ext/:id/*", (c) => {
  const entry = findExtension(c.req.param("id"));
  return entry ? serveExtensionFile(entry, extTail(c, entry.id).slice(1)) : c.text("Unknown extension", 404);
});
app.all("/ext/*", (c) => c.text("Not found", 404));

// Sova's design tokens and base stylesheet at stable URLs, for extension UIs to link (the app's
// own copies are bundled under hashed names). Read per request, so they follow a design edit.
for (const name of ["tokens.css", "base.css"]) {
  app.get(`/design/${name}`, (c) =>
    c.body(readFileSync(join(DESIGN_DIR, name), "utf8"), 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" }),
  );
}
app.all("/design/*", (c) => c.text("Not found", 404));

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
  setSovaPort(info.port);
  console.log(`sova server on http://${HOST}:${info.port}`);
  startMesh({ fetch: app.fetch, upgrade: upgradeSovaSocket });
}) as Server;
server.on("error", (err) => {
  // e.g. EADDRINUSE: don't linger half-alive behind the uncaughtException handler
  console.error("[server] listen failed:", err.message);
  process.exit(1);
});
attachWebSockets(server);

// The Overseer's tools call these same routes in-process (no socket, every guard applies).
setOverseerDispatch((path, init) => app.request(path, init));
startOverseerLoop();

// Decisions (Settings → Decisions; both features off by default, and then nothing is ever sent).
// The list's decision overlays are pushed on /ws/watch?feed=sessions (server/session-feed.ts);
// attention signals classify finished turns and long-running workers; session tags tag sessions.
configureSessionFeed({ list: listSessions });
const attentionSignals = new AttentionSignals({
  settings: decisionSettings,
  provider: () => (decisionsReady() ? decisions() : null),
  list: listSessions,
  summary: (path) => getSessionSummary(path),
  lastReplyAt: lastReplyAtOf,
  held: (path) => !!heldChat(path),
  liveRecords: () => readLiveRecords({ includeOwn: true }),
  decodeWorkers: (presence) => decodeWorkers(presence),
  adapters: defaultAdapters,
  redact: (value) => serverRedactor().redactDeep(value),
  changed: nudgeMarks,
});
attentionSignals.start();
onAgentSettled((path) => attentionSignals.turnSettled(path));
startSessionTags({
  list: listSessions,
  onAgentSettled,
  held: (path) => !!heldChat(path),
  provider: decisions,
  settings: decisionSettings,
  ready: () => {
    const s = decisionRuntime().chain.status();
    return { ready: s.ready, ...(s.reason ? { reason: s.reason } : {}) };
  },
  publish: (progress) => publishFeed({ type: "tags_backfill", progress }),
});
onTagsChanged(() => nudgeMarks());

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
  (globalThis as Record<symbol, unknown>)[Symbol.for("sova:detach-workers")] = true;
  stopMesh();
  await Promise.race([disposeAllChats(), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
