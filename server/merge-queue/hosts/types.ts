/**
 * The host side of the merge queue's ways of landing (GitHub pull requests, GitLab merge requests), provider-neutral.
 *
 * Sova talks to a host only through its own command-line tool (`gh`, `glab`), run by the server, never by a chat, with
 * the sign-in already on this computer: Sova never reads, asks for or stores a token. Every call is an argument array
 * (no shell), with no terminal prompt, a timeout, JSON output, and an error text that is sanitized and redacted before
 * anything shows or stores it.
 */

import type { HostFactsWire, HostKind, RequestChecks, RequestMergeable, RequestReview, RequestState } from "../../../shared/merge-queue-hosts";
import type { LandHow } from "../strategy";

export type { HostFactsWire, HostKind, LandHow, RequestChecks, RequestMergeable, RequestReview, RequestState };

/** The request kind each host opens, and back. */
export const HOW_OF_HOST: Readonly<Record<HostKind, "github-pr" | "gitlab-mr">> = { github: "github-pr", gitlab: "gitlab-mr" };
export const hostOfHow = (how: LandHow | undefined): HostKind | null => (how === "github-pr" ? "github" : how === "gitlab-mr" ? "gitlab" : null);

/** One repository on a host, read from a remote URL (credentials in it are dropped). */
export interface HostRepo {
  kind: HostKind;
  /** `github.com`, `gitlab.com`, `gitlab.example.com` (with `:port` when the URL had one). */
  host: string;
  /** `owner/repo`, or GitLab's `group/subgroup/repo`. */
  path: string;
  /** `https://<host>/<path>`. */
  web: string;
}

export type HostFailCode =
  /** The tool's sign-in is missing or expired: the exact refusal text (a11). */
  | "not-signed-in"
  /** The tool isn't installed (not on PATH). */
  | "no-cli"
  | "timeout"
  /** The request or repository isn't there (or this sign-in can't see it). */
  | "not-found"
  /** Anything else the host or tool refused; `why` says what, sanitized. */
  | "failed";

export interface HostFail {
  ok: false;
  code: HostFailCode;
  /** Sanitized: no ANSI, secrets redacted, a few lines at most. Safe to show and to store. */
  why: string;
}

export type HostResult<T> = ({ ok: true } & T) | HostFail;

/** What the host says about one pull or merge request, now. */
export interface RequestFacts {
  /** GitHub's PR number, GitLab's MR iid. */
  number: number;
  url: string;
  state: RequestState;
  checks: RequestChecks;
  review: RequestReview;
  mergeable: RequestMergeable;
  /** The request's head commit on the host. */
  headSha: string | null;
  headBranch: string;
  baseBranch: string;
  /** The commit the host's merge made (a merge, squash or rebase commit), when it says. "merged" is the host's word,
   *  never inferred from git ancestry (t18). */
  mergeCommit: string | null;
  mergedAt: string | null;
}

/** The facts as the queue stores and shows them. */
export function wireFacts(f: RequestFacts): HostFactsWire {
  return { state: f.state, checks: f.checks, review: f.review, mergeable: f.mergeable, ...(f.headSha ? { headSha: f.headSha } : {}) };
}

export interface CreateRequest {
  /** The branch the request comes from (pushed to the host already). */
  head: string;
  /** The branch it goes into. */
  base: string;
  title: string;
  body: string;
}

/** One host's tool, behind the same calls. Every call is safe to retry: nothing here opens a second request when the
 *  caller looks first (`find`) after an unknown outcome (a17). */
export interface HostAdapter {
  kind: HostKind;
  cli: "gh" | "glab";
  /** Whether this computer is signed in to the repo's host. The refusal is `signInFirst(kind, host)`. */
  auth(repo: HostRepo): Promise<HostResult<{}>>;
  /** The request from `head` into `base`: an open (or draft) one, or with `all` the newest in any state. */
  find(repo: HostRepo, q: { head: string; base: string; all?: boolean }): Promise<HostResult<{ request: RequestFacts | null }>>;
  /** Open a ready (not draft) request. */
  create(repo: HostRepo, req: CreateRequest): Promise<HostResult<{ request: RequestFacts }>>;
  /** Change an open request's title or description. */
  update(repo: HostRepo, number: number, change: { title?: string; body?: string }): Promise<HostResult<{}>>;
  view(repo: HostRepo, number: number): Promise<HostResult<{ request: RequestFacts }>>;
}

export const HOST_NAME: Readonly<Record<HostKind, string>> = { github: "GitHub", gitlab: "GitLab" };
export const CLI_OF: Readonly<Record<HostKind, "gh" | "glab">> = { github: "gh", gitlab: "glab" };
const DEFAULT_HOST: Readonly<Record<HostKind, string>> = { github: "github.com", gitlab: "gitlab.com" };

/** The refusal when the host's tool isn't signed in (a11): "Sign in to GitHub on this computer first (gh auth login)".
 *  A host other than github.com / gitlab.com names itself in the command. */
export function signInFirst(kind: HostKind, host: string = DEFAULT_HOST[kind]): string {
  const cli = CLI_OF[kind];
  return `Sign in to ${HOST_NAME[kind]} on this computer first (${cli} auth login${host === DEFAULT_HOST[kind] ? "" : ` --hostname ${host}`})`;
}

/** The refusal when the host's tool isn't installed. */
export function installFirst(kind: HostKind): string {
  return `${HOST_NAME[kind]}'s command-line tool (${CLI_OF[kind]}) isn't installed on this computer`;
}

/** The longest title and description Sova sends (GitLab caps titles at 255; GitHub bodies at 65536). */
export const TITLE_MAX = 255;
export const BODY_MAX = 60_000;

/** No request can open: origin isn't on a host Sova opens requests on, or there is no origin. */
export const NO_HOST_WORDS = "origin isn't on GitHub or GitLab, so Sova can't open a pull or merge request here";
export const NO_ORIGIN_WORDS = "This project has no remote named origin, so Sova can't open a pull or merge request here";
