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
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { onboardModel, onboardModels } from "../projects/onboard";
import { agentBrief, agentPrivateValues, agentStillMissing } from "./agent-prompt";

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
  worktrees: { name: string; branch: string }[];
  /** The model the dialog chose; absent: the strongest this device offers. */
  model?: string;
}
export type PrepareResult = { ready: true } | { needsYou: string };

/** A transport's agent, as its transport record keeps it (`ext.agent`). */
export interface AgentState {
  sessionId: string;
  path: string;
  title: string;
  model: string;
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
  which(program: string): boolean;
  git(args: string[], cwd: string): Promise<{ code: number; stdout: string }>;
  /** The project's own doctor checks (§app.project-services/doctor) on a folder with a definition; null: none ran. */
  doctor(folder: string): Promise<AgentCheck[] | null>;
  /** The model refs this device's picker lists; null: unreadable. */
  offeredModels(): Promise<string[] | null>;
  /** Start the agent's chat here, linked-member kind, with its title, model and first prompt. */
  startChat(input: { cwd: string; title: string; prompt: string; model: string; thinking: string }): Promise<{ id: string; path: string }>;
  /** Link the agent's chat to the chat on the source. */
  link(agentSessionId: string, sourcePeer: string, sourceChatId: string): Promise<{ linkId: string } | { error: string }>;
  /** Hand the agent's chat a message (a follow-up when it is busy). */
  tell(path: string, text: string): Promise<void>;
  /** Whether the agent's chat runs a turn now. */
  busy(path: string): boolean;
  /** The transport record heard of its agent (its `ext.agent`, for the transport's view); absent: nobody listens. */
  onAgent?(tid: string, a: AgentState): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const AGENT_THINKING = "high";
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
export const cleanRemote = (u: string): string =>
  u.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]*)@/i, (_m, scheme: string, who: string) => (/^ssh/i.test(scheme) && who && !who.includes(":") ? `${scheme}${who}@` : scheme));

/** The project as the destination acts on it: its remotes without credentials. Pure. */
const cleanProject = (p: ProjectRef): ProjectRef => ({ ...p, remotes: p.remotes.map(cleanRemote) });

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
  const top = await deps.git(["rev-parse", "--show-toplevel"], path).catch(() => ({ code: 1, stdout: "" }));
  if (top.code !== 0) return [{ id: "folder", ok: false, detail: `${path} exists but isn't a Git repository: ask the user before changing anything in it` }];
  const checks: AgentCheck[] = [];
  const ours = await sameProject(path, project, deps);
  checks.push(ours ? { id: "folder", ok: true, detail: `${path} holds the project` } : { id: "folder", ok: false, detail: `${path} holds another repository: ask the user where this project goes` });
  if (!ours) return checks;
  const has = (f: string) => existsSync(join(path, f));
  const needs = projectNeeds(has);
  for (const p of needs.programs) checks.push({ id: `tool:${p}`, ok: deps.which(p), detail: deps.which(p) ? `${p} found` : `${p} isn't installed for this user` });
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

// ---- prepared once per device -------------------------------------------------------------------

interface PreparedFile {
  v: 1;
  /** By project key: where it was proven, and when. */
  projects: Record<string, { path: string; at: number; tid: string }>;
  /** The agents' chats, by session id: what refuses transporting one (§app.transport/start). */
  agents: Record<string, { tid: string; at: number }>;
  /** Each transport's agent, by transport id. */
  byTransport?: Record<string, AgentState>;
}

/** `<stateRoot>/transport-agent.json`: beside the transport records' folder, never in it. */
export const preparedFile = (root: string) => join(root, "transport-agent.json");

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

function markAgent(root: string, sessionId: string, tid: string, at: number): void {
  const f = readPrepared(root);
  f.agents[sessionId] = { tid, at };
  writePrepared(root, f);
}

/** Transport `tid`'s agent on this device, if one started. */
export const agentOf = (root: string, tid: string): AgentState | null => readPrepared(root).byTransport?.[tid] ?? null;

function saveAgent(deps: Pick<AgentDeps, "stateRoot" | "onAgent">, tid: string, a: AgentState): void {
  const root = deps.stateRoot();
  const f = readPrepared(root);
  (f.byTransport ??= {})[tid] = a;
  f.agents[a.sessionId] = { tid, at: a.startedAt };
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

/** The agent's model: the dialog's pick, else the strongest this device offers, as for setup chats
    (Claude Code's current Opus, then gpt-6-astra); null when it offers neither. The dialog lists only
    this device's own choices (needsAnswer's models), so its pick is taken as given. */
export const agentModel = (asked: string | undefined, offered: readonly string[] | null) => {
  const c = onboardModel({ model: asked ?? null, thinking: AGENT_THINKING }, offered);
  return c ? { model: c.model, thinking: AGENT_THINKING } : null;
};

/** What the dialog's Model select lists for this device: the strongest first, then the rest it offers. Pure. */
export function agentModelChoices(offered: readonly string[] | null): { models: string[]; default: string | null } {
  const list = offered ?? [];
  const strong = onboardModels().filter((m) => list.includes(m));
  return { models: [...strong, ...list.filter((m) => !strong.includes(m))], default: strong[0] ?? null };
}

// ---- what the dialog shows -----------------------------------------------------------------------

export interface NeedsAnswer {
  /** That device still needs: one line per failing check; empty when ready. */
  needs: string[];
  models: string[];
  modelDefault: string | null;
  /** When this device last proved the project ready there. */
  preparedAt: number | null;
}

/** The answer to the source's "what does this device still need for this project" (the peer route). */
export async function needsAnswer(asked: ProjectRef, deps: AgentDeps): Promise<NeedsAnswer> {
  const project = cleanProject(asked);
  const refused = folderRefusal(project.path, deps.home(), deps.protectedRoots());
  const [checks, offered] = await Promise.all([refused ? [{ id: "folder", ok: false, detail: refused }] : preflight(project, deps), deps.offeredModels()]);
  const m = agentModelChoices(offered);
  return { needs: missingOf(checks).map((c) => c.detail), models: m.models, modelDefault: m.default, preparedAt: preparedAt(deps.stateRoot(), project) };
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
  const req = { ...asked, project: cleanProject(asked.project) };
  const refused = folderRefusal(req.project.path, deps.home(), deps.protectedRoots());
  if (refused) return { needsYou: refused };
  const root = deps.stateRoot();
  let checks = await preflight(req.project, deps);
  if (!missingOf(checks).length) {
    markPrepared(root, req.project, req.tid, deps.now());
    const a = agentOf(deps.stateRoot(), req.tid);
    if (a && a.state !== "ready") saveAgent(deps, req.tid, { ...a, state: "ready", checks });
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
  checks = await waitForTurnEnd(agent.path, req.project, deps, opts.signal);
  if (!missingOf(checks).length) {
    markPrepared(root, req.project, req.tid, deps.now());
    saveAgent(deps, req.tid, { ...agent, state: "ready", checks });
    return { ready: true };
  }
  saveAgent(deps, req.tid, { ...agent, state: "needs-you", checks });
  return { needsYou: deviceNeeds(deps.device(), missingOf(checks).length, agent.title) };
}

/** Start the transport's agent: its chat here, on its model, briefed with `checks`, linked to the chat on the source. */
async function startAgent(req: PrepareRequest, checks: AgentCheck[], deps: AgentDeps): Promise<AgentState | { needsYou: string }> {
  const root = deps.stateRoot();
  const title = `Transport: ${req.title}`;
  const choice = agentModel(req.model, await deps.offeredModels());
  if (!choice) return { needsYou: `${deps.device()} offers no model for the Transport agent: pick one in the dialog` };
  // Its folder may not exist yet: it works from the nearest folder that does, made inside the user's account.
  const cwd = existsSync(req.project.path) ? resolve(req.project.path) : dirname(resolve(req.project.path));
  mkdirSync(cwd, { recursive: true });
  const prompt = agentBrief({
    title: req.title,
    device: deps.device(),
    source: req.sourceLabel ?? req.sourcePeer,
    folder: resolve(req.project.path),
    remotes: req.project.remotes,
    branches: req.worktrees.map((w) => w.branch),
    checks,
  });
  const made = await deps.startChat({ cwd, title, prompt, model: choice.model, thinking: choice.thinking });
  markAgent(root, made.id, req.tid, deps.now());
  const linked = await deps.link(made.id, req.sourcePeer, req.sourceChatId).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  const agent: AgentState = { sessionId: made.id, path: made.path, title, model: choice.model, ...("linkId" in linked ? { linkId: linked.linkId } : { linkError: linked.error }), state: "working", checks, startedAt: deps.now() };
  saveAgent(deps, req.tid, agent);
  return agent;
}

/** Wait until the agent's turn ends (it ran, or never showed as running within the grace), then check again. */
async function waitForTurnEnd(path: string, project: ProjectRef, deps: AgentDeps, signal?: AbortSignal): Promise<AgentCheck[]> {
  const from = deps.now();
  let ran = false;
  for (;;) {
    signal?.throwIfAborted();
    const busy = deps.busy(path);
    if (busy) ran = true;
    else if (ran || deps.now() - from > AGENT_START_GRACE_MS) return preflight(project, deps);
    await deps.sleep(AGENT_POLL_MS);
  }
}

// ---- after arrival ------------------------------------------------------------------------------

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
 * prepared and none ran. None hold any: nothing is sent. Returns the files handed over.
 */
export async function afterArrival(asked: PrepareRequest & { privateFiles: string[]; sourceValues: string[] }, deps: AgentDeps): Promise<string[]> {
  const req = { ...asked, project: cleanProject(asked.project) };
  if (folderRefusal(req.project.path, deps.home(), deps.protectedRoots())) return [];
  const hits = sourceValuesIn(req.privateFiles, req.sourceValues);
  if (!hits.length) return [];
  const source = req.sourceLabel ?? req.sourcePeer;
  const agent = agentOf(deps.stateRoot(), req.tid);
  if (agent) {
    await deps.tell(agent.path, agentPrivateValues(source, hits));
    saveAgent(deps, req.tid, { ...agent, state: "working" });
  } else {
    const checks = hits.map((h) => ({ id: `private:${h.file}`, ok: false, detail: `${h.file} still holds ${source}'s ${h.found.join(", ")}: point it at this computer` }));
    const started = await startAgent(req, checks, deps);
    if ("needsYou" in started) return [];
  }
  return hits.map((h) => h.file);
}
