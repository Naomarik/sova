// Which repository a saved-sessions request works in (§chat.saved-sessions/remote): the git top level of the
// session's folder on the machine that holds it. A local folder gets a local git; a remote target's folder
// (its local placeholder, server/targets.ts) gets a git run on that target through runOnTarget, the same
// remote command path the rest of the session uses, so saving, listing, fetching, previewing and continuing
// read and write the repository on that host.
//
// The remote runner frames each git: stdin travels base64 (inline when small, else uploaded in chunks to a
// scratch file in the far repository's git dir), and stdout comes back base64 in chunks read from a scratch
// file there, so neither the command line nor the transport's output cap bounds a transcript's size.
import { randomBytes } from "node:crypto";
import { parseTargetCwd, runOnTarget, type TargetRunResult } from "../targets";
import { type GitOut, type GitRun, localGit } from "./git";

export interface RepoCtx {
  git: GitRun;
  /** The repository's top level, on the machine that holds it. */
  top: string;
  /** The folder's current branch; null on a detached HEAD. */
  branch: string | null;
  /** The key this computer's notes use for the project (the top level, prefixed with its target). */
  key: string;
  /** Set for a repository on a remote target. */
  target?: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Inline stdin up to this many base64 characters; more is uploaded in chunks of this size. */
const INLINE_INPUT = 96 * 1024;
/** Each chunk of output read back, in bytes before base64. */
const OUTPUT_CHUNK = 600 * 1024;

/** Far shell code in a folder on a target: runOnTarget's shape (tests run it with a local sh). */
export type FarRun = (target: string, command: string, remoteCwd: string, timeoutMs: number) => Promise<TargetRunResult>;

/** A GitRun on a remote target, in `remoteCwd`. */
export function remoteGit(target: string, remoteCwd: string, timeoutMs = 120_000, far: FarRun = runOnTarget): GitRun {
  const run = async (command: string): Promise<{ ok: true; stdout: string; stderr: string; code: number | null } | { ok: false; error: string }> => {
    const r = await far(target, command, remoteCwd, timeoutMs);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, stdout: r.run.stdout, stderr: r.run.stderr, code: r.run.code };
  };
  const nonce = () => randomBytes(6).toString("hex");
  const git: GitRun = async (args, opts = {}): Promise<GitOut> => {
    const tag = nonce();
    const scratch = `\${TMPDIR:-/tmp}/sova-saved-${tag}`;
    let feed = "";
    if (opts.input !== undefined) {
      const b64 = Buffer.from(opts.input, "utf8").toString("base64");
      if (b64.length <= INLINE_INPUT) feed = `printf '%s' ${q(b64)} | base64 -d | `;
      else {
        for (let at = 0; at < b64.length; at += INLINE_INPUT) {
          const up = await run(`printf '%s' ${q(b64.slice(at, at + INLINE_INPUT))} ${at === 0 ? ">" : ">>"} "${scratch}.in"`);
          if (!up.ok) return { code: 255, stdout: "", stderr: up.error };
          if (up.code !== 0) return { code: up.code ?? 255, stdout: "", stderr: up.stderr || "couldn't send the input" };
        }
        feed = `base64 -d "${scratch}.in" | `;
      }
    }
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${q(v)}`).join(" ");
    const cmd = `${feed}${env ? `env ${env} ` : ""}git ${args.map(q).join(" ")}`;
    const head = await run(
      `out="${scratch}.out"; ${cmd} >"$out" 2>"$out.e"; rc=$?; sz=$(wc -c <"$out" | tr -d ' '); ` +
        `printf '@@%s %s %s@@\\n' ${q(tag)} "$rc" "$sz"; head -c 4000 "$out.e" | base64 | tr -d '\\n'; printf '\\n'; ` +
        `head -c ${OUTPUT_CHUNK} "$out" | base64 | tr -d '\\n'; printf '\\n'; rm -f "$out.e" "${scratch}.in"; [ "$sz" -le ${OUTPUT_CHUNK} ] && rm -f "$out"; exit 0`,
    );
    if (!head.ok) return { code: 255, stdout: "", stderr: head.error };
    const lines = head.stdout.split("\n");
    const at = lines.findIndex((l) => l.startsWith(`@@${tag} `));
    if (at < 0) return { code: head.code ?? 255, stdout: "", stderr: (head.stderr || head.stdout).trim().split("\n").slice(-2).join(" ") || "the target didn't run git" };
    const [, rcText, sizeText] = /^@@\S+ (\d+) (\d+)@@$/.exec(lines[at]!) ?? [];
    const code = Number(rcText ?? 255);
    const size = Number(sizeText ?? 0);
    const stderr = Buffer.from(lines[at + 1] ?? "", "base64").toString("utf8");
    const parts = [Buffer.from(lines[at + 2] ?? "", "base64")];
    for (let off = OUTPUT_CHUNK; off < size; off += OUTPUT_CHUNK) {
      const more = await run(`tail -c +${off + 1} "${scratch}.out" | head -c ${OUTPUT_CHUNK} | base64 | tr -d '\\n'`);
      if (!more.ok || more.code !== 0) {
        await run(`rm -f "${scratch}.out"`);
        return { code: 255, stdout: "", stderr: more.ok ? more.stderr : more.error };
      }
      parts.push(Buffer.from(more.stdout.trim(), "base64"));
    }
    if (size > OUTPUT_CHUNK) await run(`rm -f "${scratch}.out"`);
    return { code, stdout: Buffer.concat(parts).toString("utf8"), stderr };
  };
  git.rm = async (path) => {
    await run(`rm -f -- ${q(path)}`);
  };
  return git;
}

/** The repository holding `cwd` (a local folder or a remote target's placeholder), or null when it is in none. */
export async function repoOf(cwd: string): Promise<RepoCtx | null> {
  const remote = parseTargetCwd(cwd);
  const probe = remote ? remoteGit(remote.target, remote.remoteCwd) : localGit(cwd);
  const top = await probe(["rev-parse", "--show-toplevel"]);
  const topPath = top.stdout.trim();
  if (top.code !== 0 || !topPath) return null;
  const git = remote ? remoteGit(remote.target, topPath) : localGit(topPath);
  const b = await probe(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return {
    git,
    top: topPath,
    branch: b.code === 0 && b.stdout.trim() ? b.stdout.trim() : null,
    key: remote ? `${remote.target}:${topPath}` : topPath,
    ...(remote ? { target: remote.target } : {}),
  };
}
