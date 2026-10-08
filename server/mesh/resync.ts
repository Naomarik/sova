import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type MeshResync, noRecipeReason, type ResyncHost, type ResyncJob, type ResyncKind, type ResyncRelation, type ResyncSelf } from "../../shared/mesh-resync";
import { stateRoot } from "../state-root";
import { type BootBuild, bootBuild, bootBuildChecked, type Git, realGit } from "./build-id";
import { fetchPeerDetails } from "./details";
import { ownProtocol, type ProbeResult, probeHello, probePeer } from "./hello";
import type { MeshApi } from "./index";
import { PEER_ID_RE, type PeerEntry, peerUrl } from "./peers";

// Mesh version resync (§mesh.peers/resync): deploy the exact build this host booted from to a peer
// that is behind it, with the recipe this host keeps for that peer in <state root>/mesh-resync.json, else
// the one its deploy scripts' local.env implies (VPS_ID, PHONE_ID).
// A mechanical background job on the claude-accounts sign-in model: one per host, 409 while it runs,
// spawned without a shell, output capped and teed to <state root>/mesh-resync/<id>.log, a timeout;
// after the script exits the peer's hello is polled (uncached) until it speaks this host's protocol.
// Routes live under /api/mesh/, which the peer listener never serves (listener.ts), so only this
// host's own page can start one. While the mesh is off both routes are the plain 404.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHA_RE = /^[0-9a-f]{40}$/;
const TAIL_MAX = 8 * 1024;
const LOG_MAX = 2 * 1024 * 1024;
const MAX_ARGS = 32;
const MAX_ARG = 256;
/** Arguments a recipe may not carry: the commit and the source are this host's to choose. */
const RESERVED_ARGS = new Set(["--rev", "--source-url", "--ref", "--ssh", "--ssh-port"]);
const SSH_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*(@[A-Za-z0-9._:-]+)?$/;

export interface Recipe {
  kind: ResyncKind;
  /** Extra arguments: deploy.sh's for a VPS, the installer's for a phone. Never a shell string. */
  args: string[];
  /** A phone's ssh target and port (else its deploy.sh reads them from its local.env). */
  ssh?: string;
  sshPort?: number;
}

export const recipesFile = (): string => join(stateRoot(), "mesh-resync.json");
export const resyncLogDir = (): string => join(stateRoot(), "mesh-resync");

/** mesh-resync.json → recipes by peer id. A bad entry is left out with its reason; a bad file gives none. */
export function parseRecipes(raw: unknown): { recipes: Map<string, Recipe>; errors: string[] } {
  const recipes = new Map<string, Recipe>();
  const errors: string[] = [];
  const hosts = (raw as { hosts?: unknown } | null)?.hosts;
  if (typeof raw !== "object" || raw === null || typeof hosts !== "object" || hosts === null || Array.isArray(hosts)) {
    return { recipes, errors: ['mesh-resync.json must be {"hosts": {"<peer id>": {"kind": …}}}'] };
  }
  for (const [id, value] of Object.entries(hosts as Record<string, unknown>)) {
    const why = (text: string) => errors.push(`${id}: ${text}`);
    if (!PEER_ID_RE.test(id)) {
      why("not a peer id");
      continue;
    }
    const r = value as { kind?: unknown; args?: unknown; ssh?: unknown; sshPort?: unknown } | null;
    if (typeof r !== "object" || r === null || (r.kind !== "vps" && r.kind !== "termux")) {
      why('kind must be "vps" or "termux"');
      continue;
    }
    const args = r.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === "string" && a.length > 0 && a.length <= MAX_ARG && !/[\x00-\x1f\x7f]/.test(a))) {
      why(`args must be up to ${MAX_ARGS} plain strings`);
      continue;
    }
    const reserved = (args as string[]).find((a) => RESERVED_ARGS.has(a.split("=")[0]!));
    if (reserved) {
      why(`args may not set ${reserved.split("=")[0]}`);
      continue;
    }
    if (r.kind === "vps" && (r.ssh !== undefined || r.sshPort !== undefined)) {
      why("a vps recipe takes its ssh target from scripts/mesh-vps/local.env");
      continue;
    }
    if (r.ssh !== undefined && (typeof r.ssh !== "string" || !SSH_RE.test(r.ssh))) {
      why("ssh must be user@host");
      continue;
    }
    if (r.sshPort !== undefined && !(Number.isInteger(r.sshPort) && (r.sshPort as number) > 0 && (r.sshPort as number) < 65536)) {
      why("sshPort must be a port number");
      continue;
    }
    recipes.set(id, {
      kind: r.kind,
      args: args as string[],
      ...(typeof r.ssh === "string" ? { ssh: r.ssh } : {}),
      ...(typeof r.sshPort === "number" ? { sshPort: r.sshPort } : {}),
    });
  }
  return { recipes, errors };
}

/** A deploy script's local.env as plain `KEY=value` lines (an optional `export`, values optionally
    quoted, comments and blanks skipped). Never sourced or run: a line that isn't a plain assignment is skipped. */
export function parseLocalEnv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    vars.set(m[1]!, value);
  }
  return vars;
}

/** The recipes the deploy scripts' local.env files imply: VPS_ID → vps, PHONE_ID → termux (whose
    deploy.sh reads PHONE from that same file). Takes each file's text, or null when it can't be read. */
export function derivedRecipes(env: { vps: string | null; termux: string | null }): Map<string, Recipe> {
  const recipes = new Map<string, Recipe>();
  const idIn = (text: string | null, key: string) => {
    const id = text === null ? undefined : parseLocalEnv(text).get(key);
    return id && PEER_ID_RE.test(id) ? id : undefined;
  };
  const vps = idIn(env.vps, "VPS_ID");
  if (vps) recipes.set(vps, { kind: "vps", args: [] });
  const phone = idIn(env.termux, "PHONE_ID");
  if (phone && !recipes.has(phone)) recipes.set(phone, { kind: "termux", args: [] });
  return recipes;
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The local.env files of `root`'s deploy scripts, as derivedRecipes takes them. */
export const localEnvs = (root: string): { vps: string | null; termux: string | null } => ({
  vps: readText(join(root, "scripts/mesh-vps/local.env")),
  termux: readText(join(root, "scripts/mesh-termux/local.env")),
});

/** The recipes now (read per call): the file's, then the derived ones for the peers it doesn't name
    (a missing file names none). A file that isn't JSON or `{"hosts": …}` gives none at all and says why. */
export function readRecipes(file = recipesFile(), derived: Map<string, Recipe> = derivedRecipes(localEnvs(ROOT))): { recipes: Map<string, Recipe>; error?: string } {
  const text = readText(file);
  let raw: unknown = { hosts: {} };
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { recipes: new Map(), error: "mesh-resync.json isn't valid JSON" };
    }
  }
  const { recipes, errors } = parseRecipes(raw);
  const named = (raw as { hosts?: unknown } | null)?.hosts;
  // A file that isn't {"hosts": …} gives nothing (parseRecipes said why); an entry it names wins even when left out.
  if (typeof named === "object" && named !== null && !Array.isArray(named)) {
    for (const [id, recipe] of derived) if (!Object.hasOwn(named, id)) recipes.set(id, recipe);
  }
  return { recipes, ...(errors.length ? { error: errors.join("; ") } : {}) };
}

/** The script and its arguments for a recipe: the commit is always last, so it wins over anything before it. */
export function recipeArgv(recipe: Recipe, commit: string, root: string): string[] {
  if (recipe.kind === "vps") return [join(root, "scripts/mesh-vps/deploy.sh"), ...recipe.args, "--rev", commit];
  return [
    join(root, "scripts/mesh-termux/deploy.sh"),
    ...(recipe.ssh ? ["--ssh", recipe.ssh] : []),
    ...(recipe.sshPort ? ["--ssh-port", String(recipe.sshPort)] : []),
    "--rev",
    commit,
    "--",
    ...recipe.args,
  ];
}

/** Why a recipe can't run from this checkout as it stands, or undefined. */
export function recipeProblem(recipe: Recipe, root: string, exists: (path: string) => boolean = existsSync): string | undefined {
  if (recipe.kind === "vps") return exists(join(root, "scripts/mesh-vps/local.env")) ? undefined : "scripts/mesh-vps/local.env is missing";
  if (!recipe.ssh && !exists(join(root, "scripts/mesh-termux/local.env"))) return "no ssh target: add \"ssh\" to the recipe or PHONE to scripts/mesh-termux/local.env";
  return undefined;
}

/** Where `theirs` sits against `ours` in `root`'s history. Only 40-hex commits reach git. */
export async function relationOf(ours: string | undefined, theirs: string | undefined, root: string, git: Git): Promise<{ relation: ResyncRelation; distance?: number }> {
  if (!ours || !theirs || !SHA_RE.test(ours) || !SHA_RE.test(theirs)) return { relation: "unknown" };
  if (ours === theirs) return { relation: "same" };
  const has = async (c: string) => (await git(["cat-file", "-e", `${c}^{commit}`], root)) !== null;
  if (!(await has(ours)) || !(await has(theirs))) return { relation: "unknown" };
  const count = async (from: string, to: string) => {
    const out = await git(["rev-list", "--count", `${from}..${to}`], root);
    const n = out === null ? NaN : Number(out.toString().trim());
    return Number.isInteger(n) ? { distance: n } : {};
  };
  if ((await git(["merge-base", "--is-ancestor", theirs, ours], root)) !== null) return { relation: "behind", ...(await count(theirs, ours)) };
  if ((await git(["merge-base", "--is-ancestor", ours, theirs], root)) !== null) return { relation: "ahead", ...(await count(ours, theirs)) };
  return { relation: "diverged" };
}

export interface ServiceResult {
  status: 200 | 202 | 400 | 404 | 409 | 415;
  body: unknown;
}

interface Job {
  state: ResyncJob;
  child: ChildProcess | null;
  timer?: ReturnType<typeof setTimeout>;
  log: WriteStream | null;
  logged: number;
}

export interface ResyncDeps {
  mesh: Pick<MeshApi, "enabled" | "config" | "self" | "peerFetch">;
  root: string;
  git: Git;
  /** The boot record now, and once git has checked it. */
  build: () => BootBuild | null;
  buildChecked: () => Promise<BootBuild | null>;
  /** The page's cached probe, and an uncached one for the job's own checks. */
  probe: (peer: PeerEntry) => Promise<ProbeResult>;
  hello: (url: string) => Promise<ProbeResult>;
  protocol: () => string;
  recipes: () => { recipes: Map<string, Recipe>; error?: string };
  logDir: () => string;
  /** Spawns argv[0] with the rest (tests pass a fake script). */
  spawn: (argv: string[], cwd: string) => ChildProcess;
  exists: (path: string) => boolean;
  timeouts: { vps: number; termux: number; wait: number; poll: number };
}

const realSpawn = (argv: string[], cwd: string): ChildProcess =>
  // Its own process group, so a timeout stops ssh and everything else the script started.
  spawn("bash", argv, { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });

export const DEFAULT_TIMEOUTS = { vps: 20 * 60_000, termux: 45 * 60_000, wait: 3 * 60_000, poll: 5_000 };

const short = (c: string | undefined) => (c ? c.slice(0, 12) : "no commit");

export class ResyncService {
  private readonly jobs = new Map<string, Job>();
  /** Relations are facts of history once both commits are known here. */
  private readonly relations = new Map<string, { relation: ResyncRelation; distance?: number }>();
  private readonly d: ResyncDeps;

  constructor(deps: Partial<ResyncDeps> & Pick<ResyncDeps, "mesh">) {
    this.d = {
      root: ROOT,
      git: realGit,
      build: bootBuild,
      buildChecked: bootBuildChecked,
      probe: probePeer,
      hello: probeHello,
      protocol: ownProtocol,
      recipes: () => readRecipes(recipesFile(), derivedRecipes(localEnvs(this.d.root))),
      logDir: resyncLogDir,
      spawn: realSpawn,
      exists: existsSync,
      timeouts: DEFAULT_TIMEOUTS,
      ...deps,
    };
  }

  private selfOf(build: BootBuild | null, recipesError?: string): ResyncSelf {
    const self = this.d.mesh.self();
    const blocked = !build ? "This host's build wasn't recorded at boot." : build.blocked;
    return { id: self.id, label: self.label, ...(build?.commit ? { commit: build.commit } : {}), ...(blocked ? { blocked } : {}), ...(recipesError ? { recipesError } : {}) };
  }

  private async relation(ours: string | undefined, theirs: string | undefined): Promise<{ relation: ResyncRelation; distance?: number }> {
    const key = `${ours}:${theirs}`;
    const hit = this.relations.get(key);
    if (hit) return hit;
    const r = await relationOf(ours, theirs, this.d.root, this.d.git);
    if (r.relation !== "unknown") this.relations.set(key, r);
    return r;
  }

  /** A skewed peer's commit (its hello's, else its details') and what runs on it. */
  private async peerFacts(peer: PeerEntry, probe: ProbeResult): Promise<{ commit?: string; activity?: ResyncHost["activity"] }> {
    const got = await fetchPeerDetails(this.d.mesh, peer);
    const fromHello = probe.hello?.commit;
    const commit = typeof fromHello === "string" && SHA_RE.test(fromHello) ? fromHello : got.details?.versions.commit;
    const a = got.details?.activity;
    return {
      ...(typeof commit === "string" && SHA_RE.test(commit) ? { commit } : {}),
      ...(a && typeof a.turnsRunning === "number" && typeof a.workers === "number" ? { activity: { turnsRunning: a.turnsRunning, workers: a.workers } } : {}),
    };
  }

  async info(): Promise<MeshResync | null> {
    const config = this.d.mesh.enabled() ? this.d.mesh.config() : null;
    if (!config) return null;
    const build = this.d.build();
    const { recipes, error } = this.d.recipes();
    const hosts = await Promise.all(
      config.peers.map(async (peer): Promise<ResyncHost> => {
        const probe = await this.d.probe(peer);
        const recipe = recipes.get(peer.id) ?? null;
        const problem = recipe ? recipeProblem(recipe, this.d.root, this.d.exists) : undefined;
        const job = this.jobs.get(peer.id)?.state;
        const base = { id: peer.id, label: peer.label || peer.id, state: probe.state, recipe: recipe?.kind ?? null, ...(problem ? { recipeProblem: problem } : {}), ...(job ? { job: { ...job } } : {}) };
        if (probe.state !== "skewed") return { ...base, relation: probe.state === "up" ? "same" : "unknown" };
        const facts = await this.peerFacts(peer, probe);
        return { ...base, ...facts, ...(await this.relation(build?.commit, facts.commit)) };
      }),
    );
    return { self: this.selfOf(build, error), hosts };
  }

  private running(id: string): boolean {
    const s = this.jobs.get(id)?.state.state;
    return s === "running" || s === "waiting";
  }

  /** POST /api/mesh/resync/:id. Every check is made again here: the page's view may be old. */
  async start(id: string, body: unknown, contentType: string | undefined): Promise<ServiceResult> {
    const config = this.d.mesh.enabled() ? this.d.mesh.config() : null;
    if (!config) return { status: 404, body: { error: "Not found" } };
    if (!/^application\/json\b/i.test(contentType ?? "")) return { status: 415, body: { error: "Send the request as JSON" } };
    const commit = (body as { commit?: unknown } | null)?.commit;
    if (typeof commit !== "string" || !SHA_RE.test(commit)) return { status: 400, body: { error: "Expected { commit } as the 40-hex commit the sheet showed" } };
    const peer = config.peers.find((p) => p.id === id);
    if (!peer) return { status: 404, body: { error: "No such host" } };
    // A dial-out pairing (§mesh/lan) is reached only over its own connection, never at an address
    // it gave: no recipe may push a build to it from here.
    if (peer.lan) return { status: 409, body: { error: `${peer.label || peer.id} is a dial-out pairing: update it on that host` } };
    const name = peer.label || peer.id;
    const selfName = this.d.mesh.self().label;
    if (this.running(id)) return { status: 409, body: { error: `A resync of ${name} is already running` } };
    const build = await this.d.buildChecked();
    if (!build?.commit || commit !== build.commit) {
      return { status: 409, body: { error: `${selfName} runs ${short(build?.commit)}, not ${short(commit)}: reopen the menu to see its build` } };
    }
    if (build.blocked) return { status: 409, body: { error: build.blocked } };
    const recipe = this.d.recipes().recipes.get(id);
    if (!recipe) return { status: 409, body: { error: noRecipeReason({ id, label: name }, selfName) } };
    const problem = recipeProblem(recipe, this.d.root, this.d.exists);
    if (problem) return { status: 409, body: { error: `The recipe for ${name} can't run: ${problem}` } };
    const probe = await this.d.hello(peerUrl(peer));
    if (probe.state === "up") return { status: 409, body: { error: `${name} already runs ${selfName}'s version` } };
    if (probe.state !== "skewed") return { status: 409, body: { error: `${name} isn't answering (${probe.state}), so its build can't be compared` } };
    const facts = await this.peerFacts(peer, probe);
    const rel = await this.relation(build.commit, facts.commit);
    if (rel.relation !== "behind") {
      const why: Record<Exclude<ResyncRelation, "behind">, string> = {
        ahead: `${name} runs a newer build than ${selfName}; update ${selfName} instead`,
        same: `${name} runs the same commit`,
        diverged: `${name} runs a build on another branch`,
        unknown: `${name}'s commit isn't known in this checkout`,
      };
      return { status: 409, body: { error: why[rel.relation] } };
    }
    return { status: 202, body: this.run(peer, recipe, build.commit) };
  }

  private run(peer: PeerEntry, recipe: Recipe, commit: string): ResyncJob {
    const job: Job = { state: { state: "running", commit, startedAt: Date.now(), tail: "" }, child: null, log: null, logged: 0 };
    this.jobs.set(peer.id, job);
    try {
      mkdirSync(this.d.logDir(), { recursive: true });
      job.log = createWriteStream(join(this.d.logDir(), `${peer.id}.log`), { flags: "w", mode: 0o600 });
      job.log.on("error", () => {
        job.log = null;
      });
      this.write(job, `# resync ${peer.id} to ${commit} (${recipe.kind}) at ${new Date(job.state.startedAt).toISOString()}\n`);
    } catch {
      job.log = null; // the tail in memory still says what happened
    }
    let child: ChildProcess;
    try {
      child = this.d.spawn(recipeArgv(recipe, commit, this.d.root), this.d.root);
    } catch (error) {
      this.end(job, { state: "failed", error: `The deploy script couldn't start: ${(error as Error).message}` });
      return { ...job.state };
    }
    job.child = child;
    const out = (chunk: Buffer) => this.write(job, chunk.toString());
    child.stdout?.on("data", out);
    child.stderr?.on("data", out);
    job.timer = setTimeout(() => {
      this.kill(job);
      this.end(job, { state: "failed", error: `The deploy script ran past ${Math.round(this.d.timeouts[recipe.kind] / 60_000)} minutes and was stopped` });
    }, this.d.timeouts[recipe.kind]);
    child.once("error", (error) => this.end(job, { state: "failed", error: `The deploy script couldn't start: ${error.message}` }));
    child.once("close", (code) => {
      if (job.state.state !== "running") return;
      clearTimeout(job.timer);
      if (code !== 0) {
        this.end(job, { state: "failed", error: `The deploy script stopped with exit ${code ?? "(killed)"}. Nothing after that step ran.` });
        return;
      }
      job.state = { ...job.state, state: "waiting" };
      void this.waitForPeer(job, peer);
    });
    return { ...job.state };
  }

  private write(job: Job, text: string): void {
    job.state.tail = (job.state.tail + text).slice(-TAIL_MAX);
    if (job.log && job.logged < LOG_MAX) {
      const piece = text.slice(0, LOG_MAX - job.logged);
      job.logged += piece.length;
      job.log.write(piece);
    }
  }

  /** After the script: poll the peer's hello (uncached) until it speaks this host's protocol. */
  private async waitForPeer(job: Job, peer: PeerEntry): Promise<void> {
    const until = Date.now() + this.d.timeouts.wait;
    let last: ProbeResult | null = null;
    while (job.state.state === "waiting") {
      last = await this.d.hello(peerUrl(peer));
      if (job.state.state !== "waiting") return;
      if (last.state === "up" && last.hello?.protocol === this.d.protocol()) {
        this.end(job, { state: "done" });
        return;
      }
      if (Date.now() >= until) break;
      await new Promise((r) => {
        job.timer = setTimeout(r, this.d.timeouts.poll);
      });
    }
    if (job.state.state !== "waiting") return;
    const name = peer.label || peer.id;
    this.end(job, { state: "failed", error: `The deploy finished, but ${name} doesn't answer with this host's version yet (it is ${last?.state ?? "unknown"}). Check it on #/mesh.` });
  }

  private kill(job: Job): void {
    const c = job.child;
    if (!c || c.exitCode !== null || c.pid === undefined) return;
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      c.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        if (c.exitCode === null) process.kill(-c.pid!, "SIGKILL");
      } catch {
        // gone
      }
    }, 5_000).unref();
  }

  private end(job: Job, next: { state: "done" | "failed"; error?: string }): void {
    if (job.state.state === "done" || job.state.state === "failed") return;
    clearTimeout(job.timer);
    job.state = { ...job.state, state: next.state, endedAt: Date.now(), ...(next.error ? { error: next.error } : {}) };
    this.write(job, `# ${next.state}${next.error ? `: ${next.error}` : ""}\n`);
    job.log?.end();
    job.log = null;
  }

  /** The last job for a host (tests). */
  job(id: string): ResyncJob | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j.state } : undefined;
  }

  /** Stop running jobs on shutdown. */
  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.state.state === "running" || job.state.state === "waiting") {
        this.kill(job);
        this.end(job, { state: "failed", error: "Sova stopped on this host, which stopped the job" });
      }
    }
  }
}

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const small = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "Too large" }, 413) });

/** GET /api/mesh/resync and POST /api/mesh/resync/:id (main listener only: /api/mesh/*). */
export function mountResync(app: Hono, mesh: MeshApi, deps: Partial<ResyncDeps> = {}): ResyncService {
  const service = new ResyncService({ mesh, ...deps });
  app.get("/api/mesh/resync", async (c) => {
    const info = await service.info();
    return info ? c.json(info) : notFound(c);
  });
  app.post("/api/mesh/resync/:id", small, async (c) => {
    const body = await c.req.json().catch(() => null);
    const r = await service.start(c.req.param("id"), body, c.req.header("content-type"));
    return c.json(r.body as object, r.status);
  });
  return service;
}
