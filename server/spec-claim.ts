// The spec card's claim sheet (GET /api/spec-turn/claim, §chat.spec-card/claim-sheet): one claim's text
// as of the run that changed it. A committed operation's text is read from its commits: `git archive
// <rev> .sova/spec` into a temporary folder, then the trusted spec tools' `read --spec .sova/spec
// --no-frame` there, all as child processes without a shell; the work tree is never read for it. An
// uncommitted promotion's text is the one the record captured at settle. Anything else is the current text,
// said as such. Only a `spec-turn` record in the named session's own file is read, at a folder it names.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SpecClaimText } from "../shared/protocol";
import { normalizeSpecTurnDetails, SPEC_TURN_ENTRY, type SpecTurnDetails, type SpecTurnOp } from "../pi-config/extensions/mode/spec-turn.ts";
import { parsePi } from "./harness/pi/reader";
import { resolveSessionPath } from "./paths";

const SPEC_TOOL = join(import.meta.dirname, "..", "pi-config", "extensions", "spec", "core", "sova-spec.mjs");
const TOOL_TIMEOUT_MS = 30_000;
const SPEC_REL = ".sova/spec";
const SECTION_ID = /^§[A-Za-z0-9](?:[\w.\-/]*[\w-])?$/;
/** Pages of one passage the reader follows (a passage past the tool's budget comes in pieces). */
const MAX_PAGES = 8;

export class SpecClaimError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 500 = 400,
  ) {
    super(message);
  }
}

export interface SpecClaimDeps {
  /** The spec tool (tests point it elsewhere). */
  tool?: string;
}

/** A claim's text at a commit, by (tree, rev, §): commits never change, so a result stands. */
const atCommit = new Map<string, Promise<string | undefined>>();
const AT_COMMIT_MAX = 200;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[k];
  return env;
}

/** Whether `rev` is a commit in `tree`'s repository. */
function hasCommit(tree: string, rev: string): Promise<boolean> {
  return new Promise((done) => {
    execFile("git", ["--no-optional-locks", "cat-file", "-e", `${rev}^{commit}`], { cwd: tree, env: gitEnv(), timeout: TOOL_TIMEOUT_MS }, (err) => done(!err));
  });
}

/** `git archive <rev> -- .sova/spec | tar -x -C <dir>`, as two processes and a pipe: no shell. */
function archiveSpec(tree: string, rev: string, dir: string): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(ok);
    };
    let git, tar;
    try {
      git = spawn("git", ["--no-optional-locks", "archive", "--format=tar", rev, "--", SPEC_REL], { cwd: tree, env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] });
      tar = spawn("tar", ["-x", "-f", "-", "-C", dir], { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      git.kill("SIGKILL");
      tar.kill("SIGKILL");
      finish(false);
    }, TOOL_TIMEOUT_MS);
    git.stdout.pipe(tar.stdin);
    let gitCode: number | null | undefined;
    let tarCode: number | null | undefined;
    const both = () => {
      if (gitCode !== undefined && tarCode !== undefined) finish(gitCode === 0 && tarCode === 0);
    };
    git.on("error", () => finish(false));
    tar.on("error", () => finish(false));
    tar.stdin.on("error", () => {});
    git.on("close", (code) => ((gitCode = code), both()));
    tar.on("close", (code) => ((tarCode = code), both()));
  });
}

/** The trusted tools' `read` of one passage under `root` (its `.sova/spec`): the text, or undefined when the
    spec there has no such §. Follows a passage's pages. */
async function readClaim(root: string, id: string, tool: string): Promise<string | undefined> {
  const parts: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = [tool, "read", id, "--spec", SPEC_REL, "--no-frame", "--root", root, "--json", ...(cursor ? ["--cursor", cursor] : [])];
    const json = await new Promise<Record<string, any>>((done, fail) => {
      execFile(process.execPath, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout) => {
        try {
          done(JSON.parse(stdout));
        } catch {
          fail(new SpecClaimError(`The spec tools couldn't read ${id}: ${err?.message ?? "no output"}`, 500));
        }
      });
    });
    if (json.code === "unknown-id") return undefined;
    if (json.exit === 2) throw new SpecClaimError(`The spec tools refused to read ${id}: ${json.message ?? json.code ?? "refused"}`, 500);
    for (const it of Array.isArray(json.items) ? json.items : []) if (typeof it?.text === "string") parts.push(it.text);
    cursor = typeof json.next === "string" ? json.next : typeof json.cursor === "string" ? json.cursor : undefined;
    if (!cursor || !(json.remaining > 0)) break;
  }
  return parts.length ? parts.join("") : undefined;
}

/** A claim's text at a commit: the spec materialised from it into a temporary folder, read there, removed. */
export function claimAtCommit(tree: string, rev: string, id: string, tool = SPEC_TOOL): Promise<string | undefined> {
  const key = `${tree}\0${rev}\0${id}\0${tool}`;
  const hit = atCommit.get(key);
  if (hit) return hit;
  const run = (async () => {
    if (!(await hasCommit(tree, rev))) throw new SpecClaimError("That commit is no longer in the repository", 404);
    const dir = await mkdtemp(join(tmpdir(), "sova-spec-claim-"));
    try {
      if (!(await archiveSpec(tree, rev, dir))) return undefined; // no spec at that commit
      return await readClaim(dir, id, tool);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  atCommit.set(key, run);
  run.catch(() => atCommit.delete(key));
  while (atCommit.size > AT_COMMIT_MAX) atCommit.delete(atCommit.keys().next().value!);
  return run;
}

/** The record `entry` in the session file, checked; the session's cwd beside it. */
async function recordOf(sessionRaw: string, entry: string): Promise<{ d: SpecTurnDetails; cwd?: string }> {
  const path = resolveSessionPath(sessionRaw);
  if (!path) throw new SpecClaimError("Unknown session", 404);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new SpecClaimError("Unknown session", 404);
  }
  const file = parsePi(text);
  for (const h of file.entries) {
    if (h.kind !== "state" || h.key !== SPEC_TURN_ENTRY || h.id !== entry) continue;
    const d = normalizeSpecTurnDetails(h.data);
    if (!d) throw new SpecClaimError("That spec record can't be read", 404);
    return { d, cwd: file.header?.cwd };
  }
  throw new SpecClaimError("No such spec record in this session", 404);
}

const committed = (op: SpecTurnOp) => op.after !== op.before;

/** One claim's text for the sheet (§chat.spec-card/claim-sheet). */
export async function specClaim(q: { session?: string; entry?: string; id?: string }, deps: SpecClaimDeps = {}): Promise<SpecClaimText> {
  const tool = deps.tool ?? SPEC_TOOL;
  if (!q.session) throw new SpecClaimError("Missing ?session= (a session path)");
  if (!q.entry || q.entry.length > 64) throw new SpecClaimError("Missing ?entry= (the record's entry id)");
  if (!q.id || !SECTION_ID.test(q.id)) throw new SpecClaimError("Invalid ?id= (a § id)");
  const id = q.id;
  const { d, cwd } = await recordOf(q.session, q.entry);
  const item = [...d.own, ...d.landed].find((it) => it.id === id);
  const op = item?.op !== undefined ? d.ops[item.op] : d.ops.length === 1 ? d.ops[0] : undefined;
  const captured = d.prose?.[id];
  // An uncommitted promotion (or any capture): the text as the run left it, and the commit before it.
  // A worktree merged and removed since: its commits are still in the repository the session works in.
  const repo = op ? await repoFor(op, cwd) : undefined;
  if (captured !== undefined) {
    const before = op && repo ? await claimAtCommit(repo, op.before, id, tool).catch(() => undefined) : undefined;
    return { id, source: "captured", after: captured, ...(before !== undefined ? { before } : {}) };
  }
  if (op && repo && committed(op)) {
    const after = await claimAtCommit(repo, op.after, id, tool);
    const before = await claimAtCommit(repo, op.before, id, tool).catch(() => undefined);
    return { id, source: "commit", rev: op.after, ...(after !== undefined ? { after } : {}), ...(before !== undefined ? { before } : {}) };
  }
  // Otherwise (a commit gone, or no operation of the run landed it): the current text, said as such.
  for (const root of new Set([op?.tree, d.ops[0]?.tree, cwd])) {
    if (!root || !isAbsolute(root) || !existsSync(root)) continue;
    const now = await readClaim(root, id, tool).catch(() => undefined);
    if (now !== undefined) return { id, source: "current", after: now };
  }
  return { id, source: "current" };
}

/** Where `op`'s commits can be read: its own tree, else the session's folder (a worktree shares its
    repository's objects), as long as the operation's commits are there. */
async function repoFor(op: SpecTurnOp, cwd: string | undefined): Promise<string | undefined> {
  for (const dir of [op.tree, cwd]) {
    if (!dir || !isAbsolute(dir) || !existsSync(dir)) continue;
    if (await hasCommit(dir, op.before)) return dir;
  }
  return undefined;
}
