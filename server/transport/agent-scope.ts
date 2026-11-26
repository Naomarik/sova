// Where the Transport agent's tools may reach (§app.transport/agent "Confined"): Sova's own sandbox, given a scope
// the way a sandboxed parent hands one to its workers (the sandbox extension's `--sandbox-parent`). It writes only
// in the project's folder, the chat's worktrees and the tool folders installs fill in the user's home; the caches
// installs use (~/.cache, ~/.npm, ~/.m2) and mise's and pnpm's state stay the sandbox's own private copies, as for
// every confined chat. Hidden from it besides the policy's own list: this device's host values (host.json), the
// transport records that carry the source's, the chat homes and the other projects registered here.
// Node builtins only: server/chat-manager.ts reads the launch flags from here.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The scope, in the sandbox extension's ParentScope shape (pi-config/extensions/sandbox/policy.ts). */
export interface AgentScope {
  version: 1;
  level: "workspace-write";
  workspaceRoot: string;
  writable: string[];
  hidden?: string[];
  /** The sites its network reaches, once you allowed a download list (§app.transport/agent "Downloads, on your click"):
      what it reached before plus exactly the hosts allowed. Absent: the policy's own allowlist. */
  proxyAllow?: string[];
}

/** The tool folders under the user's home an install fills (version managers, toolchains, user programs, git deps, the
    Clojure CLI's own config folder in either of its places), writable when they exist. The caches and mise's and
    pnpm's state are the sandbox's private copies already; mise writes nothing of its own under ~/.config for an
    install, so that stays read-only. */
export const TOOL_DIRS = [".local/share/mise", ".local/bin", ".gitlibs", ".cargo", ".rustup", "go", ".bun", ".deno", ".volta", ".asdf", ".clojure", ".config/clojure"] as const;
/** Made when missing, so a first install has somewhere to go: mise's installs and the user's own bin folder. */
export const MADE_TOOL_DIRS = [".local/share/mise", ".local/bin"] as const;

/** The Clojure CLI's config folder for the user (CLJ_CONFIG's default, which its first run fills with deps.edn and
    tools/): `$XDG_CONFIG_HOME/clojure` when that is set, else `~/.clojure`. Pure. */
export const clojureConfigDir = (home: string, xdgConfigHome?: string): string => (xdgConfigHome?.startsWith("/") ? join(xdgConfigHome, "clojure") : join(home, ".clojure"));

/** The tool folders made when missing before the agent's scope is read (absolute): MADE_TOOL_DIRS, and the Clojure CLI's
    config folder when the project runs the CLI (a deps.edn) and that folder is one of TOOL_DIRS. Pure. */
export function toolDirsToMake(home: string, projectHas: (file: string) => boolean, xdgConfigHome?: string): string[] {
  const out = MADE_TOOL_DIRS.map((d) => join(home, d));
  const clj = clojureConfigDir(home, xdgConfigHome);
  if (projectHas("deps.edn") && TOOL_DIRS.some((d) => resolve(join(home, d)) === resolve(clj))) out.push(clj);
  return out;
}

const within = (child: string, parent: string): boolean => {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
};

/**
 * The agent's scope. Writable: `folder` (the project's), each of `trees` (the chat's worktrees here) that exists,
 * and each tool folder of TOOL_DIRS under `home` that exists. Hidden: each of `hidden` that exists and neither holds
 * nor lies inside a writable root (a project registered at a folder above this one stays readable). Pure but for
 * `exists`.
 */
export function agentScope(input: { folder: string; trees?: readonly string[]; home: string; hidden?: readonly string[]; exists?: (p: string) => boolean }): AgentScope {
  const exists = input.exists ?? existsSync;
  const folder = resolve(input.folder);
  const writable = [...new Set([folder, ...(input.trees ?? []).map((t) => resolve(t)).filter(exists), ...TOOL_DIRS.map((d) => join(input.home, d)).filter(exists)])];
  const hidden = [...new Set((input.hidden ?? []).filter(Boolean).map((h) => resolve(h)))].filter((h) => exists(h) && !writable.some((w) => within(w, h) || within(h, w)));
  return { version: 1, level: "workspace-write", workspaceRoot: folder, writable, ...(hidden.length ? { hidden } : {}) };
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
