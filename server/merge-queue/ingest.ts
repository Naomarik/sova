import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type GoAhead, readLanding } from "../../pi-config/extensions/worktrees/landing.ts";
import { type Git, realGit, revParse } from "./guard";
import { MergeFailure, type ProjectQueue } from "./queue";
import { NOT_SERVED } from "./served";

/**
 * The user's "land it" typed in a branch's own chat reaches the queue here. The `worktree` tool's `land` writes a
 * go-ahead (`by: "owner-chat"`, only for the user's own newest message) to `<state>/landing.json`; each new one is
 * queued as `merge.add` with `by: "typed"` at exactly that commit, once. Go-aheads older than the first read are
 * never taken (the file holds months of records from before the queue). A refusal is told to that chat.
 */

export interface IngestDeps {
  /** landing.json. */
  file: string;
  /** Where the seen keys are kept. */
  seenFile: string;
  /** The main checkouts a go-ahead's branch is looked for in (Projects list and recorded roots alike): the one
   *  holding it decides, and `served` says whether the queue takes it there. */
  roots: () => string[] | Promise<string[]>;
  /** The served rule (served.ts): a go-ahead in a root it doesn't serve is refused (NOT_SERVED) and never queued. */
  served: (root: string) => Promise<boolean>;
  queue: (root: string) => Promise<ProjectQueue>;
  git?: Git;
  /** Tell the chat a typed go-ahead couldn't be queued. */
  refused?: (session: string, text: string) => void;
  log?: (line: string) => void;
}

const keyOf = (g: GoAhead) => `${g.branch}@${g.commit}@${g.at}`;

interface Seen {
  v: 1;
  keys: string[];
}

function readSeen(file: string): Seen | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Seen;
    return raw?.v === 1 && Array.isArray(raw.keys) ? raw : null;
  } catch {
    return null;
  }
}
function writeSeen(file: string, s: Seen): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, keys: s.keys.slice(-1000) })}\n`);
  renameSync(tmp, file);
}

/** Which project holds `branch` at `commit` (the branch exists there and contains the commit). */
async function projectOfGoAhead(git: Git, roots: string[], g: GoAhead): Promise<string | null> {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const tip = await revParse(git, root, `refs/heads/${g.branch}`);
    if (!tip) continue;
    if (tip === g.commit || (await git(["merge-base", "--is-ancestor", g.commit, tip], root)).code === 0) return root;
  }
  return null;
}

/** One pass: queue every new typed go-ahead. Answers what it did, one line each. */
export async function ingestOnce(deps: IngestDeps): Promise<string[]> {
  const git = deps.git ?? realGit;
  const data = readLanding(deps.file);
  const typed = data.goAheads.filter((g) => g.by === "owner-chat");
  const seen = readSeen(deps.seenFile);
  if (!seen) {
    // The first read: everything already there is from before the queue.
    writeSeen(deps.seenFile, { v: 1, keys: typed.map(keyOf) });
    return [];
  }
  const known = new Set(seen.keys);
  const fresh = typed.filter((g) => !known.has(keyOf(g)));
  if (!fresh.length) return [];
  const did: string[] = [];
  const roots = await deps.roots();
  for (const g of fresh) {
    seen.keys.push(keyOf(g));
    writeSeen(deps.seenFile, seen);
    const root = await projectOfGoAhead(git, roots, g);
    if (!root) {
      did.push(`typed go-ahead for ${g.branch} at ${g.commit.slice(0, 7)}: no project holds it`);
      if (g.session) deps.refused?.(g.session, `${g.branch} at ${g.commit.slice(0, 7)} couldn't be queued to land: ${NOT_SERVED}.`);
      continue;
    }
    if (!(await deps.served(root).catch(() => false))) {
      did.push(`typed go-ahead for ${g.branch} at ${g.commit.slice(0, 7)} refused: ${NOT_SERVED} (${root})`);
      if (g.session) deps.refused?.(g.session, `${g.branch} at ${g.commit.slice(0, 7)} couldn't be queued to land: ${NOT_SERVED}.`);
      continue;
    }
    try {
      const q = await deps.queue(root);
      const { entry, changed } = await q.add({
        branch: g.branch,
        commit: g.commit,
        by: "typed",
        at: g.at,
        ...(g.session ? { session: g.session, chat: g.session } : {}),
        ...(g.withoutSpecs ? { withoutSpecs: true } : {}),
        ...(g.withoutReview ? { withoutReview: true } : {}),
        ...(g.via ? { via: g.via } : {}),
      });
      did.push(`${changed ? "queued" : "already queued"} ${g.branch} at ${g.commit.slice(0, 7)} (${entry.id}) on the user's typed word`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      did.push(`typed go-ahead for ${g.branch} refused: ${why}`);
      if (g.session && err instanceof MergeFailure) deps.refused?.(g.session, `${g.branch} at ${g.commit.slice(0, 7)} couldn't be queued to land: ${why}.`);
    }
  }
  return did;
}

/** Read landing.json every `everyMs` (and when asked): the queue's door for typed go-aheads. */
export function startIngest(deps: IngestDeps, everyMs = 2000): { poke(): void; stop(): void } {
  let busy = false;
  let again = false;
  const pass = () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    void ingestOnce(deps)
      .then((did) => {
        for (const d of did) (deps.log ?? console.log)(`[merge-queue] ${d}`);
      })
      .catch((err) => (deps.log ?? console.warn)(`[merge-queue] ingest failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => {
        busy = false;
        if (again) {
          again = false;
          pass();
        }
      });
  };
  pass();
  const t = setInterval(pass, everyMs);
  t.unref?.();
  return { poke: pass, stop: () => clearInterval(t) };
}
