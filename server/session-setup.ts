// What pi will LOAD for a session's folder: the context files it writes into the prompt, and the
// skills it offers this session, each with its size on disk. GET /api/sessions/context
// (shared/protocol.ts SessionSetup), rendered in the empty state of a session with no messages yet.
//
// Two sources, one shape:
//
//  - **the open chat's own loader** (`heldChat(path).harness.resources()`) when this server
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
// rules, they move with pi, and a second copy would drift; both sources above are pi's own code.
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

import { existsSync, readFileSync } from "node:fs";
import type { HarnessResources } from "../shared/harness";
import { CHARS_PER_TOKEN, type SessionSetup, type SessionSetupFile, type SessionSetupSkill } from "../shared/protocol";
import { acquireChat, assertNotLive, disposeHeldChat, heldChat } from "./chat-manager";
import { plan, readStoredCwd, type Plan } from "./git-summary";
import { leavesOut, normalizeLoadout, type LoadoutEntryData } from "./session-loadout";
import { getSessionSummary } from "./sessions-index";
import { agentRoot } from "./state-root";
import { readBranch } from "./harness/pi/reader";
import { folderResources } from "./harness/pi/resources";
import { LOADOUT } from "./harness/state-kinds";
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
function runtimeLoadout(sessionPath: string): Loadout | null {
  const chat = heldChat(sessionPath);
  if (!chat) return null;
  const loadout = chat.harness.resources();
  const base = chat.loadoutState;
  return {
    ...loadout,
    ...(base?.baseContext ? { context: base.baseContext.map((path) => ({ path })) } : {}),
    ...(base?.baseSkills ? { skills: base.baseSkills } : {}),
  };
}

/** What one session switches off, and whether its card may switch rows now. Worked out per session
    on every read; never part of the folder's cached answer. */
export interface SessionSwitches {
  off: LoadoutEntryData | null;
  toggleable: boolean;
}

/** The held chat's own entry and window; else the newest entry in the file, read by Sova's own
    parser, except for a TUI-live session (the TUI doesn't honour the entry). */
async function sessionSwitches(sessionPath: string): Promise<SessionSwitches> {
  const chat = heldChat(sessionPath);
  if (chat) return { off: chat.loadoutState?.data ?? null, toggleable: chat.loadoutToggleable };
  try {
    assertNotLive(sessionPath);
    return { off: stateView(await readBranch(sessionPath)).latest(LOADOUT)?.data ?? null, toggleable: false };
  } catch {
    return { off: null, toggleable: false };
  }
}

type Loaded = Extract<SessionSetup, { state: "ok" }>;

/** The folder's answer as one session sees it: its off rows marked, and whether it can switch them.
    A new object: the cached answer is never changed. */
export function withSwitches(setup: Loaded, sw: SessionSwitches): Loaded {
  const offContext = new Set(sw.off?.offContext ?? []);
  const offSkills = new Set(sw.off?.offSkills ?? []);
  return {
    ...setup,
    context: setup.context.map(({ off: _o, ...f }) => (offContext.has(f.path) ? { ...f, off: true as const } : f)),
    skills: setup.skills.map(({ off: _o, ...k }) => (offSkills.has(k.name) ? { ...k, off: true as const } : k)),
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
  /** The loadout of an OPEN chat, or null when nothing holds it (default: heldChat). */
  runtime?: (sessionPath: string) => Loadout | null;
  /** pi's own read for a folder (default: folderResources, pi's loader without extensions). */
  loader?: (cwd: string) => Promise<Loadout>;
  /** One session's off set and switch window (default: the held chat, else the file's entry). */
  switches?: (sessionPath: string) => SessionSwitches | Promise<SessionSwitches>;
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
    if (size) out.push({ name: skill.name, path: skill.filePath, ...(description ? { description } : {}), ...size });
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
    loadout = (deps.runtime ?? runtimeLoadout)(sessionPath);
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
  if (p.kind === "remote") return { state: "remote", where: { kind: "remote", target: p.target }, cwd: p.place.cwd, checkedAt: now() };

  const folder = await folderSetup(p.place.cwd, sessionPath, opts, deps, now);
  if (folder.state !== "ok") return folder;
  let sw: SessionSwitches;
  try {
    sw = await (deps.switches ?? sessionSwitches)(sessionPath);
  } catch {
    sw = { off: null, toggleable: false };
  }
  return withSwitches(folder, sw);
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

export type LoadoutResult = { ok: true; setup: SessionSetup } | { ok: false; status: 400 | 404 | 409; error: string };

/** One switch at a time, so two quick flips write in the order they were made. */
let applying: Promise<unknown> = Promise.resolve();

/**
 * POST /api/sessions/loadout (§chat.transcript/setup-card-toggles): write the session's whole off
 * set as its `sova-loadout` entry and rebuild its runtime, the way a profile pick does
 * (§chat.profiles/applying), then answer with the card's fresh read of the rebuilt runtime. Refused
 * with nothing written once a message is on the branch, mid-turn, TUI-live, for a foreign writer,
 * a special session or a remote one. An unchanged set writes nothing and rebuilds nothing.
 */
export function applyLoadout(path: string, body: unknown): Promise<LoadoutResult> {
  const run = applying.then(() => applyLoadoutNow(path, body));
  applying = run.catch(() => undefined);
  return run;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

async function applyLoadoutNow(path: string, body: unknown): Promise<LoadoutResult> {
  const b = (body ?? {}) as { offContext?: unknown; offSkills?: unknown };
  const data = normalizeLoadout({ v: 1, offContext: b.offContext, offSkills: b.offSkills });
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
    chat = await acquireChat(path);
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  const current = chat.loadoutState?.data;
  const unchanged = leavesOut(current) ? sameSet(current.offContext, data.offContext) && sameSet(current.offSkills, data.offSkills) : !leavesOut(data);
  if (!unchanged) {
    try {
      chat.writeLoadout(data);
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
    await disposeHeldChat(path, "Applying the context files and skills.");
    // Reopened here, so the answer is the rebuilt runtime's own read; a tab reconnecting meanwhile
    // joins this same open.
    await acquireChat(path).catch((err) => console.warn(`[setup] reopen after a switch failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return { ok: true, setup: await getSessionSetup(path, { fresh: true }) };
}
