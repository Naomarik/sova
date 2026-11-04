import type { PushState } from "../../shared/merge-queue";
import { NO_BACKGROUND_CLEANUP, noBackgroundCleanupEnv } from "../git-no-background";
import { type Git, isAncestor, revParse } from "./guard";
import { firstParents } from "./land";

/**
 * A release's own Git moves (queue.ts publishRelease / withdrawRelease / abandonRelease), the only places Sova makes
 * tags: the numbered tag (never moved, never deleted), the channel tags (moved with a lease on their old value), and
 * the one atomic push of master with both. All or none: a failure puts every local ref back as it was.
 */

const short = (s: string) => s.slice(0, 7);
const first = (r: { stderr: string; stdout: string }) => (r.stderr || r.stdout).trim().split("\n").filter((l) => !l.startsWith("To ")).slice(0, 2).join(" ");

/** The tag's own object (an annotated tag's object, not its commit), or null. */
async function refObject(git: Git, root: string, ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "--quiet", ref], root);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** Who a tag Sova makes is by: the repository's own identity, else Sova's. */
async function identity(git: Git, root: string): Promise<NodeJS.ProcessEnv> {
  const name = (await git(["config", "user.name"], root)).stdout.trim();
  const email = (await git(["config", "user.email"], root)).stdout.trim();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!name || !email) Object.assign(env, { GIT_COMMITTER_NAME: name || "Sova release", GIT_COMMITTER_EMAIL: email || "release@sova.invalid", GIT_AUTHOR_NAME: name || "Sova release", GIT_AUTHOR_EMAIL: email || "release@sova.invalid" });
  return env;
}

/** A withdrawn release's marker tag: `withdrawn/<tag>` at its commit, the reason its message (never moved otherwise). */
export const WITHDRAWN_PREFIX = "withdrawn/";

export const hasOrigin = async (git: Git, root: string): Promise<boolean> => (await git(["remote"], root)).stdout.split("\n").includes("origin");

/** origin's refs, name → object (and `<name>^{}` → peeled commit). */
async function remoteRefs(git: Git, root: string, refs: string[]): Promise<Map<string, string> | string> {
  const r = await git(["ls-remote", "origin", ...refs], root, { timeoutMs: 60_000 });
  if (r.code !== 0) return `origin can't be read: ${first(r)}`;
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const m = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!);
  }
  return out;
}
const peeledOf = (m: Map<string, string>, ref: string): string | null => m.get(`${ref}^{}`) ?? m.get(ref) ?? null;

interface Saved {
  ref: string;
  /** The object it pointed at before (null: it didn't exist). */
  was: string | null;
}

async function putBack(git: Git, root: string, saved: Saved[]): Promise<void> {
  for (const s of saved.reverse()) {
    if (s.was) await git(["update-ref", s.ref, s.was], root);
    else await git(["update-ref", "-d", s.ref], root);
  }
}

export interface PublishGit {
  root: string;
  target: string;
  /** The commit released (the target's head). */
  commit: string;
  tag: string;
  channels: string[];
  /** The numbered tag's message (the notes). */
  message: string;
  /** Whether Publish pushes: the project pushes (merge.push not false) and has an origin. */
  push: boolean;
  /** Commits the queue landed (first-parent rule, as the queue's own push). */
  landed: ReadonlySet<string>;
}

export type PublishGitResult =
  | { ok: true; pushed: PushState; why?: string; channelsFrom: Record<string, string | null> }
  | { ok: false; why: string };

/** Tag, move the channels, and (when it pushes) push master with both in one atomic push; all or none. */
export async function publishGit(git: Git, p: PublishGit): Promise<PublishGitResult> {
  const { root, commit, tag } = p;
  const saved: Saved[] = [];
  const tagRef = `refs/tags/${tag}`;
  const at = await revParse(git, root, tagRef);
  if (at && at !== commit) return { ok: false, why: `${tag} already exists at ${short(at)}: a numbered tag never moves` };
  const env = await identity(git, root);
  const channelsFrom: Record<string, string | null> = {};
  try {
    if (!at) {
      const r = await git([...NO_BACKGROUND_CLEANUP, "tag", "-a", tag, "-m", p.message || tag, commit], root, { env });
      if (r.code !== 0) return { ok: false, why: `couldn't make ${tag}: ${first(r)}` };
      saved.push({ ref: tagRef, was: null });
    }
    for (const ch of p.channels) {
      const ref = `refs/tags/${ch}`;
      const was = await refObject(git, root, ref);
      channelsFrom[ch] = await revParse(git, root, ref);
      const r = await git([...NO_BACKGROUND_CLEANUP, "tag", "-f", "-a", ch, "-m", `${ch}: ${tag}`, commit], root, { env });
      if (r.code !== 0) throw new Error(`couldn't move ${ch}: ${first(r)}`);
      saved.push({ ref, was });
    }
    if (!p.push) return { ok: true, pushed: (await hasOrigin(git, root)) ? "not-pushed" : "no-remote", why: (await hasOrigin(git, root)) ? "the project doesn't push" : "no remote named origin: tagged on this machine", channelsFrom };
    const head = `refs/heads/${p.target}`;
    const remote = await remoteRefs(git, root, [head, tagRef, `${tagRef}^{}`, ...p.channels.flatMap((c) => [`refs/tags/${c}`, `refs/tags/${c}^{}`])]);
    if (typeof remote === "string") throw new Error(remote);
    const rHead = remote.get(head) ?? null;
    if (rHead && rHead !== commit) {
      if (!(await revParse(git, root, rHead))) throw new Error(`origin's ${p.target} (${short(rHead)}) has commits this repository doesn't`);
      if (!(await isAncestor(git, root, rHead, commit))) throw new Error(`origin's ${p.target} (${short(rHead)}) isn't in the release's history: never forced`);
      const foreign = (await firstParents(git, root, rHead, commit)).filter((c) => !p.landed.has(c));
      if (foreign.length) throw new Error(`${p.target} has ${foreign.length} commit${foreign.length === 1 ? "" : "s"} the queue didn't land (${short(foreign[0]!)}): never published`);
    }
    const rTag = peeledOf(remote, tagRef);
    if (rTag && rTag !== commit) throw new Error(`origin already has ${tag} at ${short(rTag)}: a numbered tag never moves`);
    // Each channel is leased on what this repository last had for it: origin's moved elsewhere refuses the whole push.
    const leases = p.channels.map((c) => `--force-with-lease=refs/tags/${c}:${saved.find((x) => x.ref === `refs/tags/${c}`)?.was ?? ""}`);
    const specs = [`${commit}:${head}`, ...(rTag ? [] : [`${tagRef}:${tagRef}`]), ...p.channels.map((c) => `refs/tags/${c}:refs/tags/${c}`)];
    const r = await git(["push", "--atomic", "--porcelain", ...leases, "origin", ...specs], root, { timeoutMs: 180_000, env: { ...env, ...noBackgroundCleanupEnv() } });
    if (r.code !== 0) throw new Error(`origin refused the push: ${first(r)}`);
    const after = await remoteRefs(git, root, [head, tagRef, `${tagRef}^{}`, ...p.channels.flatMap((c) => [`refs/tags/${c}`, `refs/tags/${c}^{}`])]);
    if (typeof after === "string") return { ok: true, pushed: "pushed", why: `pushed; ${after}`, channelsFrom };
    const off = [after.get(head) === commit ? null : p.target, peeledOf(after, tagRef) === commit ? null : tag, ...p.channels.map((c) => (peeledOf(after, `refs/tags/${c}`) === commit ? null : c))].filter(Boolean);
    if (off.length) return { ok: true, pushed: "pushed", why: `pushed, but origin doesn't show ${off.join(", ")} at ${short(commit)} yet`, channelsFrom };
    return { ok: true, pushed: "pushed", channelsFrom };
  } catch (err) {
    await putBack(git, root, saved);
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}

export interface WithdrawGit {
  root: string;
  /** Each channel's new commit (the previous release), or null: no release left, the channel is removed. */
  channels: Record<string, string | null>;
  /** The withdrawn tag (the channel tags' message names it) and its commit. */
  tag: string;
  sha: string;
  why: string;
  push: boolean;
}

export type WithdrawGitResult = { ok: true; pushed: PushState; why?: string; channelsFrom: Record<string, string | null> } | { ok: false; why: string };

/** Move each channel back (with a lease on its old value when pushing); the numbered tag is never touched. */
export async function withdrawGit(git: Git, w: WithdrawGit): Promise<WithdrawGitResult> {
  const { root } = w;
  const saved: Saved[] = [];
  const env = await identity(git, root);
  const channelsFrom: Record<string, string | null> = {};
  try {
    for (const [ch, to] of Object.entries(w.channels)) {
      const ref = `refs/tags/${ch}`;
      const was = await refObject(git, root, ref);
      channelsFrom[ch] = await revParse(git, root, ref);
      const r = to
        ? await git([...NO_BACKGROUND_CLEANUP, "tag", "-f", "-a", ch, "-m", `${ch}: back from ${w.tag} (withdrawn: ${w.why.split("\n")[0]})`, to], root, { env })
        : was
          ? await git(["update-ref", "-d", ref], root)
          : { code: 0, stdout: "", stderr: "" };
      if (r.code !== 0) throw new Error(`couldn't move ${ch}: ${first(r)}`);
      saved.push({ ref, was });
    }
    // The marker other copies read (Settings → Updates): `withdrawn/<tag>` at the release, its message the reason.
    const marker = `refs/tags/${WITHDRAWN_PREFIX}${w.tag}`;
    const hadMarker = await refObject(git, root, marker);
    const m = await git([...NO_BACKGROUND_CLEANUP, "tag", "-f", "-a", `${WITHDRAWN_PREFIX}${w.tag}`, "-m", w.why, w.sha], root, { env });
    if (m.code !== 0) throw new Error(`couldn't mark ${w.tag} withdrawn: ${first(m)}`);
    saved.push({ ref: marker, was: hadMarker });
    if (!w.push) return { ok: true, pushed: (await hasOrigin(git, root)) ? "not-pushed" : "no-remote", channelsFrom };
    const names = Object.keys(w.channels);
    const remote = await remoteRefs(git, root, [...names.map((c) => `refs/tags/${c}`), marker]);
    if (typeof remote === "string") throw new Error(remote);
    const leases = [...names.map((c) => `--force-with-lease=refs/tags/${c}:${saved.find((x) => x.ref === `refs/tags/${c}`)?.was ?? ""}`), `--force-with-lease=${marker}:${remote.get(marker) ?? ""}`];
    const specs = [...names.map((c) => (w.channels[c] ? `refs/tags/${c}:refs/tags/${c}` : `:refs/tags/${c}`)).filter((s) => !(s.startsWith(":") && !remote.get(s.slice(1)))), `${marker}:${marker}`];
    const r = await git(["push", "--atomic", "--porcelain", ...leases, "origin", ...specs], root, { timeoutMs: 180_000, env: { ...env, ...noBackgroundCleanupEnv() } });
    if (r.code !== 0) throw new Error(`origin refused the push: ${first(r)}`);
    return { ok: true, pushed: "pushed", channelsFrom };
  } catch (err) {
    await putBack(git, root, saved);
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}

/** A commit undoing `landed` (its tree back to `from`'s), on top of `landed`: an abandoned release's revert, made
 *  without a checkout (never a reset of the shared one). */
export async function revertCommit(git: Git, root: string, landed: string, from: string, subject: string): Promise<string | { error: string }> {
  const tree = await git(["rev-parse", `${from}^{tree}`], root);
  if (tree.code !== 0) return { error: `no tree at ${short(from)}` };
  const env = await identity(git, root);
  const r = await git([...NO_BACKGROUND_CLEANUP, "commit-tree", tree.stdout.trim(), "-p", landed, "-m", subject], root, { env });
  if (r.code !== 0) return { error: `couldn't make the revert: ${first(r)}` };
  return r.stdout.trim();
}
