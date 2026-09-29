import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildCommit, type Machine, realMachine } from "./details-collect";
import { advertiseCommit, primeFingerprint } from "./hello";

// The build this process runs (§mesh.peers/resync, §mesh.details/fields): its commit, whether the
// checkout's tracked files differed from it, and its protocol hash, recorded together once at boot
// by an explicit call from server/index.ts (never at import). A checkout's HEAD moves while the
// server keeps the code it loaded, and a protocol hash can match several commits, so neither can
// name the running build later; this record can. The commit is then verified against the running
// protocol: `git show <commit>:shared/protocol.ts` must hash to it.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GIT_TIMEOUT_MS = 10_000;

export interface BootBuild {
  /** BUILD_COMMIT, else the checkout's HEAD, at boot; absent when neither says. */
  commit?: string;
  /** The protocol fingerprint at boot (the hello's). */
  protocol: string;
  /** Tracked files differed from the commit at boot (untracked files don't count). null: not a
      git checkout (a git-archive deploy), or still being checked. */
  dirty: boolean | null;
  /** The commit's shared/protocol.ts hashes to `protocol`. null: not checked yet, or no git. */
  verified: boolean | null;
  /** Why this build can't be named; absent when it can. */
  blocked?: string;
}

/** Runs git in a directory; resolves stdout, or null when git fails. Injected by tests. */
export type Git = (args: string[], cwd: string) => Promise<Buffer | null>;

export const realGit: Git = (args, cwd) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "buffer", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });

const hash16 = (b: Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 16);

/** The checks a boot record gets once git has answered: dirty, verified, and the reason it is blocked. */
export async function checkBuild(commit: string | undefined, protocol: string, root: string, git: Git): Promise<Pick<BootBuild, "dirty" | "verified" | "blocked">> {
  if (!commit) return { dirty: null, verified: null, blocked: "This host's build has no commit on record (no BUILD_COMMIT file and no .git)." };
  const status = await git(["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"], root);
  const dirty = status === null ? null : status.toString().trim() !== "";
  const file = await git(["show", `${commit}:shared/protocol.ts`], root);
  const verified = file === null ? null : hash16(file) === protocol;
  const short = commit.slice(0, 12);
  if (dirty) return { dirty, verified, blocked: `This host booted with uncommitted changes on top of ${short}, so its build can't be named.` };
  if (verified === null) return { dirty, verified, blocked: `This checkout can't read ${short}, so this host's build can't be checked.` };
  if (!verified) return { dirty, verified, blocked: `This host's protocol doesn't match ${short}; restart it on a clean checkout.` };
  return { dirty, verified };
}

let record: BootBuild | null = null;
let checked: Promise<BootBuild> | null = null;

/**
 * Record this process's build now: the commit and the protocol at once (and the hello starts
 * advertising the commit), then git's checks in the background. Call once, at boot.
 */
export function captureBootBuild(opts: { root?: string; machine?: Machine; git?: Git } = {}): Promise<BootBuild> {
  const root = opts.root ?? ROOT;
  const protocol = primeFingerprint();
  const commit = buildCommit(opts.machine ?? realMachine, root);
  const own: BootBuild = { ...(commit ? { commit } : {}), protocol, dirty: null, verified: null, blocked: "Checking this host's build…" };
  record = own;
  advertiseCommit(commit);
  checked = checkBuild(commit, protocol, root, opts.git ?? realGit)
    .catch((): Pick<BootBuild, "dirty" | "verified" | "blocked"> => ({ dirty: null, verified: null, blocked: "This host's build couldn't be checked." }))
    .then((c) => {
      const next: BootBuild = { ...(commit ? { commit } : {}), protocol, ...c };
      if (record === own) record = next;
      return next;
    });
  return checked;
}

/** The boot record; null before captureBootBuild ran (tests, or a server that never called it). */
export const bootBuild = (): BootBuild | null => record;

/** The boot record once git's checks are done. */
export const bootBuildChecked = (): Promise<BootBuild | null> => checked ?? Promise.resolve(null);

/** Tests: forget the record. */
export function resetBootBuild(): void {
  record = null;
  checked = null;
  advertiseCommit(undefined);
}
