// What pi will LOAD for a session's folder: the context files it writes into the prompt, and the
// skills it offers this session, each with its size on disk. GET /api/sessions/context
// (shared/protocol.ts SessionSetup), rendered in the empty state of a session with no messages yet.
//
// Two sources, one shape:
//
//  - **the open chat's own loader** (`chatHandle(path).resources()`) when this server
//    holds the session: the exact set that session prompts with, extension-added skill paths
//    included, and free — the runtime has already read every one of those files to build its
//    prompt;
//  - **pi's own loader without extensions** (`folderResources`, server/harness/pi/resources.ts), for
//    a session nobody holds (an empty file a TUI owns, read through /ws/watch). That is a LOWER
//    BOUND: a skill path an extension registers at session_start is invisible to it, which is what
//    `fromRuntime` reports.
//
// Nothing here re-implements pi's discovery — not the candidate context filenames, not the worktree
// shadowing rule, not the settings-registered skill folders or the npm package ones. Those are pi's
// rules, they move with pi, and a second copy would drift; both sources above are pi's own code. Both
// also load the Claude skill folders Sova adds (server/harness/pi/skill-sources.ts, §chat/skill-sources).
//
// WHICH FOLDER is the other thing that must not be answered twice: `readStoredCwd` and `plan` come
// from git-summary, so the remote classification is the same one the Git section applies. A
// remote session's cwd is a LOCAL PLACEHOLDER — reading it would describe Sova's own disk — so the
// answer is `state: "remote"` and the client shows the repository alone (which does read the
// target).
//
// Sizes are measured on disk, never taken from the loader's own strings: one rule for both sources,
// and a file that changed since the runtime read it reports what is there now. Never a cap: pi
// reads each of these files in full to build the prompt, so the read that decides a size is a read
// pi has already done.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { HarnessResources } from "../shared/harness";
import type { SetupMcp } from "../shared/mcp";
import { CHARS_PER_TOKEN, SETUP_FILE_MAX_BYTES, type SessionSetup, type SessionSetupFileText, type SessionSetupFile, type SessionSetupSkill } from "../shared/protocol";
import { acquireChatHandle, assertNotLive, chatHandle, closeChat } from "./chat-handle";
import { plan, readStoredCwd, type Plan } from "./git-summary";
import { flipsAgainstProject, isContextOff, isSkillOff, normalizeLoadout, pristineLoadout, type LoadoutEntryData } from "./session-loadout";
import type { ApprovalLookup } from "./approvals-lookup";
import type { FolderScan } from "./approvals";
import type { FolderRule } from "../shared/folder-rule";
import type { ApprovalFolder, SetupApproval } from "../shared/approvals";
import { dirname, join } from "node:path";
import { candidateDirs, instructionFileIn } from "./deeper-context";
import { getSessionSummary } from "./sessions-index";
import { agentRoot } from "./state-root";
import { readBranch } from "./harness/pi/reader";
import { folderResources } from "./harness/pi/resources";
import { piSkillsIn } from "./harness/pi/skill-sources";
import { isSubfolderSkillFile } from "./subfolder-skills";
import { LOADOUT } from "./harness/state-kinds";
import type { McpSetupAsk } from "./mcp/chat";
import { stateView } from "./harness/state-view";

/** How long an answer stays fresh, per folder. The same size as the Git section's TTL. */
export const SETUP_TTL_MS = 30_000;

/** Lines in a buffer, counted the way `wc -l` counts them: the newlines, plus one for a last line
    the file never terminated. An empty file has none. */
export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let newlines = 0;
  for (const byte of buf) if (byte === 10) newlines++;
  return buf[buf.length - 1] === 10 ? newlines : newlines + 1;
}

/** pi's own estimate of what a text costs a model: `pi-ai`'s `estimateTextTokens`, ceil(code units /
    CHARS_PER_TOKEN) — `text.length`, UTF-16 code units, the same count pi makes (an emoji is 2). Sova never tokenizes — a real count belongs to the model, and this is the number
    pi itself budgets a prompt with, so the card can say what a file costs before it is sent. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** A file's size on disk and what its text would cost. null when it can't be read at all — gone
    since the caller listed it, a directory, a permission bit: the row is dropped rather than
    reported as an empty file. */
export function measureFile(path: string): { bytes: number; lines: number; tokens: number } | null {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  // Decoded once, for the estimate: pi counts the characters of the text it reads, not the bytes
  // on disk, and the two differ for anything that isn't ASCII.
  return { bytes: buf.length, lines: countLines(buf), tokens: estimateTokens(buf.toString("utf8")) };
}

/** What a loader found, whichever loader it was. Only paths: the contents are pi's business. */
export type Loadout = HarnessResources;

/** The loadout of the chat this server holds, or null when it holds none. A runtime built with a
    `sova-loadout` entry answers with its loader's UNFILTERED lists (§chat.transcript/setup-card-toggles),
    so a row it leaves out is still listed, and can be switched back on. */
async function runtimeLoadout(sessionPath: string): Promise<Loadout | null> {
  const chat = chatHandle(sessionPath);
  return chat ? chat.resources() : null;
}

/** What one session switches off, and whether its card may switch rows now. Worked out per session
    on every read; never part of the folder's cached answer. */
export interface SessionSwitches {
  off: LoadoutEntryData | null;
  toggleable: boolean;
}

/** The held chat's own entry and window (before its first message, already laid over its project's
    disallowed skills); else the newest entry in the file, read by Sova's own parser, likewise laid
    over the project's while no message is on the branch, except for a TUI-live session (the TUI
    doesn't honour the entry). */
async function sessionSwitches(sessionPath: string): Promise<SessionSwitches> {
  const chat = chatHandle(sessionPath);
  // A held chat that hasn't reported its loadout yet: its file and the folder's rule, as for a chat nobody holds.
  if (chat?.mirror.loadout) return { off: chat.mirror.loadout?.off ?? null, toggleable: chat.mirror.loadout?.toggleable ?? false };
  try {
    assertNotLive(sessionPath);
    const branch = await readBranch(sessionPath);
    const entry = stateView(branch).latest(LOADOUT)?.data ?? null;
    if (branch.some((h) => h.kind === "user")) return { off: entry, toggleable: false };
    const cwd = await readStoredCwd(sessionPath).catch(() => null);
    return { off: pristineLoadout(entry, cwd ? await ruleFor(cwd) : null), toggleable: false };
  } catch {
    return { off: null, toggleable: false };
  }
}

type Loaded = Extract<SessionSetup, { state: "ok" }>;

/** Whether no message is on a session's branch yet: the held chat's word, else its file's. */
async function isPristineSession(sessionPath: string): Promise<boolean> {
  const chat = chatHandle(sessionPath);
  if (chat) return !!chat.mirror.pristine;
  try {
    return !(await readBranch(sessionPath)).some((h) => h.kind === "user");
  } catch {
    return false;
  }
}

const mcpSetup = async (ask: McpSetupAsk) => (await import("./mcp/chat")).setupFor(ask);

/** A chat folder's approval list as the setup read lays it over its rows: the decisions now (never cached)
    and the folder's scan (cached with the folder's answer; `fresh` reads it again). */
export interface SetupApprovals {
  lookup: ApprovalLookup;
  folder: ApprovalFolder;
  scan: Pick<FolderScan, "items"> | null;
}

const approvalsMod = async () => import("./approvals");
const scanCache = new Map<string, { at: number; scan: FolderScan }>();

/** The folder's list for a chat in `cwd`, with its scan (null when it can't be read). */
async function approvalsOfFolder(cwd: string, fresh: boolean, now: () => number): Promise<SetupApprovals | null> {
  try {
    const m = await approvalsMod();
    const lookup = await m.approvalLookupForCwd(cwd);
    const hit = scanCache.get(lookup.folder.key);
    let scan: FolderScan | null = !fresh && hit && now() - hit.at < SETUP_TTL_MS ? hit.scan : null;
    if (!scan) {
      scan = await m.folderQuickScan(lookup.folder).catch(() => null);
      if (scan) scanCache.set(lookup.folder.key, { at: now(), scan });
    }
    return { lookup, folder: m.approvalFolderOf(lookup.folder), scan };
  } catch {
    return null;
  }
}

/** The decisions a new chat in `cwd` builds with (server/projects/folder-rule.ts). */
async function ruleFor(cwd: string): Promise<FolderRule | null> {
  try {
    return await (await import("./projects/folder-rule")).folderRuleForCwd(cwd);
  } catch {
    return null;
  }
}

/** One row's decision in the folder's list, by its file: keyed where it sits (placePath) and checked against its
    fingerprint (a skill's whole folder) as the folder's own scan and card are, so the two never disagree. An approval
    with no fingerprint, or a file that can't be read now, reads Changed. */
function approvalOf(a: SetupApprovals, kind: "context" | "skill", path: string, places: { checkout: string | null }): SetupApproval {
  const m = approvalsSync!;
  const place = m.placePath(path);
  const key = m.itemKey(a.lookup, place);
  const d = (kind === "context" ? a.lookup.context : a.lookup.skills)[key];
  const state = d?.state ?? "waiting";
  let changed = false;
  let partial = false;
  if (state === "approved") {
    let fp: { sha256: string; partial?: true };
    try {
      fp = m.itemFingerprint(kind, place);
    } catch {
      fp = { sha256: "" };
    }
    partial = !!fp.partial;
    changed = !fp.sha256 || m.itemChanged(a.lookup, kind, place, fp.sha256);
  } else if (kind === "skill") {
    try {
      partial = !!m.itemFingerprint(kind, place).partial;
    } catch {
      partial = false;
    }
  }
  const group = m.groupOf(kind, place, m.placesFor(places.checkout));
  return { key, state, group, ...(changed ? { changed: true as const } : {}), ...(partial ? { fingerprintPartial: true as const } : {}) };
}
/** The pure helpers approvalOf reads, loaded once with the module. */
let approvalsSync: (typeof import("./approvals") & { real: (p: string) => string; placesFor: (checkout: string | null) => import("./approvals").GroupPlaces }) | null = null;
async function loadApprovalsSync() {
  if (approvalsSync) return approvalsSync;
  const m = await approvalsMod();
  const { real } = await import("./mcp/folder");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { defaultClaudeDir } = await import("../pi-config/extensions/claude-code/accounts.ts");
  const placesFor = (checkout: string | null) => ({ checkout, agentDir: real(agentRoot()), home: real(homedir()), claudeDirs: [...new Set([real(defaultClaudeDir()), real(join(homedir(), ".claude"))])] });
  approvalsSync = { ...m, real, placesFor };
  return approvalsSync;
}

/**
 * Each row's decision in its folder's list, the list named, and whether this chat asks first (before its
 * first message the Sova-wide setting, after it the mode it was stamped with). Before the first message
 * the folder scan's items this chat's folder doesn't load at its start are listed too (`scanOnly`), so
 * they are decided first; their `off` is the chat's effective value.
 */
export function withApprovals(setup: Loaded, a: SetupApprovals | null, sw: SessionSwitches, pristine: boolean): Loaded {
  if (!a || !approvalsSync) return setup;
  const m = approvalsSync;
  const checkout = m.checkoutOf(a.lookup.checkouts, m.real(setup.cwd));
  const places = { checkout };
  const asking = pristine ? a.lookup.asking : !!sw.off?.asking;
  const context: SessionSetupFile[] = setup.context.map((f) => ({ ...f, approval: approvalOf(a, "context", f.path, places) }));
  const skills: SessionSetupSkill[] = setup.skills.map((k) => ({ ...k, approval: approvalOf(a, "skill", k.path, places) }));
  if (pristine && a.scan && checkout) {
    const have = new Set([...context, ...skills].map((r) => `${r.approval!.key}`));
    for (const i of a.scan.items) {
      if (have.has(i.key) || i.key.startsWith("/")) continue;
      const path = join(checkout, i.key);
      const size = measureFile(path);
      if (!size) continue;
      have.add(i.key);
      const approval = approvalOf(a, i.kind, path, places);
      if (i.kind === "context") {
        context.push({ path, ...size, approval, scanOnly: true, ...(isContextOff(sw.off, path) ? { off: true as const } : {}) });
      } else {
        const description = i.description?.trim();
        skills.push({ name: i.name, path, ...(description ? { description } : {}), ...size, approval, scanOnly: true, ...(isSkillOff(sw.off, { name: i.name, filePath: path }) ? { off: true as const } : {}) });
      }
    }
  }
  return { ...setup, context, skills, approvals: { folder: a.folder, asking } };
}

/** How many context files and skills a session's first message waits on: none once a message is sent, for a
    special chat, or without asking first; else its setup read's waiting rows, read fresh. A chat that hasn't
    reported its loadout yet is read from its folder's rule (a pristine chat's setup asks the folder), never as none. */
export async function waitingForSession(sessionPath: string, deps: SetupDeps = {}): Promise<number> {
  const chat = chatHandle(sessionPath);
  if (chat && (!chat.mirror.pristine || chat.mirror.special)) return 0;
  return waitingOf(await getSessionSetup(sessionPath, { fresh: true }, deps));
}

/** How many of a setup's rows wait for a decision while it asks first (Send waits on them). */
export function waitingOf(setup: SessionSetup): number {
  if (setup.state !== "ok" || !setup.approvals?.asking) return 0;
  return [...setup.context, ...setup.skills].filter((r) => r.approval?.state === "waiting").length;
}

/** The folder's answer as one session sees it: its off rows marked, and whether it can switch them.
    A new object: the cached answer is never changed. */
export function withSwitches(setup: Loaded, sw: SessionSwitches): Loaded {
  return {
    ...setup,
    context: setup.context.map(({ off: _o, ...f }) => (isContextOff(sw.off, f.path) ? { ...f, off: true as const } : f)),
    skills: setup.skills.map(({ off: _o, ...k }) => (isSkillOff(sw.off, { name: k.name, filePath: k.path }) ? { ...k, off: true as const } : k)),
    toggleable: sw.toggleable,
  };
}

/**
 * pi's own loader for a folder, without extensions.
 *
 * `noExtensions` is not a shortcut: loading the extension graph here would run every extension
 * module (and its factory) a SECOND time inside this process, for skills that the session itself
 * will discover at session_start anyway. What is lost is exactly those extension-registered skill
 * paths, which this answer reports through `fromRuntime` — and the case that reaches this fallback
 * is a session nothing is prompting in.
 */
async function loaderLoadout(cwd: string): Promise<Loadout> {
  return folderResources(cwd, agentRoot());
}

/** Injectable seams; every one has the real default. Tests swap them, callers never pass them. */
export interface SetupDeps {
  /** The session header's cwd (default: git-summary's reader). */
  storedCwd?: (sessionPath: string) => Promise<string | null>;
  /** The loadout of an OPEN chat, or null when nothing holds it (default: its handle's `resources`). */
  runtime?: (sessionPath: string) => Loadout | null | Promise<Loadout | null>;
  /** pi's own read for a folder (default: folderResources, pi's loader without extensions). */
  loader?: (cwd: string) => Promise<Loadout>;
  /** One session's off set and switch window (default: the held chat, else the file's entry). */
  switches?: (sessionPath: string) => SessionSwitches | Promise<SessionSwitches>;
  /** The folder's approval list and scan (default: server/approvals.ts); the decisions never cached. */
  approvals?: (cwd: string, fresh: boolean) => SetupApprovals | null | Promise<SetupApprovals | null>;
  /** Whether no message is on the session's branch yet (default: the held chat's mirror, else the file). */
  pristine?: (sessionPath: string) => boolean | Promise<boolean>;
  /** The MCP Servers group (default: server/mcp/chat.ts); never part of the folder's cached answer. */
  mcp?: (ask: McpSetupAsk) => Promise<SetupMcp | undefined>;
  /** Whether a local path exists (default: fs.existsSync). */
  exists?: (path: string) => boolean;
  now?: () => number;
}

/** The listed paths, sized, in the order they were listed; an unreadable one is left out. */
function filesOf(paths: readonly string[]): SessionSetupFile[] {
  const out: SessionSetupFile[] = [];
  for (const path of paths) {
    const size = measureFile(path);
    if (size) out.push({ path, ...size });
  }
  return out;
}

function skillsOf(skills: Loadout["skills"]): SessionSetupSkill[] {
  const out: SessionSetupSkill[] = [];
  for (const skill of skills) {
    const size = measureFile(skill.filePath);
    // The description is frontmatter: it carries the newline that ended it, and a blank one is not
    // a description. Trimmed here so every consumer shows the same words.
    const description = skill.description?.trim();
    if (size) out.push({ name: skill.name, path: skill.filePath, ...(description ? { description } : {}), ...(skill.manualOnly ? { manualOnly: true as const } : {}), ...size });
  }
  return out;
}

const cache = new Map<string, Loaded>();
const inflight = new Map<string, Promise<SessionSetup>>();

/** Test seam: forget every cached read. */
export function clearSetupCache(): void {
  cache.clear();
}

/** One folder's answer. Never throws: a loader that blew up is a `reason` in words. */
async function read(cwd: string, sessionPath: string, deps: SetupDeps, now: () => number): Promise<SessionSetup> {
  const base = { where: { kind: "local" } as const, cwd, checkedAt: now() };
  const unavailable = (reason: string): SessionSetup => ({ state: "unavailable", reason, ...base });
  if (!(deps.exists ?? existsSync)(cwd)) return unavailable(`This session's folder no longer exists: ${cwd}.`);

  let loadout: Loadout | null = null;
  try {
    loadout = await (deps.runtime ?? runtimeLoadout)(sessionPath);
  } catch {
    loadout = null; // a runtime that threw on a read is the same as no runtime: fall back
  }
  const fromRuntime = loadout !== null;
  if (!loadout) {
    try {
      loadout = await (deps.loader ?? loaderLoadout)(cwd);
    } catch (err) {
      return unavailable(`Sova couldn't read this folder's setup: ${(err as Error)?.message || "unknown error"}.`);
    }
  }

  const systemPrompt = loadout.systemPrompt ? filesOf([loadout.systemPrompt])[0] : undefined;
  const appendSystemPrompt = filesOf(loadout.appendSystemPrompt);
  return {
    state: "ok",
    ...base,
    context: filesOf(loadout.context.map((f) => f.path)),
    skills: skillsOf(loadout.skills),
    ...(loadout.skillProblems?.length ? { skillProblems: loadout.skillProblems.map((p) => ({ ...p })) } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(appendSystemPrompt.length ? { appendSystemPrompt } : {}),
    fromRuntime,
  };
}

/**
 * What pi will load for a session file (the caller has validated the path). Cached per folder for
 * SETUP_TTL_MS; `fresh` skips the cache but joins a read already in flight. Never throws: every
 * failure is a `state: "unavailable"` with the reason in words.
 *
 * The key is the folder, not the session: two sessions in one repository share the same lists.
 * What a session switches off, and whether it may switch now, is laid over that answer for each
 * session on every read (§chat.transcript/setup-card-toggles), so it is never shared. No
 * concurrency limit — the fallback read
 * is one settings read plus a handful of small file reads (~20ms here), and the runtime path is
 * free.
 */
export async function getSessionSetup(sessionPath: string, opts: { fresh?: boolean } = {}, deps: SetupDeps = {}): Promise<SessionSetup> {
  const now = deps.now ?? Date.now;
  let stored: string | null;
  try {
    stored = await (deps.storedCwd ?? readStoredCwd)(sessionPath);
  } catch {
    stored = null;
  }
  if (stored === null) {
    return { state: "unavailable", where: { kind: "local" }, cwd: "", reason: "This session file has no header to read its folder from.", checkedAt: now() };
  }
  let p: Plan;
  try {
    p = plan(stored);
  } catch (err) {
    return { state: "unavailable", where: { kind: "local" }, cwd: stored, reason: `Sova couldn't place this session's folder: ${(err as Error)?.message || "unknown error"}.`, checkedAt: now() };
  }
  if (p.kind === "refuse") return p.summary(now());
  if (p.kind === "remote") {
    const mcp = await (deps.mcp ?? mcpSetup)({ path: sessionPath, cwd: p.place.cwd, remote: p.target, off: null });
    return { state: "remote", where: { kind: "remote", target: p.target }, cwd: p.place.cwd, ...(mcp ? { mcp } : {}), checkedAt: now() };
  }

  const folder = await folderSetup(p.place.cwd, sessionPath, opts, deps, now);
  if (folder.state !== "ok") return folder;
  let sw: SessionSwitches;
  try {
    sw = await (deps.switches ?? sessionSwitches)(sessionPath);
  } catch {
    sw = { off: null, toggleable: false };
  }
  const mcp = await (deps.mcp ?? mcpSetup)({ path: sessionPath, cwd: folder.cwd, off: sw.off }).catch(() => undefined);
  await loadApprovalsSync().catch(() => null);
  const approvals = await Promise.resolve((deps.approvals ?? ((cwd, fresh) => approvalsOfFolder(cwd, fresh, now)))(folder.cwd, !!opts.fresh)).catch(() => null);
  const pristine = await Promise.resolve((deps.pristine ?? isPristineSession)(sessionPath)).catch(() => false);
  return { ...withApprovals(withSwitches(folder, sw), approvals, sw, pristine), ...(mcp ? { mcp } : {}) };
}

/** Every path this setup lists, in any of its groups: the only files /api/sessions/context/file reads. */
export function listedPaths(setup: Loaded): Set<string> {
  return new Set([...setup.context, ...setup.skills, ...(setup.systemPrompt ? [setup.systemPrompt] : []), ...(setup.appendSystemPrompt ?? [])].map((f) => f.path));
}

export type SetupFileResult = { ok: true; file: SessionSetupFileText } | { ok: false; status: 404 | 409 | 413; error: string };

/**
 * The text of one file the session's own setup read lists (§chat.transcript/setup-card-open-file),
 * for the markdown viewer. The list is the gate: a path it doesn't name is refused before any read,
 * so this never reads another file on disk. The setup read may be the folder's cached one (30s);
 * the file itself is read now, never cached.
 */
export async function readSetupFile(sessionPath: string, file: string, deps: SetupDeps = {}): Promise<SetupFileResult> {
  const setup = await getSessionSetup(sessionPath, {}, deps);
  if (setup.state === "remote") return { ok: false, status: 409, error: "This session's files are on another machine." };
  if (setup.state !== "ok") return { ok: false, status: 409, error: setup.reason };
  // An instruction file in a folder below cwd loads as the agent works there (server/deeper-context.ts): the
  // Context tab opens those too, gated on the engine's own rule for one (its folder's first instruction file).
  // A skill of such a folder too (server/subfolder-skills.ts): it is listed there before it is offered.
  if (!listedPaths(setup).has(file) && !(instructionFileIn(dirname(file)) === file && candidateDirs(setup.cwd, file).includes(dirname(file))) && !isSubfolderSkillFile(setup.cwd, file, piSkillsIn))
    return { ok: false, status: 404, error: "That file isn't in this session's system context." };
  try {
    if (statSync(file).size > SETUP_FILE_MAX_BYTES) return { ok: false, status: 413, error: "That file is over 1 MB, too big to show here." };
    return { ok: true, file: { path: file, text: readFileSync(file, "utf8") } };
  } catch {
    return { ok: false, status: 404, error: "That file can't be read any more." };
  }
}

/** The folder's cached (or joined, or fresh) read. */
function folderSetup(cwd: string, sessionPath: string, opts: { fresh?: boolean }, deps: SetupDeps, now: () => number): Promise<SessionSetup> {
  const key = cwd;
  const hit = cache.get(key);
  if (!opts.fresh && hit && now() - hit.checkedAt < SETUP_TTL_MS) return Promise.resolve(hit);
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = read(cwd, sessionPath, deps, now)
    .then((setup) => {
      // A failure is never served from the cache, and neither is the answer before it: a folder
      // that was missing a moment ago may exist now.
      if (setup.state === "ok") cache.set(key, setup);
      else cache.delete(key);
      return setup;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

export type LoadoutResult = { ok: true; setup: SessionSetup } | { ok: false; status: 400 | 403 | 404 | 409; error: string; yourClick?: true };

/** Who asks for a switch: `page` is the operator's page here or a proven click from another of their
    computers' (notPageNorProven), the only caller that may turn on a row the folder keeps off. */
export interface LoadoutCaller {
  page: boolean;
}

/** The refusal for turning on, from anything but the page, a row the folder keeps off. */
export const LOADOUT_TURN_ON_REFUSAL = "Only you can turn on a context file or skill this folder keeps off: switch it on in Sova's page.";

/** One switch at a time, so two quick flips write in the order they were made. */
let applying: Promise<unknown> = Promise.resolve();

/**
 * POST /api/sessions/loadout (§chat.transcript/setup-card-toggles): write the session's whole off
 * set as its `sova-loadout` entry and rebuild its runtime, the way a profile pick does
 * (§chat.profiles/applying), then answer with the card's fresh read of the rebuilt runtime. Refused
 * with nothing written once a message is on the branch, mid-turn, TUI-live, for a foreign writer,
 * a special session or a remote one. An unchanged set writes nothing and rebuilds nothing.
 */
export function applyLoadout(path: string, body: unknown, caller: LoadoutCaller = { page: true }): Promise<LoadoutResult> {
  return inLoadoutOrder(() => applyLoadoutNow(path, body, caller));
}

/** Run `fn` in the switches' one order (a card's switch, a project's skills change rebuilding new chats). */
export function inLoadoutOrder<T>(fn: () => Promise<T>): Promise<T> {
  const run = applying.then(fn);
  applying = run.catch(() => undefined);
  return run;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

async function applyLoadoutNow(path: string, body: unknown, caller: LoadoutCaller): Promise<LoadoutResult> {
  const b = (body ?? {}) as { offContext?: unknown; offSkills?: unknown; offMcp?: unknown; onMcp?: unknown };
  const data = normalizeLoadout({ v: 1, offContext: b.offContext, offSkills: b.offSkills, offMcp: b.offMcp, onMcp: b.onMcp });
  if (!data) return { ok: false, status: 400, error: "Expected {path, offContext: absolute paths, offSkills: skill names}" };
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  if (s.overseer || s.projectOverseer || s.baton || s.org || s.workerSession) return { ok: false, status: 409, error: "This session's context files and skills can't be switched." };
  if (s.live) return { ok: false, status: 409, error: `It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.` };
  const stored = await readStoredCwd(path).catch(() => null);
  let local = false;
  try {
    local = stored !== null && plan(stored).kind === "local";
  } catch {
    local = false;
  }
  if (!local) return { ok: false, status: 409, error: "Only a local session's context files and skills can be switched here." };
  let chat;
  try {
    chat = await acquireChatHandle(path);
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  // The card sends the whole off set it shows, of the rows it lists: the runtime's unfiltered lists. Before
  // the first message that set is the folder's decisions with this chat's flips, so the entry keeps only the
  // flips (flipsAgainstProject), and a later decision still reaches the chat until it starts.
  const res = await chat.resources().catch(() => null);
  const listedContext = (res?.context ?? []).map((f) => f.path);
  const listedSkills = (res?.skills ?? []).map((k) => ({ name: k.name, filePath: k.filePath }));
  // The card names a skill by its name or its SKILL.md; the entry keeps the file (a skill of the same name
  // from another place is another skill). A name it doesn't list is never switched.
  const fileOf = (n: string) => (n.startsWith("/") ? listedSkills.find((k) => k.filePath === n) : listedSkills.find((k) => k.name === n))?.filePath;
  const wanted = { ...data, offSkills: [...new Set(data.offSkills.map(fileOf).filter((p): p is string => !!p))] };
  const current = chat.mirror.loadout?.off ?? null;
  const offNow = {
    context: listedContext.filter((p) => isContextOff(current, p)),
    skills: listedSkills.filter((k) => isSkillOff(current, k)).map((k) => k.filePath),
  };
  const unchanged =
    sameSet(offNow.context, data.offContext.filter((p) => listedContext.includes(p))) &&
    sameSet(offNow.skills, wanted.offSkills) &&
    sameSet(current?.offMcp ?? [], data.offMcp ?? []) &&
    sameSet(current?.onMcp ?? [], data.onMcp ?? []);
  if (!unchanged) {
    // What the folder keeps off for this chat with no flips of its own.
    const kept = pristineLoadout(null, stored !== null ? await ruleFor(stored) : null);
    const keptOff = { context: listedContext.filter((p) => isContextOff(kept, p)), skills: listedSkills.filter((k) => isSkillOff(kept, k)).map((k) => k.filePath) };
    const next = flipsAgainstProject(wanted, keptOff, { context: new Set(listedContext), skills: new Set(listedSkills.map((k) => k.filePath)) });
    // Turning on what the folder keeps off is the page's alone: otherwise a chat could approve itself.
    const had = await readBranch(path)
      .then((branch) => stateView(branch).latest(LOADOUT)?.data ?? null)
      .catch(() => null);
    const newlyOn = [...(next.onContext ?? []).filter((p) => !had?.onContext?.includes(p)), ...(next.onSkills ?? []).filter((n) => !had?.onSkills?.includes(n))];
    if (newlyOn.length && !caller.page) return { ok: false, status: 403, error: LOADOUT_TURN_ON_REFUSAL, yourClick: true };
    try {
      await chat.writeLoadout(next);
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
    await closeChat(path, "Applying the context files and skills.");
    // Reopened here, so the answer is the rebuilt runtime's own read; a tab reconnecting meanwhile
    // joins this same open.
    await acquireChatHandle(path).catch((err) => console.warn(`[setup] reopen after a switch failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return { ok: true, setup: await getSessionSetup(path, { fresh: true }) };
}
