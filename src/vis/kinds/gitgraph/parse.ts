/**
 * `vis gitgraph`: commit history across branches, written as the git commands that made it.
 *
 *   commit [id] ["message"] [tone]          on the checked-out branch (`main` if none yet)
 *   branch <name> [from <commit|branch>] [tone]   creates it and checks it out
 *   checkout <name>                          (or `switch <name>`)
 *   merge <branch> [id] ["message"] [tone]   a merge commit; `ff` fast-forwards, `squash` squashes
 *   rebase <branch|commit>                   replays this branch's own commits as C', D'
 *   cherry-pick <commit> [id] ["message"] [tone]
 *   tag <name> [on <commit>] [tone]
 *
 * The parser runs the history: every error names the line and says what git would have said. The
 * spec is the result — commits in the order they were made (one row each), each on the lane of the
 * branch it was made on, with its parents; commits a rebase replaced stay, as ghosts. Head and tag
 * positions carry the row after which they hold, so a step-through can replay them.
 */

import { applyMarks, takeMarks, type MarkTarget } from "../../core/emphasis";
import { fail, isTone, lines, modifiers, takeSettings, text, tokenize, type Tone, type Token, type VisBase } from "../../core/grammar";

export type GitCommitKind = "commit" | "merge" | "squash" | "pick" | "rebase";

export interface GitCommit {
  /** The emphasis key. An auto id (`@3`, not shown) when the source gave none. */
  id: string;
  /** Whether `id` was written in the source (and so is drawn). */
  named: boolean;
  message?: string;
  /** Row = index in `commits`; lane = index in `branches`. */
  lane: number;
  parents: string[];
  kind: GitCommitKind;
  /** pick / rebase: the commit it copies; squash: the branch head it squashes. */
  from?: string;
  tone?: Tone;
  /** Replaced by a rebase: from this row on it is a ghost, and `replacedBy` is its copy (none for a dropped merge). */
  ghostAt?: number;
  replacedBy?: string;
}

export interface GitBranch {
  name: string;
  tone?: Tone;
}

/** A pointer (branch head or tag) that holds from row `at` on (-1: from the start). */
export interface GitRef {
  name: string;
  commit: string | null;
  at: number;
}

export interface GitgraphSpec extends VisBase {
  kind: "gitgraph";
  branches: GitBranch[];
  commits: GitCommit[];
  /** Branch head moves, in order: the last one per branch with `at` ≤ a row is its head there. */
  heads: GitRef[];
  tags: (GitRef & { tone?: Tone })[];
  /** The branch checked out at the end. */
  current: string;
}

export const MAX_BRANCHES = 6;
export const MAX_COMMITS = 40;
export const MAX_TAGS = 12;

const COMMIT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}'*$/;
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,59}$/;
const VERBS = "commit, branch, checkout, merge, rebase, cherry-pick or tag";

export function parseGitgraph(body: string): GitgraphSpec {
  const ls = lines(body);
  const spec: GitgraphSpec = { kind: "gitgraph", branches: [], commits: [], heads: [], tags: [], current: "main" };
  const { rest: settled } = takeSettings(ls, [], spec);
  const { rest, marks } = takeMarks(settled);
  const byId = new Map<string, GitCommit>();
  const head = new Map<string, string | null>();
  let current: string | null = null;

  const row = () => spec.commits.length - 1;
  const moveHead = (branch: string, commit: string | null) => {
    head.set(branch, commit);
    spec.heads.push({ name: branch, commit, at: row() });
  };
  const addBranch = (name: string, at: string | null, tone: Tone | undefined, n: number) => {
    if (head.has(name)) fail(n, `branch ${name} already exists: checkout ${name}`);
    if (spec.branches.length >= MAX_BRANCHES) fail(n, `at most ${MAX_BRANCHES} branches`);
    spec.branches.push({ name, ...(tone ? { tone } : {}) });
    moveHead(name, at);
    current = name;
  };
  const checkedOut = (n: number): string => {
    if (current === null) addBranch("main", null, undefined, n);
    return current!;
  };
  const addCommit = (c: Omit<GitCommit, "lane" | "parents">, parents: (string | null)[], n: number): GitCommit => {
    if (byId.has(c.id)) fail(n, `commit ${c.id} already exists: give this one another id`);
    if (spec.commits.length >= MAX_COMMITS) fail(n, `at most ${MAX_COMMITS} commits: draw the part that matters`);
    const branch = checkedOut(n);
    const commit: GitCommit = { ...c, lane: spec.branches.findIndex((b) => b.name === branch), parents: parents.filter((p): p is string => p !== null) };
    spec.commits.push(commit);
    byId.set(commit.id, commit);
    moveHead(branch, commit.id);
    return commit;
  };
  const autoId = () => `@${spec.commits.length + 1}`;
  /** A copy's id: the original's with one more prime, or the next auto id. */
  const copyId = (of: GitCommit) => {
    if (!of.named) return autoId();
    let id = `${of.id}'`;
    while (byId.has(id)) id += "'";
    return id;
  };
  const ancestors = (id: string | null): Set<string> => {
    const out = new Set<string>();
    const todo = id ? [id] : [];
    while (todo.length) {
      const c = byId.get(todo.pop()!)!;
      if (out.has(c.id)) continue;
      out.add(c.id);
      todo.push(...c.parents);
    }
    return out;
  };
  /** A commit id, or a branch name for its head. */
  const ref = (tok: Token | undefined, n: number, what: string): string | null => {
    if (!tok || tok.t !== "word") return fail(n, `expected ${what}`);
    if (byId.has(tok.v)) return tok.v;
    if (head.has(tok.v)) return head.get(tok.v)!;
    return fail(n, `no commit or branch "${tok.v}"${spec.branches.length ? ` (branches: ${spec.branches.map((b) => b.name).join(", ")})` : ""}`);
  };
  const branchName = (tok: Token | undefined, n: number): string => {
    if (!tok || tok.t !== "word") return fail(n, "expected a branch name");
    if (!BRANCH.test(tok.v)) fail(n, `"${tok.v}" is not a branch name (letters, digits, _ . / -)`);
    return tok.v;
  };
  const existing = (tok: Token | undefined, n: number): string => {
    const name = branchName(tok, n);
    if (!head.has(name)) fail(n, `no branch ${name}: create it with branch ${name}`);
    return name;
  };
  /** `[id] ["message"] [tone] [words…]` after a verb's own operands. */
  const tail = <W extends string>(toks: Token[], n: number, words: readonly W[] = []) => {
    let k = 0;
    let id: string | undefined;
    let message: string | undefined;
    const t0 = toks[0];
    if (t0?.t === "word" && !isTone(t0.v) && !(words as readonly string[]).includes(t0.v)) {
      if (!COMMIT_ID.test(t0.v)) fail(n, `"${t0.v}" is not a commit id (letters, digits, _ . -, then optional ' primes)`);
      id = t0.v;
      k++;
    }
    if (toks[k]?.t === "str") message = text((toks[k++] as { v: string }).v, n);
    if (toks[k]?.t === "str") fail(n, "one message per commit");
    return { id, message, ...modifiers(toks.slice(k), n, words) };
  };

  for (const line of rest) {
    const n = line.n;
    const toks = tokenize(line);
    const verb = toks[0];
    if (!verb || verb.t !== "word") fail(n, `a line starts with ${VERBS}`);
    const args = toks.slice(1);
    switch (verb!.v) {
      case "commit": {
        const t = tail(args, n);
        const branch = checkedOut(n);
        addCommit({ id: t.id ?? autoId(), named: !!t.id, kind: "commit", ...(t.message ? { message: t.message } : {}), ...(t.tone ? { tone: t.tone } : {}) }, [head.get(branch)!], n);
        break;
      }
      case "branch": {
        const name = branchName(args[0], n);
        let k = 1;
        let at = current === null ? null : head.get(current)!;
        if (args[k]?.t === "word" && args[k]!.v === "from") {
          at = ref(args[k + 1], n, "a commit or branch after from");
          k += 2;
        }
        const { tone } = modifiers(args.slice(k), n);
        addBranch(name, at, tone, n);
        break;
      }
      case "checkout":
      case "switch": {
        if (args[0]?.t === "word" && /^-[bc]$/.test(args[0].v)) fail(n, `write branch ${args[1]?.t === "word" ? args[1].v : "<name>"}: it creates the branch and checks it out`);
        if (args.length !== 1) fail(n, `${verb!.v} takes one branch name`);
        current = existing(args[0], n);
        break;
      }
      case "merge": {
        const src = existing(args[0], n);
        const into = checkedOut(n);
        if (src === into) fail(n, `can't merge ${src} into itself: checkout the branch to merge into first`);
        const t = tail(args.slice(1), n, ["ff", "squash"] as const);
        const s = head.get(src)!;
        const h = head.get(into)!;
        if (s === null || ancestors(h).has(s)) fail(n, `${into} already contains ${src}: nothing to merge`);
        if (t.word === "ff") {
          if (t.id || t.message) fail(n, "a fast-forward makes no commit: drop the id and message");
          if (h !== null && !ancestors(s).has(h)) fail(n, `can't fast-forward: ${into} has commits ${src} lacks (drop ff for a merge commit)`);
          moveHead(into, s);
        } else if (t.word === "squash") {
          addCommit({ id: t.id ?? autoId(), named: !!t.id, kind: "squash", from: s!, message: t.message ?? `Squash ${src}`, ...(t.tone ? { tone: t.tone } : {}) }, [h], n);
        } else {
          addCommit({ id: t.id ?? autoId(), named: !!t.id, kind: "merge", message: t.message ?? `Merge ${src}`, ...(t.tone ? { tone: t.tone } : {}) }, [h, s], n);
        }
        break;
      }
      case "rebase": {
        if (args.length !== 1) fail(n, "rebase takes one branch or commit: rebase main");
        const branch = checkedOut(n);
        const onto = ref(args[0], n, "a branch or commit to rebase onto");
        if (args[0]!.v === branch) fail(n, `${branch} is checked out: checkout the branch to move first`);
        const h = head.get(branch)!;
        const base = ancestors(onto);
        if (h === null || base.has(h)) fail(n, `${branch} has no commits of its own past ${args[0]!.v}: nothing to replay`);
        if (onto !== null && ancestors(h).has(onto)) fail(n, `${branch} already sits on ${args[0]!.v}: nothing to rebase`);
        // Everything the branch has that the target lacks, oldest first (rows are in commit order).
        const mine = ancestors(h);
        const own = spec.commits.filter((c) => mine.has(c.id) && !base.has(c.id));
        let parent = onto;
        const first = spec.commits.length;
        for (const c of own) {
          // Like git, a rebase drops merge commits: their changes arrive with the replayed ones.
          c.ghostAt = first;
          if (c.kind === "merge") continue;
          const copy = addCommit({ id: copyId(c), named: c.named, kind: "rebase", from: c.id, ...(c.message ? { message: c.message } : {}), ...(c.tone ? { tone: c.tone } : {}) }, [parent], n);
          c.replacedBy = copy.id;
          parent = copy.id;
        }
        if (spec.commits.length === first) fail(n, "only merge commits to replay, and a rebase drops those");
        break;
      }
      case "cherry-pick": {
        const orig = args[0]?.t === "word" ? byId.get(args[0].v) : undefined;
        if (!orig) fail(n, `cherry-pick takes a commit id${args[0]?.t === "word" && head.has(args[0].v) ? `, not a branch: name the commit on ${args[0].v}` : ""}`);
        const branch = checkedOut(n);
        if (ancestors(head.get(branch)!).has(orig!.id)) fail(n, `${branch} already contains ${orig!.id}`);
        const t = tail(args.slice(1), n);
        const message = t.message ?? orig!.message;
        addCommit({ id: t.id ?? copyId(orig!), named: t.id ? true : orig!.named, kind: "pick", from: orig!.id, ...(message ? { message } : {}), ...(t.tone ? { tone: t.tone } : {}) }, [head.get(branch)!], n);
        break;
      }
      case "tag": {
        const tok = args[0];
        if (!tok || tok.t !== "word" || !BRANCH.test(tok.v)) fail(n, "tag takes a name: tag v1.0 [on <commit>]");
        if (spec.tags.some((t) => t.name === tok!.v)) fail(n, `tag ${tok!.v} already exists`);
        if (spec.tags.length >= MAX_TAGS) fail(n, `at most ${MAX_TAGS} tags`);
        let k = 1;
        let at = current === null ? null : head.get(current)!;
        if (args[k]?.t === "word" && args[k]!.v === "on") {
          at = ref(args[k + 1], n, "a commit after on");
          k += 2;
        }
        if (at === null) fail(n, "nothing to tag yet: commit first");
        const { tone } = modifiers(args.slice(k), n);
        spec.tags.push({ name: tok!.v, commit: at, at: row(), ...(tone ? { tone } : {}) });
        break;
      }
      default:
        fail(n, verb!.v === "git" ? "drop the leading git: commit, branch, checkout, merge…" : `unknown line "${verb!.v}": a line starts with ${VERBS}`);
    }
  }
  if (spec.commits.length === 0) fail(0, "nothing to draw: add commits like commit A \"init\"");
  spec.current = current!;
  applyMarks(spec, marks, resolveGitMark(spec), "commit or branch");
  return spec;
}

/** A mark names a commit id, a commit's message, or a branch (key `branch:<name>`). */
function resolveGitMark(spec: GitgraphSpec) {
  const commit = (id: string) => spec.commits.find((c) => c.id === id && c.named)?.id;
  const message = (m: string) => spec.commits.find((c) => c.message === m)?.id;
  const branch = (b: string) => (spec.branches.some((x) => x.name === b) ? `branch:${b}` : undefined);
  return (t: MarkTarget): string | null => {
    if (t.t === "id" || t.t === "number") return commit(t.text) ?? branch(t.text) ?? message(t.text) ?? null;
    if (t.t === "label") return message(t.text) ?? commit(t.text) ?? branch(t.text) ?? null;
    return null;
  };
}
