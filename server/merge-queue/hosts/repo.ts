import { type CliRunner, realCli } from "./run";
import type { HostKind, HostRepo, LandHow } from "./types";

/**
 * Which host a remote is on, and the way of landing it suggests (a2). The suggestion is only shown ("Suggested from
 * origin"); nothing here changes a project's setting.
 */

/** A remote URL's host and path: `https://[user[:pw]@]host[:port]/path(.git)`, `ssh://[user@]host[:port]/path`,
 *  `git@host:path`. Credentials are dropped. → null for anything else (a local path, an ssh alias with no path). */
export function remoteParts(url: string): { host: string; path: string } | null {
  const u = url.trim();
  let host: string | undefined;
  let path: string | undefined;
  const scheme = /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?([^/:]+)(:\d+)?\/(.+)$/i.exec(u);
  if (scheme) {
    host = scheme[1]!;
    // An ssh port names how to connect, not the web host; an http(s) port is part of the web address.
    if (scheme[2] && /^https?:/i.test(u)) host += scheme[2];
    path = scheme[3];
  } else {
    const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(u);
    if (scp && scp[1]!.includes(".")) {
      host = scp[1];
      path = scp[2];
    }
  }
  if (!host || !path) return null;
  path = path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!/^[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)+$/.test(path) || path.split("/").some((p) => p === "." || p === "..")) return null;
  return { host: host.toLowerCase(), path };
}

const isGitHub = (host: string) => host === "github.com" || host === "www.github.com";
/** gitlab.com, or a host named like one (`gitlab.example.com`). Any other host counts only when glab is signed in to it. */
const looksGitLab = (host: string) => host === "gitlab.com" || /^gitlab\./.test(host);

/** The repo on a known host: github.com (owner/repo only), or a GitLab host. `gitlabHosts`: other hosts glab knows. */
export function repoOf(url: string, gitlabHosts: readonly string[] = []): HostRepo | null {
  const p = remoteParts(url);
  if (!p) return null;
  let kind: HostKind | null = null;
  if (isGitHub(p.host)) {
    if (p.path.split("/").length !== 2) return null;
    kind = "github";
  } else if (looksGitLab(p.host) || gitlabHosts.includes(p.host)) kind = "gitlab";
  if (!kind) return null;
  const host = p.host === "www.github.com" ? "github.com" : p.host;
  return { kind, host, path: p.path, web: `https://${host}/${p.path}` };
}

export interface LandingSuggestion {
  how: LandHow;
  /** The host the suggestion comes from, when any. */
  host?: string;
  repo?: HostRepo;
  /** Why, in a few words ("origin is on GitHub"). */
  why: string;
}

/** Whether glab has a sign-in for `host` (a self-hosted GitLab). Asks the tool; never reads its config. */
export async function glabKnowsHost(host: string, run: CliRunner = realCli): Promise<boolean> {
  const r = await run("glab", ["auth", "status", "--hostname", host.replace(/:\d+$/, "")], { timeoutMs: 15_000 });
  return r.code === 0 && !r.missing && !r.timedOut;
}

/**
 * The way of landing origin's host suggests (a2): github.com → a pull request, a GitLab host (gitlab.com, `gitlab.*`,
 * or any host glab is signed in to) → a merge request, no remote or another host → merge locally. A suggestion only.
 */
export async function suggestLanding(remote: string | null, opts: { run?: CliRunner } = {}): Promise<LandingSuggestion> {
  if (!remote) return { how: "local", why: "no remote named origin" };
  const p = remoteParts(remote);
  if (!p) return { how: "local", why: "origin isn't on a host Sova knows" };
  let repo = repoOf(remote);
  if (!repo && !isGitHub(p.host) && (await glabKnowsHost(p.host, opts.run))) repo = repoOf(remote, [p.host]);
  if (!repo) return { how: "local", host: p.host, why: `origin is on ${p.host}, a host Sova doesn't open requests on` };
  return repo.kind === "github"
    ? { how: "github-pr", host: repo.host, repo, why: "origin is on GitHub" }
    : { how: "gitlab-mr", host: repo.host, repo, why: `origin is on GitLab (${repo.host})` };
}
