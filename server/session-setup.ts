// What pi will LOAD for a session's folder: the context files it writes into the prompt, and the
// skills it offers this session, each with its size on disk. GET /api/sessions/context
// (shared/protocol.ts SessionSetup), rendered in the empty state of a session with no messages yet
// (spec/03-transcript.md §3).
//
// Two sources, one shape:
//
//  - **the open chat's own loader** (`heldChat(path).session.resourceLoader`) when this server
//    holds the session: the exact set that session prompts with, extension-added skill paths
//    included, and free — the runtime has already read every one of those files to build its
//    prompt;
//  - **pi's own loader without extensions** (`DefaultResourceLoader({ noExtensions: true })`), for
//    a session nobody holds (an empty file a TUI owns, read through /ws/watch). That is a LOWER
//    BOUND: a skill path an extension registers at session_start is invisible to it, which is what
//    `fromRuntime` reports.
//
// Nothing here re-implements pi's discovery — not the candidate context filenames, not the worktree
// shadowing rule, not the settings-registered skill folders or the npm package ones. Those are pi's
// rules, they move with pi, and a second copy would drift; both sources above are pi's own code.
//
// WHICH FOLDER is the other thing that must not be answered twice: `readStoredCwd` and `plan` come
// from git-summary, so the remote classification, the removed-sshfs-mount refusal and the rename
// bridge (state-root rebase, then path-map.json) are the same ones the Git section applies. A
// remote session's cwd is a LOCAL PLACEHOLDER — reading it would describe Sova's own disk — so the
// answer is `state: "remote"` and the client shows the repository alone (which does read the
// target).
//
// Sizes are measured on disk, never taken from the loader's own strings: one rule for both sources,
// and a file that changed since the runtime read it reports what is there now. Never a cap: pi
// reads each of these files in full to build the prompt, so the read that decides a size is a read
// pi has already done.

import { existsSync, readFileSync } from "node:fs";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionSetup, SessionSetupFile, SessionSetupSkill } from "../shared/protocol";
import { heldChat } from "./chat-manager";
import { plan, readStoredCwd, type Plan } from "./git-summary";

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

/** A file's size on disk. null when it can't be read at all — gone since the caller listed it, a
    directory, a permission bit: the row is dropped rather than reported as an empty file. */
export function measureFile(path: string): { bytes: number; lines: number } | null {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  return { bytes: buf.length, lines: countLines(buf) };
}

/** What a loader found, whichever loader it was. Only paths: the contents are pi's business. */
export interface Loadout {
  context: readonly { path: string }[];
  skills: readonly { name: string; filePath: string; description?: string }[];
  systemPrompt?: string;
  appendSystemPrompt: readonly string[];
}

/** The four loader reads this needs, structurally — the SDK's `ResourceLoader` and
    `DefaultResourceLoader` both satisfy it. */
type Loader = Pick<DefaultResourceLoader, "getAgentsFiles" | "getSkills" | "getSystemPromptSource" | "getAppendSystemPromptSources">;

function loadoutOf(loader: Loader): Loadout {
  return {
    context: loader.getAgentsFiles().agentsFiles.map((f) => ({ path: f.path })),
    skills: loader.getSkills().skills.map((s) => ({ name: s.name, filePath: s.filePath, description: s.description })),
    systemPrompt: loader.getSystemPromptSource()?.path,
    appendSystemPrompt: loader.getAppendSystemPromptSources().map((s) => s.path),
  };
}

/** The loadout of the chat this server holds, or null when it holds none. */
function runtimeLoadout(sessionPath: string): Loadout | null {
  const chat = heldChat(sessionPath);
  return chat ? loadoutOf(chat.session.resourceLoader) : null;
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
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true });
  await loader.reload();
  return loadoutOf(loader);
}

/** Injectable seams; every one has the real default. Tests swap them, callers never pass them. */
export interface SetupDeps {
  /** The session header's cwd (default: git-summary's reader). */
  storedCwd?: (sessionPath: string) => Promise<string | null>;
  /** The loadout of an OPEN chat, or null when nothing holds it (default: heldChat). */
  runtime?: (sessionPath: string) => Loadout | null;
  /** pi's own read for a folder (default: DefaultResourceLoader, noExtensions). */
  loader?: (cwd: string) => Promise<Loadout>;
  /** Stored cwd → the folder a local read happens in (default: targets.mappedNewCwd). */
  mapCwd?: (cwd: string) => string;
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

const cache = new Map<string, Extract<SessionSetup, { state: "ok" }>>();
const inflight = new Map<string, Promise<SessionSetup>>();

/** Test seam: forget every cached read. */
export function clearSetupCache(): void {
  cache.clear();
}

/** One folder's answer. Never throws: a loader that blew up is a `reason` in words. */
async function read(cwd: string, moved: boolean, sessionPath: string, deps: SetupDeps, now: () => number): Promise<SessionSetup> {
  const base = { where: { kind: "local" } as const, cwd, ...(moved ? { moved: true as const } : {}), checkedAt: now() };
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
 * The key is the folder, not the session: two sessions in one repository share the same answer, and
 * `moved` is part of the answer so it is part of the key. No concurrency limit — the fallback read
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
    p = plan(stored, { mapCwd: deps.mapCwd });
  } catch (err) {
    return { state: "unavailable", where: { kind: "local" }, cwd: stored, reason: `Sova couldn't place this session's folder: ${(err as Error)?.message || "unknown error"}.`, checkedAt: now() };
  }
  if (p.kind === "refuse") return p.summary(now());
  if (p.kind === "remote") return { state: "remote", where: { kind: "remote", target: p.target }, cwd: p.place.cwd, checkedAt: now() };

  const key = JSON.stringify([p.place.cwd, p.place.moved ?? false]);
  const hit = cache.get(key);
  if (!opts.fresh && hit && now() - hit.checkedAt < SETUP_TTL_MS) return hit;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = read(p.place.cwd, p.place.moved === true, sessionPath, deps, now)
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
