// The Transport agent (§app.transport/agent), on the destination: before the package is pulled, the
// project's setup checks run here mechanically (preflight); with nothing missing the transport goes
// on at once and no agent starts. Otherwise a Sova chat "Transport: {title}" starts here on the
// strongest model this device offers (or the one the dialog chose), linked to the chat on the source
// (§mesh/links) so it reports there, briefed with exactly what the checks found missing. Each time
// its turn ends the checks run again: all green, the project is recorded as prepared on this device
// and the transport carries on; still missing, the transport waits as Needs you until a Retry.
// A later transport of the same project here finds it prepared and its checks green, and skips the
// agent. After arrival, private files still holding the source computer's paths are handed to the
// agent to point at this one. Everything that reaches the rest of the server goes through
// AgentDeps; server/transport/agent-wire.ts gives the live ones.
//
// Trust: prepareDestination and afterArrival act (make folders, start a chat with install rights), so
// only arrival code that has verified the transport's ticket calls them (§mesh.peers/transport-ticket);
// needsAnswer only reads (git and, for a folder with a definition, its doctor). All three refuse a
// folder outside the user's home or inside Sova's own folders, and never repeat a remote's credentials.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ONBOARD_THINKING, onboardModels } from "../projects/onboard";
import { agentArrivedMissing, agentBrief, agentPrivateValues, agentStillMissing } from "./agent-prompt";
import { type AgentScope, agentScope, MADE_TOOL_DIRS, preparedFile } from "./agent-scope";
import { lacksRepo, projectComesFrom, withoutCredentials } from "./git-snapshot";
import type { SetupDef } from "./setup-def";

/** One setup check's finding, as doctor gives them (§app.project-services/doctor). */
export interface AgentCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** The project as the source knows it: how to get it, and where it goes here. */
export interface ProjectRef {
  /** Its remotes' URLs (fetch), first the one its branch tracks. */
  remotes: string[];
  /** Its root commit: the identity that survives a renamed remote. */
  firstCommit?: string;
  /** Its folder on this device. */
  path: string;
}

/** What arrival asks of the destination before it pulls (transport-core's setPrepareDestination). */
export interface PrepareRequest {
  tid: string;
  /** The source device: its peer id here (a link member's host), and its name. */
  sourcePeer: string;
  sourceLabel?: string;
  sourceChatId: string;
  title: string;
  project: ProjectRef;
  /** Each tree that travels, the chat's own first: its branch ("" when detached) and, when the offer names it, its commit. */
  worktrees: { name: string; branch: string; head?: string }[];
  /** The model the dialog chose; absent: the strongest this device can run. */
  model?: string;
  /** The source chat's own model: the last fallback when this device runs neither Claude Code nor gpt-6-astra. */
  chatModel?: string;
  /** The project comes in the package (this device lacks it and can't clone it): no agent clones it, and the setup
      checks run once it has arrived. */
  fromSource?: boolean;
  /** The chat's worktrees' folders on this device (absolute): writable for the agent once they are there. */
  trees?: string[];
}
export type PrepareResult = { ready: true } | { needsYou: string };

/** A transport's agent, as its transport record keeps it (`ext.agent`). */
export interface AgentState {
  sessionId: string;
  path: string;
  title: string;
  model: string;
  /** The device it works on (its card in the chat names it). */
  device?: string;
  /** The link to the chat on the source, or why there is none. */
  linkId?: string;
  linkError?: string;
  state: "working" | "ready" | "needs-you";
  /** The checks' last findings. */
  checks: AgentCheck[];
  startedAt: number;
}

export interface AgentDeps {
  stateRoot(): string;
  /** The user's home here: a project's folder is inside it. */
  home(): string;
  /** Folders a project's folder is never in: Sova's state root, the agent dir, the chat homes. */
  protectedRoots(): string[];
  /** This device's name, for the brief. */
  device(): string;
  /** Whether a program is reachable for the user's commands here. */
  /** Which of `programs` are reachable for the user's commands here (never blocking the server). */
  which(programs: string[]): Promise<Set<string>>;
  git(args: string[], cwd: string): Promise<{ code: number; stdout: string }>;
  /** Whether this device can read a remote now, asking no one (git-snapshot's remoteReachable); absent: taken as reachable. */
  reachable?(url: string): Promise<boolean>;
  /** The project's own doctor checks (§app.project-services/doctor) on a folder with a definition; null: none ran. */
  doctor(folder: string): Promise<AgentCheck[] | null>;
  /** The names of the host values this device holds for the project at `folder` (its host overlay); read only. */
  hostValues?(folder: string): Set<string>;
  /** The model refs this device's picker lists; null: unreadable. */
  offeredModels(): Promise<string[] | null>;
  /** Whether this device has a Claude login Claude Code can run on now. */
  claudeUsable(): boolean;
  /** Folders hidden from the agent besides the sandbox policy's own: this device's host values (host.json), the
      transport records, the chat homes and the other projects registered here. */
  agentHidden(): Promise<string[]>;
  /** Whether Sova's sandbox can confine a chat to `scope` on this device (its backend probes that very scope): null
      when it can, else why not. Nothing starts unconfined. */
  confine(scope: AgentScope): Promise<string | null>;
  /** Start the agent's chat here, linked-member kind, with its title, model and first prompt, its tools confined to
      `scope` from its first call (recorded for transport `tid` before the chat first opens). */
  startChat(input: { cwd: string; title: string; prompt: string; model: string; thinking: string; tid: string; scope: AgentScope }): Promise<{ id: string; path: string }>;
  /** Link the agent's chat to the chat on the source. */
  link(agentSessionId: string, sourcePeer: string, sourceChatId: string): Promise<{ linkId: string } | { error: string }>;
  /** End the agent's link to the chat on the source: its preparing is done, so no report can bounce between them. */
  endLink?(linkId: string): Promise<void>;
  /** Hand the agent's chat a message (a follow-up when it is busy). */
  tell(path: string, text: string): Promise<void>;
  /** Whether the agent's chat runs a turn now. */
  busy(path: string): boolean;
  /** The transport record heard of its agent (its `ext.agent`, for the transport's view); absent: nobody listens. */
  onAgent?(tid: string, a: AgentState): void;
  /** After arrival, the agent couldn't start or take the chat's worktrees (no confinement here): its card says why. */
  onBlocked?(tid: string, reason: string): void;
  /** Close an idle agent's chat so its next open takes its new scope. */
  reopen?(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Its thinking level: the setup chats' (medium). High made glm-5.3 think minutes before its first step. */
export const AGENT_THINKING = ONBOARD_THINKING;
/** How often a working agent's chat is looked at. */
export const AGENT_POLL_MS = 3_000;
/** A turn that hasn't shown as running this long after a message is taken as ended. */
export const AGENT_START_GRACE_MS = 30_000;

// ---- the checks ---------------------------------------------------------------------------------

/** What a project's files say it needs here: programs and an installed-dependencies folder. Pure. */
export function projectNeeds(has: (file: string) => boolean): { programs: string[]; deps: { dir: string; how: string }[] } {
  const programs: string[] = [];
  const deps: { dir: string; how: string }[] = [];
  const need = (...p: string[]) => {
    for (const x of p) if (!programs.includes(x)) programs.push(x);
  };
  if (has("mise.toml") || has(".mise.toml") || has(".tool-versions")) need("mise");
  if (has("package.json")) {
    need("node");
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : has("package-lock.json") ? "npm" : null;
    if (pm) need(pm);
    deps.push({ dir: "node_modules", how: pm ? `${pm} install` : "install the JavaScript dependencies" });
  }
  if (has("Cargo.toml")) need("cargo");
  if (has("go.mod")) need("go");
  if (has("deps.edn")) need("clojure");
  if (has("project.clj")) need("lein");
  if (has("bb.edn")) need("bb");
  if (has("Gemfile")) need("bundle");
  if (has("pyproject.toml") || has("requirements.txt")) need("python3");
  if (has("mix.exs")) need("mix");
  if (has("pom.xml")) need("mvn");
  return { programs, deps };
}

const normRemote = (u: string): string =>
  u
    .trim()
    .replace(/\.git$/, "")
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, "")
    .replace(/^[^@/]+@([^:/]+):/, "$1/")
    .replace(/:\d+\//, "/")
    .toLowerCase();

/** Whether two remote URLs name the same repository (ssh and https forms alike). Pure. */
export const sameRemote = (a: string, b: string): boolean => normRemote(a) === normRemote(b);

/** A remote URL without the credentials it may carry (`https://user:token@host/…` → `https://host/…`;
    an ssh URL keeps its user, never a password): what a brief, a check or an answer may say. Pure. */
export const cleanRemote = withoutCredentials;

/** The project as the destination acts on it: its remotes without credentials, and `~/…` (the source's
    spelling of "under that device's home") as a folder under `home`. Pure. */
const cleanProject = (p: ProjectRef, home?: string): ProjectRef => ({
  ...p,
  remotes: p.remotes.map(cleanRemote),
  ...(home && (p.path === "~" || p.path.startsWith("~/")) ? { path: join(home, p.path.slice(2)) } : {}),
});

const within = (child: string, parent: string): boolean => {
  const c = resolve(child);
  const r = resolve(parent);
  return c === r || c.startsWith(r.endsWith("/") ? r : `${r}/`);
};

/** `p` with its nearest existing ancestor's symlinks resolved, the rest as named: where a folder made there would really be. */
function canonical(p: string): string {
  let at = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(p);
      rest.push(basename(at));
      at = up;
    }
  }
}

/** Why this device refuses a project folder the source named, or null: it is absolute, inside the
    user's home, and in none of Sova's own folders, each read through its symlinks. */
export function folderRefusal(path: string, home: string, protectedRoots: readonly string[]): string | null {
  if (!path || !path.startsWith("/")) return `The folder on this device must be an absolute path, not "${path}"`;
  const real = canonical(path);
  const h = canonical(home);
  if (!within(real, h) || real === h) return `${path} isn't a folder inside your home on this device`;
  if (protectedRoots.some((r) => r && (within(real, canonical(r)) || within(canonical(r), real)))) return `${path} is one of Sova's own folders on this device`;
  return null;
}

/**
 * The project's setup checks on this device, mechanically, before any agent: the folder (there, a
 * repository, this project's), each program its files name, its installed dependencies, and its own
 * doctor when it has a definition. A missing folder stops the rest: there is nothing to read yet.
 */
export async function preflight(asked: ProjectRef, deps: Pick<AgentDeps, "which" | "git" | "doctor">): Promise<AgentCheck[]> {
  const project = cleanProject(asked);
  const path = resolve(project.path);
  const where = project.remotes[0] ?? "its repository";
  if (!existsSync(path)) return [{ id: "folder", ok: false, detail: `${path} doesn't exist: clone ${where} there` }];
  let dir = false;
  try {
    dir = statSync(path).isDirectory();
  } catch {
    dir = false;
  }
  if (!dir) return [{ id: "folder", ok: false, detail: `${path} is a file, not a folder: ask the user before touching it` }];
  // An empty folder (the agent's own workspace, made before it starts) holds nothing yet: the project is cloned into it.
  if (isEmptyDir(path)) return [{ id: "folder", ok: false, detail: `${path} is empty: clone ${where} into it` }];
  const top = await deps.git(["rev-parse", "--show-toplevel"], path).catch(() => ({ code: 1, stdout: "" }));
  if (top.code !== 0) return [{ id: "folder", ok: false, detail: `${path} exists but isn't a Git repository: ask the user before changing anything in it` }];
  const checks: AgentCheck[] = [];
  const ours = await sameProject(path, project, deps);
  checks.push(ours ? { id: "folder", ok: true, detail: `${path} holds the project` } : { id: "folder", ok: false, detail: `${path} holds another repository: ask the user where this project goes` });
  if (!ours) return checks;
  const has = (f: string) => existsSync(join(path, f));
  const needs = projectNeeds(has);
  const found = needs.programs.length ? await deps.which(needs.programs) : new Set<string>();
  for (const p of needs.programs) checks.push({ id: `tool:${p}`, ok: found.has(p), detail: found.has(p) ? `${p} found` : `${p} isn't installed for this user` });
  for (const d of needs.deps) checks.push({ id: `deps:${d.dir}`, ok: has(d.dir), detail: has(d.dir) ? `${d.dir} installed` : `${d.dir} is missing: ${d.how}` });
  if (has(".sova/project.json")) {
    const doc = await deps.doctor(path).catch(() => null);
    if (doc) for (const c of doc) checks.push({ id: `doctor:${c.id}`, ok: c.ok, detail: c.detail });
  }
  return checks;
}

/** Whether the repository at `path` is this project: its root commit is there, or a remote matches. */
async function sameProject(path: string, project: ProjectRef, deps: Pick<AgentDeps, "git">): Promise<boolean> {
  if (project.firstCommit) {
    const r = await deps.git(["cat-file", "-e", `${project.firstCommit}^{commit}`], path).catch(() => ({ code: 1, stdout: "" }));
    if (r.code === 0) return true;
  }
  // With nothing to know the project by, a repository there is somebody else's until the user says.
  if (!project.remotes.length) return false;
  const r = await deps.git(["remote", "-v"], path).catch(() => ({ code: 1, stdout: "" }));
  const urls = r.stdout.split("\n").map((l) => l.split(/\s+/)[1] ?? "").filter(Boolean);
  return urls.some((u) => project.remotes.some((x) => sameRemote(u, x)));
}

const missingOf = (checks: AgentCheck[]) => checks.filter((c) => !c.ok);

const isEmptyDir = (p: string): boolean => {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
};

/** A doctor finding about a host value (the definition's `host` names, in this device's host.json): never the
    agent's to fix. The user is asked for each on the Transport card (§app.transport/agent "This computer's host values"). */
export const isHostCheck = (c: AgentCheck): boolean => c.id.startsWith("doctor:host:");
/** What the agent is there for: every failing check but the host values. */
export const agentMissing = (checks: AgentCheck[]): AgentCheck[] => missingOf(checks).filter((c) => !isHostCheck(c));
/** The checks the agent is shown: the host values are the user's, so they are left out. */
const forAgent = (checks: AgentCheck[]): AgentCheck[] => checks.filter((c) => !isHostCheck(c));

// ---- prepared once per device -------------------------------------------------------------------

interface PreparedFile {
  v: 1;
  /** By project key: where it was proven, and when. */
  projects: Record<string, { path: string; at: number; tid: string }>;
  /** The agents' chats, by session id: what refuses transporting one (§app.transport/start), and the scope its
      tools are confined to (agent-scope.ts agentLaunchFlags reads it at each open). */
  agents: Record<string, { tid: string; at: number; scope?: AgentScope }>;
  /** Each transport's agent, by transport id. */
  byTransport?: Record<string, AgentState>;
}

/** `<stateRoot>/transport-agent.json`: beside the transport records' folder, never in it (agent-scope.ts names it). */
export { preparedFile };

/** A project's identity on this device: its root commit, else its first remote, else its folder. Pure. */
export const projectKey = (p: ProjectRef): string =>
  p.firstCommit ? `commit:${p.firstCommit}` : p.remotes[0] ? `remote:${normRemote(p.remotes[0])}` : `path:${createHash("sha256").update(resolve(p.path)).digest("hex").slice(0, 16)}`;

function readPrepared(root: string): PreparedFile {
  try {
    const j = JSON.parse(readFileSync(preparedFile(root), "utf8")) as PreparedFile;
    if (j?.v === 1 && j.projects && j.agents) return j;
  } catch {
    // none yet, or unreadable: start over (it only saves a later check)
  }
  return { v: 1, projects: {}, agents: {} };
}

function writePrepared(root: string, f: PreparedFile): void {
  mkdirSync(root, { recursive: true });
  const file = preparedFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** When this device proved the project ready, at that folder; null: never. */
export function preparedAt(root: string, p: ProjectRef): number | null {
  const hit = readPrepared(root).projects[projectKey(p)];
  return hit && resolve(hit.path) === resolve(p.path) ? hit.at : null;
}

function markPrepared(root: string, p: ProjectRef, tid: string, at: number): void {
  const f = readPrepared(root);
  f.projects[projectKey(p)] = { path: resolve(p.path), at, tid };
  writePrepared(root, f);
}

/** Record session `sessionId` as transport `tid`'s agent, keeping the scope it was confined to (or recording `scope`). */
export function markAgent(root: string, sessionId: string, tid: string, at: number, scope?: AgentScope): void {
  const f = readPrepared(root);
  const was = f.agents[sessionId];
  f.agents[sessionId] = { tid, at: was?.at ?? at, ...((scope ?? was?.scope) ? { scope: scope ?? was!.scope } : {}) };
  writePrepared(root, f);
}

/** Transport `tid`'s agent on this device, if one started. */
export const agentOf = (root: string, tid: string): AgentState | null => readPrepared(root).byTransport?.[tid] ?? null;

function saveAgent(deps: Pick<AgentDeps, "stateRoot" | "onAgent">, tid: string, a: AgentState): void {
  const root = deps.stateRoot();
  const f = readPrepared(root);
  (f.byTransport ??= {})[tid] = a;
  const was = f.agents[a.sessionId];
  f.agents[a.sessionId] = { tid, at: a.startedAt, ...(was?.scope ? { scope: was.scope } : {}) };
  writePrepared(root, f);
  try {
    deps.onAgent?.(tid, a);
  } catch {
    // the transport's view only
  }
}

/** Whether session `sessionId` is a Transport agent's chat: a transport refuses it (§app.transport/start). */
export const isTransportAgent = (root: string, sessionId: string): boolean => !!readPrepared(root).agents[sessionId];

// ---- the model ----------------------------------------------------------------------------------

/** What the model rule knows of this device besides its picker's list. */
export interface ModelFacts {
  /** This device has a Claude login Claude Code can run on now (signed in, enabled, not limited or leaving). */
  claudeUsable: boolean;
  /** The source chat's own model, the last fallback. */
  chatModel?: string;
}

/** The strongest model this device can actually run, in order (§app.transport/agent "Its model"): Claude Code's
    current Opus only with a usable Claude login here, else gpt-6-astra, else the source chat's own model; each only
    when this device's picker lists it. Null: none of them. Pure. */
export function strongestRunnable(offered: readonly string[] | null, facts: ModelFacts): string | null {
  const list = offered ?? [];
  const [opus, astra] = onboardModels();
  const order = [...(facts.claudeUsable ? [opus!] : []), astra!, ...(facts.chatModel ? [facts.chatModel] : [])];
  return order.find((m) => list.includes(m)) ?? null;
}

/** The agent's model: the dialog's pick, else strongestRunnable. The dialog lists only this device's own choices
    (needsAnswer's models), so its pick is taken as given. Null: no pick and nothing runnable. */
export const agentModel = (asked: string | undefined, offered: readonly string[] | null, facts: ModelFacts) => {
  const pick = asked?.trim() || strongestRunnable(offered, facts);
  return pick ? { model: pick, thinking: AGENT_THINKING } : null;
};

/** What the dialog's Model select lists for this device (the default first, then the rest it offers) and its default. Pure. */
export function agentModelChoices(offered: readonly string[] | null, facts: ModelFacts): { models: string[]; default: string | null } {
  const list = offered ?? [];
  const def = strongestRunnable(list, facts);
  return { models: def ? [def, ...list.filter((m) => m !== def)] : [...list], default: def };
}

// ---- what the dialog shows -----------------------------------------------------------------------

export interface NeedsAnswer {
  /** That device still needs: one line per failing check; empty when ready. */
  needs: string[];
  models: string[];
  modelDefault: string | null;
  /** When this device last proved the project ready there. */
  preparedAt: number | null;
  /** This device lacks the repository and can't clone it (no remote recorded, or none reachable from here): the
      project comes from the source, so its folder isn't listed as needed. */
  fromSource?: boolean;
  /** With the project from the source: what its own setup definition says this device still lacks, set up once it
      has arrived (one line each). */
  afterArrival?: string[];
}

/**
 * What a project's own setup definition (as the source read it) says this device lacks, before the project is here:
 * the programs it and its files name that aren't found for the user, the dependencies it installs (they never travel),
 * and the host values this device doesn't hold for it. Read only: it looks programs up and reads the host overlay,
 * and never runs a project command.
 */
export async function setupLacks(def: SetupDef, folder: string, deps: Pick<AgentDeps, "which" | "hostValues">): Promise<string[]> {
  const needs = projectNeeds((f) => def.files.includes(f));
  const programs = [...new Set([...needs.programs, ...def.programs])];
  const found = programs.length ? await deps.which(programs) : new Set<string>();
  const held = deps.hostValues?.(folder) ?? new Set<string>();
  return [
    ...programs.filter((p) => !found.has(p)).map((p) => `${p} isn't installed for this user`),
    ...needs.deps.map((d) => `${d.dir} is missing: ${d.how}`),
    ...def.host.filter((h) => !held.has(h)).map((h) => `host value ${h} isn't set on this device`),
  ];
}

/** The answer to the source's "what does this device still need for this project" (the peer route). Read only. */
export async function needsAnswer(asked: ProjectRef, deps: AgentDeps, opts: { chatModel?: string; setup?: SetupDef | null } = {}): Promise<NeedsAnswer> {
  const project = cleanProject(asked, deps.home());
  const refused = folderRefusal(project.path, deps.home(), deps.protectedRoots());
  const fromSource = !refused && lacksRepo(resolve(project.path)) && (await projectComesFrom(resolve(project.path), project.remotes, deps.reachable ?? (async () => true))) === "from-source";
  const [checks, offered, after] = await Promise.all([
    refused ? [{ id: "folder", ok: false, detail: refused }] : fromSource ? [] : preflight(project, deps),
    deps.offeredModels(),
    fromSource && opts.setup ? setupLacks(opts.setup, resolve(project.path), deps) : Promise.resolve([] as string[]),
  ]);
  const m = agentModelChoices(offered, { claudeUsable: deps.claudeUsable(), ...(opts.chatModel ? { chatModel: opts.chatModel } : {}) });
  return {
    needs: missingOf(checks).map((c) => c.detail),
    models: m.models,
    modelDefault: m.default,
    preparedAt: preparedAt(deps.stateRoot(), project),
    ...(fromSource ? { fromSource: true } : {}),
    ...(after.length ? { afterArrival: after } : {}),
  };
}

// ---- the prepare -------------------------------------------------------------------------------

const deviceNeeds = (device: string, n: number, title: string) =>
  `${device} still needs ${n === 1 ? "1 thing" : `${n} things`} the Transport agent couldn't finish. Open "${title}" on ${device} to answer it, then press Retry`;

/**
 * Get this device ready for the transport `req` (arrival awaits it before the first pull). The
 * checks first: green, the project is recorded as prepared and nothing starts. Otherwise the agent
 * (started once per transport; a Retry finds it again, re-checks and nudges it) works until a turn of
 * its ends with every check green. `signal` (a Cancel) stops the wait; the agent's chat stays.
 */
export async function prepareDestination(asked: PrepareRequest, deps: AgentDeps, opts: { signal?: AbortSignal } = {}): Promise<PrepareResult> {
  const req = { ...asked, project: cleanProject(asked.project, deps.home()) };
  const refused = folderRefusal(req.project.path, deps.home(), deps.protectedRoots());
  if (refused) return { needsYou: refused };
  const root = deps.stateRoot();
  if (req.fromSource) {
    // The project comes in the package: nothing here is cloned, and an agent that tried stops reporting over its link.
    // What remains (tools, dependencies, setup, this computer's values) is checked once it has arrived (afterArrival).
    const a = agentOf(root, req.tid);
    if (a && a.state !== "ready") {
      if (a.linkId) await deps.endLink?.(a.linkId).catch(() => undefined);
      saveAgent(deps, req.tid, { ...a, state: "ready", checks: [] });
    }
    return { ready: true };
  }
  // A host value it lacks never holds the transport here: the user is asked for it on the Transport card once it arrives.
  let checks = forAgent(await preflight(req.project, deps));
  if (!agentMissing(checks).length) {
    markPrepared(root, req.project, req.tid, deps.now());
    const a = agentOf(deps.stateRoot(), req.tid);
    if (a && a.state !== "ready") {
      if (a.linkId) await deps.endLink?.(a.linkId).catch(() => undefined);
      saveAgent(deps, req.tid, { ...a, state: "ready", checks });
    }
    return { ready: true };
  }
  let agent = agentOf(deps.stateRoot(), req.tid);
  if (!agent) {
    const started = await startAgent(req, checks, deps);
    if ("needsYou" in started) return started;
    agent = started;
  } else if (!deps.busy(agent.path)) {
    // A Retry: what is still missing goes to the agent it already has.
    await deps.tell(agent.path, agentStillMissing(checks));
    agent = { ...agent, state: "working", checks };
    saveAgent(deps, req.tid, agent);
  }
  checks = forAgent(await waitForTurnEnd(agent.path, req.project, deps, opts.signal));
  if (!agentMissing(checks).length) {
    markPrepared(root, req.project, req.tid, deps.now());
    if (agent.linkId) await deps.endLink?.(agent.linkId).catch(() => undefined);
    saveAgent(deps, req.tid, { ...agent, state: "ready", checks });
    return { ready: true };
  }
  saveAgent(deps, req.tid, { ...agent, state: "needs-you", checks });
  return { needsYou: deviceNeeds(deps.device(), agentMissing(checks).length, agent.title) };
}

/** Why the agent can't be confined on this device: it never starts then, and the transport waits as Needs you. */
export const unconfinedRefusal = (device: string, why: string) => `${device} can't confine the Transport agent to the project's folders (${why}), so it didn't start. Set up Sova's sandbox there, then press Retry`;

/** Start the transport's agent: its chat here, on its model, briefed with `checks`, linked to the chat on the source,
    its tools confined from their first call to the project's folder, the chat's worktrees and the tool folders installs
    fill (agent-scope.ts). When this device can't confine it, nothing starts. */
async function startAgent(req: PrepareRequest, checks: AgentCheck[], deps: AgentDeps, arrived = false): Promise<AgentState | { needsYou: string }> {
  const root = deps.stateRoot();
  const title = `Transport: ${req.title}`;
  const choice = agentModel(req.model, await deps.offeredModels(), { claudeUsable: deps.claudeUsable(), ...(req.chatModel ? { chatModel: req.chatModel } : {}) });
  if (!choice) return { needsYou: `${deps.device()} offers no model for the Transport agent: pick one in the dialog` };
  // Its workspace is the project's folder, made empty when it isn't there yet (it clones into it), and the tool
  // folders a first install needs: a confined write lands only in a folder that exists.
  const folder = resolve(req.project.path);
  const made = !existsSync(folder);
  mkdirSync(folder, { recursive: true });
  for (const d of MADE_TOOL_DIRS) mkdirSync(join(deps.home(), d), { recursive: true });
  const scope = agentScope({ folder, trees: req.trees ?? [], home: deps.home(), hidden: await deps.agentHidden() });
  const unconfined = await deps.confine(scope).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (unconfined) {
    if (made && isEmptyDir(folder)) rmdirSync(folder);
    return { needsYou: unconfinedRefusal(deps.device(), unconfined) };
  }
  const shown = forAgent(checks);
  const prompt = agentBrief({
    title: req.title,
    device: deps.device(),
    source: req.sourceLabel ?? req.sourcePeer,
    folder,
    remotes: req.project.remotes,
    branches: req.worktrees.map((w) => w.branch).filter(Boolean),
    ...(req.worktrees[0]?.branch ? { checkout: { branch: req.worktrees[0].branch, ...(req.worktrees[0].head ? { head: req.worktrees[0].head } : {}) } } : {}),
    checks: shown,
    sovaFolders: deps.protectedRoots(),
    writable: scope.writable,
    arrived,
    ...(req.fromSource ? { arrivedProject: true } : {}),
    home: deps.home(),
  });
  const chat = await deps.startChat({ cwd: folder, title, prompt, model: choice.model, thinking: choice.thinking, tid: req.tid, scope });
  markAgent(root, chat.id, req.tid, deps.now(), scope);
  // After arrival the chat is here (a Move leaves only its Moved row there): a link joins two devices, so none is made.
  const linked: { linkId: string } | { error: string } = arrived
    ? { error: "the chat has arrived on this device" }
    : await deps.link(chat.id, req.sourcePeer, req.sourceChatId).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  const agent: AgentState = { sessionId: chat.id, path: chat.path, title, model: choice.model, device: deps.device(), ...("linkId" in linked ? { linkId: linked.linkId } : { linkError: linked.error }), state: "working", checks: shown, startedAt: deps.now() };
  saveAgent(deps, req.tid, agent);
  return agent;
}

/** Wait until the agent's turn ends (it ran, or never showed as running within the grace), then check again. */
async function waitForTurnEnd(path: string, project: ProjectRef, deps: AgentDeps, signal?: AbortSignal): Promise<AgentCheck[]> {
  await turnEnded(path, deps, signal);
  return preflight(project, deps);
}

/** Resolves once the agent's turn has ended: it ran, or never showed as running within the grace. */
async function turnEnded(path: string, deps: Pick<AgentDeps, "busy" | "sleep" | "now">, signal?: AbortSignal): Promise<void> {
  const from = deps.now();
  let ran = false;
  for (;;) {
    signal?.throwIfAborted();
    if (deps.busy(path)) ran = true;
    else if (ran || deps.now() - from > AGENT_START_GRACE_MS) return;
    await deps.sleep(AGENT_POLL_MS);
  }
}

// ---- after arrival ------------------------------------------------------------------------------

/** What an agent is setting up, by short names (its checks' programs, dependency folders, host values and files), for
    the transport's done line. Pure. */
export function settingUpNames(checks: readonly AgentCheck[]): string[] {
  const name = (c: AgentCheck): string => {
    if (c.id.startsWith("private:")) return basename(c.id.slice("private:".length));
    const m = /^(?:tool|deps|doctor:program|doctor:host|doctor:data):(.+)$/.exec(c.id);
    return m ? m[1]! : c.id.replace(/^doctor:/, "");
  };
  return [...new Set(checks.filter((c) => !c.ok).map(name))];
}

/** Read at most this much of a private file when looking for the source computer's values. */
const SCAN_BYTES = 256 * 1024;

/** Which of `values` (the source computer's home and folders) each private file still holds. Pure but for reading the files. */
export function sourceValuesIn(files: readonly string[], values: readonly string[]): { file: string; found: string[] }[] {
  const wanted = values.filter((v) => v.length > 1);
  const out: { file: string; found: string[] }[] = [];
  for (const file of files) {
    let text: string;
    try {
      const buf = readFileSync(file);
      if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) continue; // binary
      text = buf.subarray(0, SCAN_BYTES).toString("utf8");
    } catch {
      continue;
    }
    // Longest first, so a folder under the home isn't also reported as the home.
    const found: string[] = [];
    let rest = text;
    for (const v of [...wanted].sort((a, b) => b.length - a.length))
      if (rest.includes(v)) {
        found.push(v);
        rest = rest.split(v).join("");
      }
    if (found.length) out.push({ file, found });
  }
  return out;
}

/**
 * The chat has arrived here: the private files it carried that still hold the source computer's
 * paths go to the transport's agent to point at this one, started now when the device was already
 * prepared and none ran. When the project came with the chat (`fromSource`), its setup checks run
 * now too, and what they find missing (tools, dependencies, its doctor) goes to the agent with them;
 * all green, the project is recorded as prepared. Nothing missing: nothing is sent. Returns the files
 * handed over. `onStarted` hears what the agent was handed once it has it (before its turn ends): the
 * transport says the setup is under way.
 */
export async function afterArrival(asked: PrepareRequest & { privateFiles: string[]; sourceValues: string[] }, deps: AgentDeps, opts: { onStarted?(checks: AgentCheck[]): void } = {}): Promise<string[]> {
  const req = { ...asked, project: cleanProject(asked.project, deps.home()) };
  if (folderRefusal(req.project.path, deps.home(), deps.protectedRoots())) return [];
  const hits = sourceValuesIn(req.privateFiles, req.sourceValues);
  const setup = req.fromSource ? agentMissing(await preflight(req.project, deps)) : [];
  if (req.fromSource && !setup.length) markPrepared(deps.stateRoot(), req.project, req.tid, deps.now());
  if (!hits.length && !setup.length) return [];
  const source = req.sourceLabel ?? req.sourcePeer;
  const checksOf = (found: typeof hits): AgentCheck[] =>
    found.map((h) => ({ id: `private:${h.file}`, ok: false, detail: `${h.file} still holds ${source}'s ${h.found.join(", ")}: point it at this computer` }));
  let agent = agentOf(deps.stateRoot(), req.tid);
  if (agent) {
    // It started before the chat's worktrees were here: its next open confines it to them too (a running chat keeps the
    // scope it opened with, so an idle one is closed and reopens on the message below).
    const scope = agentScope({ folder: resolve(req.project.path), trees: req.trees ?? [], home: deps.home(), hidden: await deps.agentHidden() });
    const was = readPrepared(deps.stateRoot()).agents[agent.sessionId]?.scope;
    if (!was || scope.writable.some((w) => !was.writable.includes(w))) {
      const unconfined = await deps.confine(scope).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (unconfined) {
        deps.onBlocked?.(req.tid, unconfinedRefusal(deps.device(), unconfined));
        return [];
      }
      markAgent(deps.stateRoot(), agent.sessionId, req.tid, deps.now(), scope);
      if (!deps.busy(agent.path)) await deps.reopen?.(agent.path).catch(() => undefined);
    }
    await deps.tell(agent.path, [...(setup.length ? [agentArrivedMissing(source, setup)] : []), ...(hits.length ? [agentPrivateValues(source, hits)] : [])].join("\n\n"));
    agent = { ...agent, state: "working", checks: [...setup, ...checksOf(hits)] };
    saveAgent(deps, req.tid, agent);
  } else {
    const started = await startAgent(req, [...setup, ...checksOf(hits)], deps, true);
    if ("needsYou" in started) {
      // After arrival there is no transport step to hold: its card in the arrived chat says why nothing started.
      deps.onBlocked?.(req.tid, started.needsYou);
      return [];
    }
    agent = started;
  }
  opts.onStarted?.(agent.checks);
  // Its turn ends: the checks and files are read again, and what it left is the transport's to show (ready, or Needs you).
  await turnEnded(agent.path, deps);
  const left = sourceValuesIn(req.privateFiles, req.sourceValues);
  const stillSetup = setup.length ? agentMissing(await preflight(req.project, deps)) : [];
  if (setup.length && !stillSetup.length) markPrepared(deps.stateRoot(), req.project, req.tid, deps.now());
  const done = !left.length && !stillSetup.length;
  saveAgent(deps, req.tid, { ...agent, state: done ? "ready" : "needs-you", checks: [...stillSetup, ...(left.length ? checksOf(left) : hits.map((h) => ({ id: `private:${h.file}`, ok: true, detail: `${h.file} points at this computer` })))] });
  return hits.map((h) => h.file);
}
