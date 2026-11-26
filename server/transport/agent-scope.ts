// Where the Transport agent's tools may reach (§app.transport/agent "Confined"): Sova's own sandbox, given a scope
// the way a sandboxed parent hands one to its workers (the sandbox extension's `--sandbox-parent`). It writes only
// in the project's folder, the chat's worktrees and the install and cache folders of the user's tools, never a folder
// on the user's PATH, a file a shell profile sources or a version already installed; the caches
// installs use (~/.cache, ~/.npm, ~/.m2) and mise's and pnpm's state stay the sandbox's own private copies, as for
// every confined chat. Hidden from it besides the policy's own list: this device's host values (host.json), the
// transport records that carry the source's, the chat homes and the other projects registered here.
// Node builtins only: server/chat-manager.ts reads the launch flags from here.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The scope, in the sandbox extension's ParentScope shape (pi-config/extensions/sandbox/policy.ts). */
export interface AgentScope {
  version: 1;
  level: "workspace-write";
  workspaceRoot: string;
  writable: string[];
  /** Read-only inside the writable folders: the PATH's folders in the tool folders. */
  readOnly?: string[];
  hidden?: string[];
  /** The sites its network reaches, once you allowed a download list (§app.transport/agent "Downloads, on your click"):
      what it reached before plus exactly the hosts allowed. Absent: the policy's own allowlist. */
  proxyAllow?: string[];
}

/**
 * How each tool folder under the user's home is opened to the agent: only its install and cache subfolders are writable,
 * never the folder itself, so nothing at its top can be written or made (a file a shell profile sources, such as
 * ~/.bun/_bun, ~/.cargo/env or ~/.asdf/asdf.sh, its bin or shim folder, its settings). `open`: writable whole (downloads,
 * caches, registries). `versions`: writable for a new entry, but each entry already there (a version, a plugin, a
 * toolchain, an image) read-only whole, `depth` levels below: a version the agent installs is a new folder it may write,
 * one the user already runs isn't. A file is never a writable root (the sandbox's writable roots are folders), so a tool's
 * lock file at its folder's top (cargo's .package-cache) stays read-only: cargo goes on without it there. Nothing on the
 * user's PATH is writable (~/.local/bin is no tool folder, and ~/.deno holds only its bin); putting a program there is
 * asked on the agent's card (transport_setup `path`). The caches in ~/.cache and mise's and pnpm's state are the
 * sandbox's private copies already.
 */
export interface ToolLayout {
  dir: string;
  open?: readonly string[];
  versions?: readonly { path: string; depth: number }[];
}
export const TOOL_LAYOUTS: readonly ToolLayout[] = [
  { dir: ".local/share/mise", open: ["downloads"], versions: [{ path: "installs", depth: 2 }, { path: "plugins", depth: 1 }] },
  { dir: ".asdf", open: ["downloads", "tmp"], versions: [{ path: "installs", depth: 2 }, { path: "plugins", depth: 1 }] },
  { dir: ".cargo", open: ["registry", "git"] },
  { dir: ".rustup", open: ["downloads", "tmp", "update-hashes"], versions: [{ path: "toolchains", depth: 1 }] },
  { dir: "go", open: ["pkg"] },
  { dir: ".bun", open: ["install/cache"] },
  { dir: ".volta", open: ["cache", "tmp", "log", "tools/inventory"], versions: [{ path: "tools/image", depth: 2 }] },
  { dir: ".gitlibs", open: ["_repos", "libs"] },
  // The Clojure CLI's config folder: its first run fills it (deps.edn, tools/); what is there already stays as it is.
  { dir: ".clojure", versions: [{ path: "", depth: 1 }] },
  { dir: ".config/clojure", versions: [{ path: "", depth: 1 }] },
];
/** The tool folders, relative to the home. */
export const TOOL_DIRS = TOOL_LAYOUTS.map((l) => l.dir);

/** Made when missing, so a first install has somewhere to go: mise's folder. */
export const MADE_TOOL_DIRS = [".local/share/mise"] as const;

/** The Clojure CLI's config folder for the user (CLJ_CONFIG's default, which its first run fills with deps.edn and
    tools/): `$XDG_CONFIG_HOME/clojure` when that is set, else `~/.clojure`. Pure. */
export const clojureConfigDir = (home: string, xdgConfigHome?: string): string => (xdgConfigHome?.startsWith("/") ? join(xdgConfigHome, "clojure") : join(home, ".clojure"));

/** A layout's writable subfolders (absolute): its open and versions paths. */
const openPaths = (home: string, l: ToolLayout): string[] => [...(l.open ?? []), ...(l.versions ?? []).map((v) => v.path)].map((p) => join(home, l.dir, p));

/** The folders made before the agent's scope is read (absolute): MADE_TOOL_DIRS, the Clojure CLI's config folder when
    the project runs the CLI (a deps.edn) and that folder is one of TOOL_DIRS, and each writable subfolder of every tool
    folder there (or made now), so an install writes into one. Pure but for `exists`. */
export function toolDirsToMake(home: string, projectHas: (file: string) => boolean, xdgConfigHome?: string, exists: (p: string) => boolean = existsSync): string[] {
  const made: string[] = MADE_TOOL_DIRS.map((d) => join(home, d));
  const clj = clojureConfigDir(home, xdgConfigHome);
  if (projectHas("deps.edn") && TOOL_DIRS.some((d) => resolve(join(home, d)) === resolve(clj))) made.push(clj);
  const there = TOOL_LAYOUTS.filter((l) => made.includes(join(home, l.dir)) || exists(join(home, l.dir)));
  return [...new Set([...made, ...there.flatMap((l) => openPaths(home, l))])];
}

/** The PATH's folders (absolute ones only), from a PATH string. Pure. */
export const pathDirsOf = (path: string | undefined): string[] => (path ?? "").split(":").filter((d) => d.startsWith("/")).map((d) => resolve(d));

type Kind = "dir" | "file" | "link" | "missing";
const kindOf = (p: string): Kind => {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
};

/** A folder's entries, none when it can't be listed. */
const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const within = (child: string, parent: string): boolean => {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
};

/**
 * The agent's scope. Writable: `folder` (the project's), each of `trees` (the chat's worktrees here) that exists, and
 * the install and cache subfolders of each tool folder under `home` (TOOL_LAYOUTS) that exist.
 * Read-only inside those: every entry already at a `versions` folder's last depth (a link is passed over: it names an
 * entry, and the entry it names is held where it is; a file on the way down is the manager's own record, left
 * writable), and each folder of `pathDirs` (the user's PATH) in one. Hidden: each of `hidden`
 * that exists and neither holds nor lies inside a writable root (a project registered at a folder above this one stays
 * readable). Pure but for `exists`, `list` and `kind`.
 */
export function agentScope(input: { folder: string; trees?: readonly string[]; home: string; hidden?: readonly string[]; pathDirs?: readonly string[]; exists?: (p: string) => boolean; list?: (dir: string) => string[]; kind?: (p: string) => Kind }): AgentScope {
  const exists = input.exists ?? existsSync;
  const list = input.list ?? listDir;
  const kind = input.kind ?? kindOf;
  const folder = resolve(input.folder);
  const tools = TOOL_LAYOUTS.filter((l) => exists(join(input.home, l.dir)));
  const toolRoots = tools.flatMap((l) => openPaths(input.home, l)).filter(exists);
  const writable = [...new Set([folder, ...(input.trees ?? []).map((t) => resolve(t)).filter(exists), ...toolRoots])];
  const held: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const name of list(dir).sort()) {
      const p = join(dir, name);
      const k = kind(p);
      if (k === "link" || k === "missing") continue;
      // Only the entries at the last depth are held: a file on the way down (mise's installs/.mise-installs.toml, which
      // it rewrites at each install) is a manager's own record, which nothing runs.
      if (depth <= 1) held.push(p);
      else if (k === "dir") walk(p, depth - 1);
    }
  };
  for (const l of tools) for (const v of l.versions ?? []) walk(join(input.home, l.dir, v.path), v.depth);
  const inTool = (p: string) => toolRoots.some((t) => within(p, t));
  const readOnly = [...new Set([...held, ...(input.pathDirs ?? []).map((d) => resolve(d))])].filter(inTool);
  const hidden = [...new Set((input.hidden ?? []).filter(Boolean).map((h) => resolve(h)))].filter((h) => exists(h) && !writable.some((w) => within(w, h) || within(h, w)));
  return { version: 1, level: "workspace-write", workspaceRoot: folder, writable, ...(readOnly.length ? { readOnly } : {}), ...(hidden.length ? { hidden } : {}) };
}

/** `<stateRoot>/transport-agent.json`: the agents' records (server/transport/agent.ts keeps them). */
export const preparedFile = (root: string) => join(root, "transport-agent.json");

/** A Transport agent's own mark, kept with its chat: `<home>/chat/transport-agent.json` in the chat's home, written
    with the device's record and never read or written by the agent itself (the homes are hidden from its tools). It
    keeps the chat an agent's, confined, when the device's record is gone or can't be read. */
export const AGENT_MARK = join("chat", "transport-agent.json");

/** What a Transport agent's chat is recorded as, in the device's record or its own mark. */
export interface AgentMark {
  v: 1;
  tid: string;
  at: number;
  scope?: AgentScope;
}

/** The home of the chat `sessionId` from its session file (`<home>/sessions/<file>`, the home named for the chat and
    holding its home.json), or null: no home (a chat from before homes, or with the Chat homes switch off). */
export function agentHomeOf(sessionId: string, sessionPath?: string): string | null {
  if (!sessionPath) return null;
  const dir = dirname(resolve(sessionPath));
  if (basename(dir) !== "sessions") return null;
  const home = dirname(dir);
  return basename(home) === sessionId && existsSync(join(home, "home.json")) ? home : null;
}

type Reading = { kind: "none" } | { kind: "unreadable"; why: string } | { kind: "ok"; value: unknown };

/** A JSON file: none when it isn't there, unreadable when it is but can't be read or parsed. */
function readJson(file: string): Reading {
  try {
    return { kind: "ok", value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "none" } : { kind: "unreadable", why: e instanceof Error ? e.message : String(e) };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The device's record of the agents' chats: none, unreadable (there but not a record this code reads), or each agent
    chat's entry by session id. */
export function readAgentRecords(root: string): { kind: "none" } | { kind: "unreadable"; why: string } | { kind: "ok"; agents: Record<string, unknown> } {
  const r = readJson(preparedFile(root));
  if (r.kind !== "ok") return r;
  const v = r.value;
  if (!isObj(v) || v.v !== 1 || !isObj(v.agents) || !isObj(v.projects)) return { kind: "unreadable", why: "not a record of this version" };
  return { kind: "ok", agents: v.agents };
}

const validScope = (s: unknown): AgentScope | null =>
  isObj(s) && s.version === 1 && Array.isArray(s.writable) && s.writable.every((w) => typeof w === "string") && typeof s.workspaceRoot === "string" ? (s as unknown as AgentScope) : null;

/** Write the chat's own mark into its home, replacing it whole (a rename), only when it changed. */
export function writeAgentMark(home: string, mark: AgentMark): void {
  const file = join(home, AGENT_MARK);
  const text = `${JSON.stringify(mark, null, 2)}\n`;
  try {
    if (readFileSync(file, "utf8") === text) return;
  } catch {
    // none yet
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Whether a transport record here names `sessionId` as its agent (routes.ts keeps `ext.agent.sessionId`): the last
    word on a chat without a mark of its own when the device's record can't be read. */
function namedByTransport(root: string, sessionId: string): boolean {
  const dir = join(root, "transport");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const r = readJson(join(dir, n));
    if (r.kind === "ok" && isObj(r.value) && isObj(r.value.ext) && isObj(r.value.ext.agent) && r.value.ext.agent.sessionId === sessionId) return true;
  }
  return false;
}

/** What the chat `sessionId` (its session file at `sessionPath`) stands as: null, not a Transport agent's chat; else its
    transport (null when no readable record names it) and its scope (null when none can be read: it is then held
    read-only). Any record saying it is an agent's makes it one: its own mark in its home (an unreadable one counts),
    the device's record, or, when that can't be read or is gone, a transport record naming it. */
export const agentStanding = (root: string, sessionId: string, sessionPath?: string): AgentStanding | null => agentStandingAt(root, sessionId, agentHomeOf(sessionId, sessionPath));

export interface AgentStanding {
  tid: string | null;
  scope: AgentScope | null;
}

/** agentStanding with the chat's home given (null: none). */
export function agentStandingAt(root: string, sessionId: string, home: string | null): AgentStanding | null {
  const mark = home ? readJson(join(home, AGENT_MARK)) : ({ kind: "none" } as const);
  const own = mark.kind === "ok" && isObj(mark.value) && typeof mark.value.tid === "string" ? mark.value : null;
  const file = readAgentRecords(root);
  const rec = file.kind === "ok" && isObj(file.agents[sessionId]) ? (file.agents[sessionId] as Record<string, unknown>) : null;
  const named = !!own || !!rec || mark.kind === "unreadable" || (mark.kind === "ok" && !own) || (file.kind !== "ok" && namedByTransport(root, sessionId));
  if (!named) return null;
  if (file.kind === "unreadable") console.warn(`[transport] ${preparedFile(root)} can't be read (${file.why}): ${sessionId} is held as a Transport agent's chat from its other records`);
  const tid = typeof own?.tid === "string" ? own.tid : typeof rec?.tid === "string" ? rec.tid : null;
  return { tid, scope: validScope(own?.scope) ?? validScope(rec?.scope) };
}

/** The transport whose agent chat `sessionId` is, or null: not a Transport agent's chat here, or none can be read. */
export const agentTidOf = (root: string, sessionId: string, sessionPath?: string): string | null => agentStanding(root, sessionId, sessionPath)?.tid ?? null;

/** The open flags of a Transport agent's chat (server/chat-manager.ts): its sandbox On with its scope, which the
    chat can't lower. A chat any record names as an agent's whose scope can't be read (its records unreadable, gone or
    without one) is held at the read-only level with its folder never writable: it never runs unconfined. Null: not a
    Transport agent's chat. */
export function agentLaunchFlags(root: string, sessionId: string, sessionPath?: string): { sandboxOn: true; extra: Record<string, string> } | { sandboxOn: true; sandboxReadOnly: true; cwdNotWritable: true } | null {
  const s = agentStanding(root, sessionId, sessionPath);
  if (!s) return null;
  if (!s.scope) return { sandboxOn: true, sandboxReadOnly: true, cwdNotWritable: true };
  return { sandboxOn: true, extra: { "sandbox-parent": JSON.stringify(s.scope) } };
}
