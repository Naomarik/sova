import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SERVED_FILE_NAME, type ServedData, servedKey } from "../../pi-config/extensions/worktrees/served.ts";
import type { ChecksDeclared, MergeQueueView } from "../../shared/merge-queue";
import type { ProjectDef } from "../../shared/project-contract";
import type { ChecksOf } from "./contract";
import { type Git, realGit, revParse } from "./guard";
import { buildView } from "./view";

/**
 * Which repos the merge queue serves (al_1): a repo whose main checkout is the root of a project on Sova's
 * Projects list (not archived) AND whose merge setup is done (the target head's .sova/project.json declares
 * checks, or is there and doesn't parse). Every way into the queue asks this one rule; every other repo merges
 * plainly. It reads Git and the definition only: answering never creates a queue or its records.
 *
 * The answer reaches chats through `<state root>/merge-served.json` (pi-config/extensions/worktrees/served.ts reads
 * it), written here only, atomically, whenever its content changes.
 */

export { SERVED_FILE_NAME, type ServedData, servedKey };

/** What an unserved repo's go-ahead or queue request is answered, exactly. */
export const NOT_SERVED = "not a project the merge queue serves: merge it into main from the chat";

type DefinitionAt = (root: string, ref: string) => Promise<{ def: ProjectDef | null; error: string | null }>;

/** The branch the queue of `root` lands into: the definition's merge.target, else the main checkout's branch, else
 *  master/main (ProjectQueue's target). */
export async function resolveTarget(git: Git, root: string, definitionAt: DefinitionAt): Promise<string> {
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  const main = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null;
  const at = await definitionAt(root, main ?? "HEAD");
  if (at.def?.merge?.target) return at.def.merge.target;
  if (main) return main;
  for (const b of ["master", "main"]) if (await revParse(git, root, `refs/heads/${b}`)) return b;
  return "master";
}

/** A definition that is there but doesn't parse (definitionAt's other errors, "no commit …" and "no
 *  .sova/project.json at …", are a project with nothing declared). */
export function invalidOf(at: { def: ProjectDef | null; error: string | null }): string | undefined {
  return !at.def && at.error && !/^no /.test(at.error) ? at.error : undefined;
}

/** The merge setup is done: checks declared, or a definition that doesn't parse (a broken setup is said, never
 *  bypassed). */
export const setUpOf = (checks: ChecksDeclared, invalid: string | undefined): boolean => checks !== "unset" || !!invalid;

export interface ServedDeps {
  /** Sova's Projects list (server/projects/spaces.ts listProjects): every project's main-checkout root. An archived
   *  project isn't served. */
  listed: () => { root: string; id?: string; archived?: unknown }[];
  definitionAt: DefinitionAt;
  checksOf: ChecksOf;
  git?: Git;
  /** How long one root's setup answer is kept (default 2 s). */
  ttlMs?: number;
  now?: () => number;
}

export interface SetupOf {
  target: string;
  /** The target's head ("" when the branch doesn't exist). */
  head: string;
  checks: ChecksDeclared;
  invalid?: string;
  setUp: boolean;
}

export class ServedRule {
  private readonly cache = new Map<string, { at: number; v: Promise<SetupOf> }>();
  constructor(private readonly deps: ServedDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private rows(): { root: string; id?: string }[] {
    try {
      return this.deps.listed().filter((r) => !r.archived && typeof r.root === "string" && r.root);
    } catch {
      return [];
    }
  }

  /** The listed roots (archived projects left out), as the file compares them. */
  listedRoots(): string[] {
    return [...new Set(this.rows().map((r) => servedKey(r.root)))].sort();
  }

  /** The listed project's id at `root`; null: not listed. */
  projectIdOf(root: string): string | null {
    const key = servedKey(root);
    const row = this.rows().find((r) => servedKey(r.root) === key);
    return row ? (row.id ?? key) : null;
  }

  /** `root` is a project on the Projects list. */
  isListed(root: string): boolean {
    return this.listedRoots().includes(servedKey(root));
  }

  /** The repo's merge setup, read from Git (cached briefly; never creates a queue). */
  setupOf(root: string): Promise<SetupOf> {
    const key = servedKey(root);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < (this.deps.ttlMs ?? 2000)) return hit.v;
    const git = this.deps.git ?? realGit;
    const v = (async (): Promise<SetupOf> => {
      const target = await resolveTarget(git, key, this.deps.definitionAt);
      const head = (await revParse(git, key, `refs/heads/${target}`)) ?? "";
      const at = head ? await this.deps.definitionAt(key, head) : { def: null, error: "no target" };
      const checks = this.deps.checksOf(at.def);
      const invalid = invalidOf(at);
      return { target, head, checks, ...(invalid ? { invalid } : {}), setUp: setUpOf(checks, invalid) };
    })();
    this.cache.set(key, { at: this.now(), v });
    v.catch(() => this.cache.delete(key));
    if (this.cache.size > 200) for (const k of [...this.cache.keys()].slice(0, 100)) this.cache.delete(k);
    return v;
  }

  /** The target the queue lands `root` into when it serves `root`; null: not served. */
  async servedTarget(root: string): Promise<string | null> {
    if (!root || !this.isListed(root)) return null;
    try {
      const s = await this.setupOf(root);
      return s.setUp ? s.target : null;
    } catch {
      return null;
    }
  }

  async served(root: string): Promise<boolean> {
    return (await this.servedTarget(root)) !== null;
  }

  /** Every served root with its target, sorted (the file's content). */
  async servedRoots(): Promise<{ root: string; target: string }[]> {
    const out: { root: string; target: string }[] = [];
    for (const root of this.listedRoots()) {
      const target = await this.servedTarget(root);
      if (target) out.push({ root, target });
    }
    return out;
  }

  /** The Merge Queue tab's view of a listed project the queue doesn't serve yet: no entries, `served: false`, its
   *  declared checks. Built from Git alone: answering it makes no queue and writes no record (a4). */
  async bareView(root: string, now: number = this.now()): Promise<MergeQueueView> {
    const key = servedKey(root);
    const s = await this.setupOf(key);
    const q = { v: 1 as const, project: this.projectIdOf(key) ?? key, root: key, target: s.target, entries: [], landed: [], heads: {}, machineTries: {}, seq: 0 };
    const v = buildView({ q, root: key, current: null, checks: s.checks, review: false, head: s.head, takesMs: null, now, readRun: () => null, served: false });
    return { ...v, ...(s.invalid ? { invalid: s.invalid } : {}) };
  }

  /** Forget cached setups (a setup ran, or the list changed). */
  forget(root?: string): void {
    if (root) this.cache.delete(servedKey(root));
    else this.cache.clear();
  }
}

// ---- the file chats read ------------------------------------------------------------------------

const sameRoots = (a: ServedData["roots"], b: ServedData["roots"]): boolean =>
  a.length === b.length && a.every((x, i) => x.root === b[i]!.root && x.target === b[i]!.target);

function readRoots(file: string): ServedData["roots"] | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ServedData>;
    return raw?.v === 1 && Array.isArray(raw.roots) ? raw.roots : null;
  } catch {
    return null;
  }
}

/** Write the served roots to `file` (tmp + rename, mode 0600) when they differ from what it holds; true: written. */
export function writeServedFile(file: string, roots: ServedData["roots"], now: () => number = Date.now): boolean {
  const sorted = [...roots].sort((a, b) => a.root.localeCompare(b.root) || a.target.localeCompare(b.target));
  const had = readRoots(file);
  if (had && sameRoots(had, sorted)) return false;
  mkdirSync(dirname(file), { recursive: true });
  const data: ServedData = { v: 1, at: new Date(now()).toISOString(), roots: sorted };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

/** Keep `file` current: once now (awaited by the caller before ingest starts), then every `everyMs` and on refresh(). */
export function startServedWriter(
  rule: ServedRule,
  file: string,
  opts: { everyMs?: number; log?: (line: string) => void; onRoots?: (roots: ServedData["roots"], written: boolean) => void } = {},
): { refresh(): Promise<void>; stop(): void; first: Promise<void> } {
  let running: Promise<void> | null = null;
  let again = false;
  const pass = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        const roots = await rule.servedRoots();
        opts.onRoots?.(roots, writeServedFile(file, roots));
      } catch (err) {
        (opts.log ?? console.warn)(`[merge-queue] served roots: ${err instanceof Error ? err.message : err}`);
      }
    })().finally(() => {
      running = null;
      if (again) {
        again = false;
        void pass();
      }
    });
    return running;
  };
  const first = pass();
  const t = setInterval(() => void pass(), opts.everyMs ?? 5000);
  t.unref?.();
  return {
    first,
    refresh: () => {
      rule.forget();
      return pass();
    },
    stop: () => clearInterval(t),
  };
}

// ---- the server's rule ----------------------------------------------------------------------------

let current: ServedRule | null = null;

/** The server's rule (wire.ts sets it at start; tests may stand one in). */
export function setServedRule(r: ServedRule | null): void {
  current = r;
}

async function defaultRule(): Promise<ServedRule> {
  if (current) return current;
  const [{ listProjects }, { definitionAt }, { checksOf }] = await Promise.all([import("../projects/spaces"), import("../project-services/deploy-recipe"), import("./checks")]);
  current ??= new ServedRule({ listed: () => listProjects(), definitionAt: (root, ref) => definitionAt(root, ref), checksOf });
  return current;
}

/** The rule: `root` (a main checkout) is on the Projects list and its merge setup is done. */
export async function servedByQueue(root: string): Promise<boolean> {
  return (await defaultRule()).served(root);
}

/** The server's rule object (its setup and listing reads). */
export function servedRule(): Promise<ServedRule> {
  return defaultRule();
}

// ---- the chat's landing lines (a6): which repos land through the queue, said per turn ---------------

/** The lead-in of the landing lines in a chat's card note (card-note.ts adds it): never the user's words. */
export { LANDING_LINES_LEAD as LANDING_NOTE_LEAD } from "./card-note";

/** A served repo's landing line. */
export const servedLine = (root: string, target: string): string =>
  `Landing note for ${root}: branches reach ${target} only through Sova's merge queue. Never merge into ${target} yourself. When the user types "land it" or "merge it" here, commit what's left and call worktree land (it queues the branch; the queue checks and lands it). When a branch is ready, tell them they can type "land it" or press Land.`;

/** Any other repo's landing line. */
export const unservedLine = (root: string): string =>
  `Landing note for ${root}: no merge queue here. When the user asks to land or merge a branch, commit what's left and merge it into the main branch yourself (worktree merge, or worktree land on their typed "land it").`;

export interface LandingNoteDeps {
  /** The main-checkout roots of the git repos a chat works in (its cwd's, its tracked worktrees'); null: a chat
   *  that gets no landing lines (the merge queue's own chats, an unknown session). */
  repos: (session: string) => Promise<string[] | null>;
  /** The served target of a root; null: not served (ServedRule.servedTarget). */
  targetOf: (root: string) => Promise<string | null>;
}

/**
 * Each chat's landing lines: one per repo it works in, said at its first note and again only when that repo's
 * answer changes (served ↔ not, or a new target). What was said is kept per chat in memory: after a server
 * restart each chat hears its lines once more.
 */
export class LandingNotes {
  private readonly said = new Map<string, Map<string, string>>();
  constructor(private readonly deps: LandingNoteDeps) {}

  async noteFor(session: string): Promise<string | null> {
    if (!session) return null;
    const repos = await this.deps.repos(session).catch(() => null);
    if (!repos?.length) return null;
    const had = this.said.get(session) ?? new Map<string, string>();
    const lines: string[] = [];
    for (const root of [...new Set(repos)].sort()) {
      const target = await this.deps.targetOf(root).catch(() => null);
      const key = target ? `served:${target}` : "plain";
      if (had.get(root) === key) continue;
      had.set(root, key);
      lines.push(target ? servedLine(root, target) : unservedLine(root));
    }
    this.said.delete(session);
    this.said.set(session, had);
    if (this.said.size > 2000) for (const k of [...this.said.keys()].slice(0, 500)) this.said.delete(k);
    return lines.length ? lines.join("\n") : null;
  }
}
