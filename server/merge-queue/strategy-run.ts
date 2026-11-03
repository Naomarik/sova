import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeRequestInfo } from "../../shared/merge-queue";
import { type Git, isAncestor, revParse } from "./guard";
import { checkRequestText, draftRequest, type Drafter, loadRequestKit, type RequestInput, signed } from "./hosts/request-kit";
import { HOST_NAME, type HostAdapter, type HostKind, type HostRepo, hostOfHow, type RequestFacts, wireFacts } from "./hosts/types";
import { firstParents } from "./land";
import { fetchTarget, promoteDocs, pushBranch } from "./publish";
import type { RequestHow } from "./strategy";

/**
 * The steps of landing by request or by pushing the branch alone, after Sova's checks passed (al_3), each a value
 * the queue (queue.ts) records before it tells anyone: draft the request's text (q10, shown for review), publish
 * (the docs commit on the chat's own branch, the scan, the fast-forward push, then the request: looked for first, so
 * a retry never opens a second one, a17), read the host (merged, closed, still open), and a settings save published
 * as its own request (q7). Nothing here moves the target or touches the merge copy.
 */

export interface Hosting {
  adapter: HostAdapter;
  repo: HostRepo;
}

export interface PublishCtx {
  git: Git;
  root: string;
  target: string;
  /** The project's private names file (absent: none yet, so nothing is published). */
  namesFile?: string | undefined;
  /** The push hold (a release in progress). */
  holdFile?: string;
  /** The host (request strategies); null: origin isn't on a host Sova opens requests on. */
  host: Hosting | null;
}

/** Where a request strategy's host is: origin's repo, when it's that host's. */
export function hostMismatch(how: RequestHow, host: Hosting | null): string | null {
  const kind = hostOfHow(how);
  if (!kind) return null;
  if (!host) return `origin isn't on ${HOST_NAME[kind]}, so a ${kind === "github" ? "pull" : "merge"} request can't be opened there`;
  if (host.repo.kind !== kind) return `origin is on ${HOST_NAME[host.repo.kind]}, not ${HOST_NAME[kind]}: change How it lands`;
  return null;
}

// ---- the request's text (q10) -------------------------------------------------------------------

export type DraftTextOutcome = { ok: true; text: NonNullable<MergeRequestInfo["text"]>; folder?: string } | { ok: false; why: string };

/** The request's title and description, written by the project's request skill folder (or the plain default) and
 *  checked by it; shown to the user before anything is published. */
export async function draftText(o: { root: string; folder: string | null; how: RequestHow; input: Omit<RequestInput, "host">; drafter?: Drafter }): Promise<DraftTextOutcome> {
  const host: HostKind | null = hostOfHow(o.how);
  const kit = loadRequestKit(o.root, o.folder, host);
  if ("error" in kit) return { ok: false, why: kit.error };
  const d = await draftRequest({ kit, input: { ...o.input, host }, ...(o.drafter ? { draft: o.drafter } : {}) });
  if (!d.ok) {
    // A folder check that failed the last attempt is shown on the text, never a lock: the user may edit and Publish.
    const last = d.rejections.at(-1);
    const folderFailed = d.checks.some((c) => !c.ok && c.name !== "Sova") && !d.checks.some((c) => !c.ok && c.name === "Sova");
    if (last && folderFailed) return { ok: true, text: { title: last.text.title, body: last.text.body, draft: false, checks: d.checks.map((c) => ({ name: c.name, ok: c.ok, ...(c.why ? { why: c.why } : {}) })) }, ...(o.folder ? { folder: o.folder } : {}) };
    return { ok: false, why: d.why };
  }
  return { ok: true, text: { title: d.title, body: d.body, draft: false, checks: d.checks.map((c) => ({ name: c.name, ok: c.ok, ...(c.why ? { why: c.why } : {}) })) }, ...(o.folder ? { folder: o.folder } : {}) };
}

/**
 * The words the user left at Publish, checked again: Sova's own limits (one-line title, both present, the hosts'
 * lengths) and a folder check that can't run or runs past its time refuse; a folder check that fails is shown with
 * its reason and never stops Publish (the user's words are theirs).
 */
export async function checkPublishText(o: { root: string; folder: string | null; how: RequestHow; branch: string; base: string; text: { title: string; body: string } }): Promise<{ ok: true; title: string; body: string; checks: { name: string; ok: boolean; why?: string }[] } | { ok: false; why: string }> {
  const host = hostOfHow(o.how);
  const kit = loadRequestKit(o.root, o.folder, host);
  if ("error" in kit) return { ok: false, why: kit.error };
  const text = { title: o.text.title.trim(), body: signed(o.text.body) };
  const r = await checkRequestText(kit, text, { host, branch: o.branch, base: o.base, chatTitle: text.title });
  if (r.broken) return { ok: false, why: r.broken };
  const own = r.checks.find((c) => c.name === "Sova" && !c.ok);
  if (own) return { ok: false, why: `The request's text can't be sent: ${own.why ?? "it doesn't fit"}` };
  return { ok: true, ...text, checks: r.checks.map((c) => ({ name: c.name, ok: c.ok, ...(c.why ? { why: c.why } : {}) })) };
}

// ---- publishing ---------------------------------------------------------------------------------

export type PublishOutcome =
  /** Not now (the chat's folder isn't quiet): nothing published; try again later. */
  | { kind: "wait"; why: string }
  /** Refused: nothing (more) published. `blame` "branch": the branch's own commits (a scan hit, moved past the approved
   *  commit), so it goes back to its chat; "text": the request's words; "setup": sign-in, host, names, a hold. */
  | { kind: "refused"; why: string; blame: "branch" | "text" | "setup"; hits?: string[]; head?: string }
  /** Push branch only: the branch is on origin at `head`. */
  | { kind: "pushed"; head: string }
  /** The request is open (found or opened) with origin's branch at `head`. */
  | { kind: "requested"; head: string; request: RequestFacts; opened: boolean };

export interface PublishInput {
  how: RequestHow;
  branch: string;
  /** The approved commit, and the run's merge and tip (the tip carries the docs commit when drafts landed). */
  commit: string;
  mergeSha: string;
  tip: string;
  runId: string;
  worktree?: string | undefined;
  /** origin's target as the run tested on (the scan's lower bound). */
  base: string;
  /** The request's text (request strategies). */
  text?: { title: string; body: string } | undefined;
  /** The request already open for this entry, when one is (Land Again). */
  number?: number | undefined;
  /** Whether the chat that owns the branch is idle (nothing running): the docs commit is written into its folder only
   *  then (q9 = c). Absent: no chat is known, so none can be interrupted. */
  chatIdle?: (() => Promise<boolean>) | undefined;
}

/**
 * Publish one tested landing: the docs commit onto the chat's branch, then (step by step, each announced to `intent`
 * first so a stop in between is reconciled, never repeated blind) the scanned fast-forward push, then for a request
 * strategy the request: found first, opened only when none is.
 */
export async function publishEntry(ctx: PublishCtx, o: PublishInput, intent: (step: "push" | "create", head: string) => void): Promise<PublishOutcome> {
  const mismatch = hostMismatch(o.how, ctx.host);
  if (mismatch) return { kind: "refused", why: mismatch, blame: "setup" };
  if (ctx.host && o.how !== "push-branch") {
    const a = await ctx.host.adapter.auth(ctx.host.repo);
    if (!a.ok) return { kind: "refused", why: a.why, blame: "setup" };
  }
  if (o.tip !== o.mergeSha && o.chatIdle && !(await o.chatIdle())) return { kind: "wait", why: `the chat working on ${o.branch} is busy: the spec docs commit waits until it is idle` };
  const p = await promoteDocs(ctx.git, ctx.root, { branch: o.branch, commit: o.commit, mergeSha: o.mergeSha, tip: o.tip, runId: o.runId, worktree: o.worktree });
  if (p.kind === "wait") return p;
  if (p.kind === "refused") return { kind: "refused", why: p.why, blame: "branch" };
  const head = p.head;
  intent("push", head);
  const texts = o.text ? [{ label: "the request's title", text: o.text.title }, { label: "the request's description", text: o.text.body }] : undefined;
  const pushed = await pushBranch(ctx.git, ctx.root, { branch: o.branch, tip: head, base: o.base, namesFile: ctx.namesFile, ...(ctx.holdFile ? { holdFile: ctx.holdFile } : {}), ...(texts ? { texts } : {}) });
  if (pushed.state === "refused") {
    const textHit = !!pushed.hits?.length && pushed.hits.every((h) => h.startsWith("the request's"));
    const branchHit = !!pushed.hits?.length && !textHit;
    return { kind: "refused", why: pushed.why, blame: textHit ? "text" : branchHit ? "branch" : "setup", ...(pushed.hits ? { hits: pushed.hits } : {}), head };
  }
  if (o.how === "push-branch" || !ctx.host) return { kind: "pushed", head };
  intent("create", head);
  return openOrFind(ctx.host, { head: o.branch, base: ctx.target, text: o.text, number: o.number, pushedHead: head });
}

/** The request from `head` into `base`: the one already open (found first, a17), else a new one. An unknown outcome
 *  of create is looked for again before it is called a failure. */
async function openOrFind(h: Hosting, o: { head: string; base: string; text?: { title: string; body: string } | undefined; number?: number | undefined; pushedHead: string }): Promise<PublishOutcome> {
  const found = await h.adapter.find(h.repo, { head: o.head, base: o.base });
  if (!found.ok) return { kind: "refused", why: found.why, blame: "setup", head: o.pushedHead };
  if (found.request && (found.request.state === "open" || found.request.state === "draft")) return { kind: "requested", head: o.pushedHead, request: found.request, opened: false };
  if (!o.text) return { kind: "refused", why: "the request has no title and description yet", blame: "text", head: o.pushedHead };
  const made = await h.adapter.create(h.repo, { head: o.head, base: o.base, title: o.text.title, body: o.text.body });
  if (made.ok) return { kind: "requested", head: o.pushedHead, request: made.request, opened: true };
  const again = await h.adapter.find(h.repo, { head: o.head, base: o.base });
  if (again.ok && again.request && (again.request.state === "open" || again.request.state === "draft")) return { kind: "requested", head: o.pushedHead, request: again.request, opened: true };
  return { kind: "refused", why: made.why, blame: "setup", head: o.pushedHead };
}

/**
 * After a stop between "push" and "create" (or a create whose answer never came): what the host has now. origin's
 * branch at the head and a request open: requested; the branch there and no request: create may go (the caller still
 * has the text); else unknown, said and never retried blind.
 */
export async function reconcilePublish(ctx: PublishCtx, o: { how: RequestHow; branch: string; head: string; text?: { title: string; body: string } | undefined }): Promise<PublishOutcome> {
  const ls = await ctx.git(["ls-remote", "origin", `refs/heads/${o.branch}`], ctx.root, { timeoutMs: 60_000 });
  if (ls.code !== 0) return { kind: "wait", why: "origin can't be read to finish the publication Sova stopped in" };
  const remote = ls.stdout.split(/\s/)[0] || null;
  if (remote !== o.head) return { kind: "refused", why: `Sova stopped while publishing ${o.branch}, and origin's ${o.branch} is ${remote ? `at ${remote.slice(0, 7)}` : "not there"}: publish again`, blame: "setup" };
  if (o.how === "push-branch" || !ctx.host) return { kind: "pushed", head: o.head };
  return openOrFind(ctx.host, { head: o.branch, base: ctx.target, text: o.text, pushedHead: o.head });
}

// ---- following the request on the host -----------------------------------------------------------

export type PollOutcome =
  | { kind: "open"; request: RequestFacts }
  /** Merged on the host: `sha` the host's commit on the target; `parents` origin's first-parent commits the queue
   *  records as its own (so the push guard and the master-moved rule never read them as a hand commit). */
  | { kind: "merged"; request: RequestFacts; sha: string; parents: string[] }
  | { kind: "closed"; request: RequestFacts }
  | { kind: "unknown"; why: string };

/** What the host says about the request now; merged is the host's word, never git ancestry (t18). */
export async function pollRequest(ctx: PublishCtx, o: { number: number; from: string | null }): Promise<PollOutcome> {
  if (!ctx.host) return { kind: "unknown", why: "origin isn't on a host Sova follows" };
  const v = await ctx.host.adapter.view(ctx.host.repo, o.number);
  if (!v.ok) return { kind: "unknown", why: v.why };
  const r = v.request;
  if (r.state === "closed") return { kind: "closed", request: r };
  if (r.state !== "merged") return { kind: "open", request: r };
  const f = await fetchTarget(ctx.git, ctx.root, ctx.target);
  const origin = "sha" in f ? f.sha : null;
  const sha = r.mergeCommit ?? origin ?? "";
  const parents = origin && o.from && origin !== o.from && (await isAncestor(ctx.git, ctx.root, o.from, origin)) ? await firstParents(ctx.git, ctx.root, o.from, origin) : [];
  if (sha && !parents.includes(sha)) parents.push(sha);
  return { kind: "merged", request: r, sha, parents };
}

/** The entry's request record from the host's answer. */
export function requestInfo(prev: MergeRequestInfo, r: RequestFacts, at: string): MergeRequestInfo {
  return { ...prev, number: r.number, url: r.url, facts: wireFacts(r), checkedAt: at, ...(r.mergeCommit ? { mergeCommit: r.mergeCommit } : {}) };
}

// ---- a settings save on a project that lands by request (q7) ------------------------------------

export type SettingsPublishOutcome =
  | { state: "requested"; branch: string; commit: string; number: number; url: string }
  | { state: "pushed"; branch: string; commit: string }
  | { state: "refused"; why: string };

/**
 * A settings save as its own branch and request: `sova/settings-<YYYYMMDD-HHMM>` cut from origin's target, fetched
 * now, holding one commit with the settings file's new text (`textAt(base)`: the edit applied to origin's file),
 * scanned, pushed (never forced), then the request opened (a request strategy) or nothing more (push branch only).
 * Local main never moves: the change applies once the host merges it, and Update Local Main brings it here.
 */
export async function publishSettings(ctx: PublishCtx, o: { how: RequestHow; file: string; textAt: (base: string) => Promise<string>; message: string; body: string; at: Date; scratch: string }): Promise<SettingsPublishOutcome> {
  const mismatch = hostMismatch(o.how, ctx.host);
  if (mismatch) return { state: "refused", why: mismatch };
  if (ctx.host && o.how !== "push-branch") {
    const a = await ctx.host.adapter.auth(ctx.host.repo);
    if (!a.ok) return { state: "refused", why: a.why };
  }
  const f = await fetchTarget(ctx.git, ctx.root, ctx.target);
  if ("why" in f) return { state: "refused", why: f.why };
  const base = f.sha;
  const text = await o.textAt(base);
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = o.at;
  const branch = `sova/settings-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  mkdirSync(o.scratch, { recursive: true });
  const tmp = join(o.scratch, `settings-${process.pid}-${d.getTime()}`);
  writeFileSync(`${tmp}.json`, text);
  let commit: string;
  try {
    const blob = (await ctx.git(["hash-object", "-w", `${tmp}.json`], ctx.root)).stdout.trim();
    const env = { ...process.env, GIT_INDEX_FILE: `${tmp}.index` };
    for (const a of [["read-tree", base], ["update-index", "--add", "--cacheinfo", `100644,${blob},${o.file}`]]) {
      const r = await ctx.git(a, ctx.root, { env });
      if (r.code !== 0) return { state: "refused", why: `git ${a[0]} failed: ${r.stderr.trim().split("\n")[0] ?? ""}` };
    }
    const tree = (await ctx.git(["write-tree"], ctx.root, { env })).stdout.trim();
    const name = (await ctx.git(["config", "user.name"], ctx.root)).stdout.trim();
    const email = (await ctx.git(["config", "user.email"], ctx.root)).stdout.trim();
    const ident = name && email ? {} : { GIT_AUTHOR_NAME: name || "Sova merge queue", GIT_AUTHOR_EMAIL: email || "merge-queue@sova.invalid", GIT_COMMITTER_NAME: name || "Sova merge queue", GIT_COMMITTER_EMAIL: email || "merge-queue@sova.invalid" };
    const c = await ctx.git(["commit-tree", tree, "-p", base, "-m", o.message], ctx.root, { env: { ...process.env, ...ident } });
    if (c.code !== 0) return { state: "refused", why: `git commit-tree failed: ${c.stderr.trim().split("\n")[0] ?? ""}` };
    commit = c.stdout.trim();
  } finally {
    rmSync(`${tmp}.json`, { force: true });
    rmSync(`${tmp}.index`, { force: true });
  }
  if (!(await revParse(ctx.git, ctx.root, commit))) return { state: "refused", why: "the settings commit wasn't made" };
  const texts = [{ label: "the request's title", text: o.message }, { label: "the request's description", text: o.body }];
  const pushed = await pushBranch(ctx.git, ctx.root, { branch, tip: commit, base, namesFile: ctx.namesFile, ...(ctx.holdFile ? { holdFile: ctx.holdFile } : {}), texts });
  if (pushed.state === "refused") return { state: "refused", why: pushed.why };
  if (o.how === "push-branch" || !ctx.host) return { state: "pushed", branch, commit };
  const r = await openOrFind(ctx.host, { head: branch, base: ctx.target, text: { title: o.message, body: o.body }, pushedHead: commit });
  if (r.kind !== "requested") return { state: "refused", why: r.kind === "refused" || r.kind === "wait" ? r.why : "the request wasn't opened" };
  return { state: "requested", branch, commit, number: r.request.number, url: r.request.url };
}
