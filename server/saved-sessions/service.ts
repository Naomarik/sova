// Saved sessions, the server's half (§chat/saved-sessions): saving a chat as a cleaned copy on the project's
// sova/saved-sessions branch, listing and previewing what that branch holds, continuing one into a blank
// session, and the main-branch recovery. Harness-neutral: the transcript's export and import are the
// harness's (HarnessBundles, pi's in server/harness/pi/bundle.ts), the branch's git is ./git.ts, and the
// repository may be on a remote target (./repo.ts).
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type { BundleExport, BundleWorker, HEntry, StateKind } from "../../shared/harness";
import {
  CONTINUATION_NOTE_TYPE,
  type ContinuationDetails,
  type ContinueModel,
  type ContinueRequest,
  type ContinueResponse,
  type PruneResponse,
  type PurgeFromMainResponse,
  type RemoveFromMainResponse,
  ROOT_TOKEN,
  SAVE_LIMIT_BYTES,
  type SavedBy,
  type SavedForSessionResponse,
  type SavedListResponse,
  type SavedOnMainResponse,
  type SavedPreviewMessage,
  type SavedPreviewResponse,
  type SavedSessionCard,
  type SavedSessionRow,
  type SavedWorkerSummary,
  SAVED_CARD_FILE,
  SAVED_README_FILE,
  SAVED_SESSION_MARKER,
  SAVED_SESSIONS_BRANCH,
  SAVED_SESSIONS_DIR,
  SAVED_TRANSCRIPT_FILE,
  type SavePrepareResponse,
  type SaveRequest,
  type SaveResponse,
  type SaveReviewItem,
  type WorktreeOfferItem,
  type WorktreesResponse,
  worktreeToken,
} from "../../shared/session-bundle";
import { appendNoteToClosedFile, piBundles } from "../harness/pi/bundle";
import { readBranch } from "../harness/pi/reader";
import { appendToClosedFile } from "../harness/pi/state";
import { SAVED_LINEAGE, WORKTREES } from "../harness/state-kinds";
import { stateView } from "../harness/state-view";
import { getSessionSummary } from "../sessions-index";
import { worktreesOf } from "../worktrees-state";
import { Cleaner, pathRoots, restorer } from "./clean";
import { applySaved, commitChange, fetchSaved, type GitRun, isOid, listTree, localGit, readBlobs, readPath, refSha, remoteUrl, savedRemote, savedTip } from "./git";
import { type RepoCtx, repoOf } from "./repo";
import { acceptPublicWarning, badgeOf, markSavedSeen, projectPrefs, publicWarningAccepted, seenRevs, setProjectPrefs } from "./store";

// ---- what the routes inject (the chat and model plumbing lives in the server) ------------------------

/** The server's side of a session's runtime that this module needs, injected by the routes. */
export interface SessionHooks {
  /** Whether a TUI holds the session (Sova must never write to it). */
  liveElsewhere(path: string): boolean;
  /** Append a state record to the session, through its held chat when there is one, else to its closed file. */
  appendState<T>(path: string, kind: StateKind<T>, data: T): Promise<void>;
  /** Append a note to the session (its held chat's, else its closed file); `display` false hides its row. */
  appendNote(path: string, noteType: string, text: string, display?: boolean): Promise<void>;
  /** Give the session this title, as Sova titles sessions (its title store). */
  setTitle(sessionId: string, title: string): void;
  /** Close the chat holding `path` (if any), so its file can be written; refuses (throws) mid-turn. */
  closeForImport(path: string): Promise<void>;
  /** After the import: mark the file as this server's write, and let clients reload it. */
  imported(path: string): void;
  /** Models this computer can run (with sign-in, allowed by the model policy), as "provider/id" with windows. */
  models(): Promise<{ ref: string; window: number | null }[]>;
  /** The model a new session here starts on (the session's own pick, else the default), "provider/id". */
  defaultModel(path: string): Promise<string | null>;
}

// ---- paths on the branch -----------------------------------------------------------------------------

const BUNDLE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const dirOf = (bundleId: string) => `${SAVED_SESSIONS_DIR}/${bundleId}`;
const cardPath = (bundleId: string) => `${dirOf(bundleId)}/${SAVED_CARD_FILE}`;
const transcriptPath = (bundleId: string) => `${dirOf(bundleId)}/${SAVED_TRANSCRIPT_FILE}`;

/** Clip for the tool-output trim: head and tail characters kept of each long result. */
export const TRIM = { headChars: 4000, tailChars: 2000 };
/** How long a prepared save is kept for its Save. */
const PREPARED_TTL_MS = 30 * 60 * 1000;
/** Continue starts from the summary when the history fills more than this much of the window. */
const FIT = 0.9;

// ---- the card ------------------------------------------------------------------------------------------

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A card read from the branch, checked field by field; null when it isn't one. */
export function parseCard(text: string | null | undefined): SavedSessionCard | null {
  if (!text) return null;
  let c: any;
  try {
    c = JSON.parse(text);
  } catch {
    return null;
  }
  if (!c || typeof c !== "object" || c.format !== SAVED_SESSION_MARKER) return null;
  if (!str(c.bundleId) || !BUNDLE_ID.test(c.bundleId) || !Number.isInteger(c.rev) || c.rev < 1) return null;
  if (!str(c.title) || !c.savedBy || !str(c.savedBy.name) || !str(c.savedAt)) return null;
  if (!Array.isArray(c.branches) || !c.branches.every(str)) return null;
  if (!num(c.bytes) || !num(c.approxTokens) || !c.counts || !num(c.counts.messages)) return null;
  if (!Array.isArray(c.workers)) c.workers = [];
  return c as SavedSessionCard;
}

/** The README beside each card: readable on a code host, carrying the marker. */
export function readmeOf(card: SavedSessionCard, last: SavedPreviewMessage[]): string {
  const lines = [
    `# ${card.title}`,
    "",
    `A saved Sova session (${SAVED_SESSION_MARKER}), version ${card.rev}. Saved by ${card.savedBy.name} on ${card.savedAt.slice(0, 10)}${card.model ? ` with ${card.model.provider}/${card.model.id}` : ""}.`,
    "",
    `Branches: ${card.branches.join(", ")}`,
    "",
  ];
  if (card.note) lines.push("## Note", "", card.note, "");
  if (last.length) {
    lines.push("## Last exchange", "");
    for (const m of last) lines.push(`**${m.role === "user" ? "User" : "Agent"}:** ${m.text.length > 1200 ? `${m.text.slice(0, 1200)} […]` : m.text}`, "");
  }
  if (card.workers.length) {
    lines.push("## Subagents and teams (ran on the original computer)", "");
    for (const w of card.workers) lines.push(`- ${w.team ? `${w.team} · ` : ""}${w.role}: ${w.outcome}. Task: ${w.task.split("\n")[0]}`);
    lines.push("");
  }
  lines.push(
    "## Continue it",
    "",
    "In Sova, start a new session in this repository. The new-session screen lists saved sessions (Get Saved Sessions fetches this branch); press Continue on this one.",
    "",
    "Continue only sessions from people you trust: the agent takes what this conversation says as true.",
    "",
  );
  return lines.join("\n");
}

// ---- version (rev) logic ---------------------------------------------------------------------------------

export type RevDecision =
  | { ok: true; bundleId: string; rev: number; previous: NonNullable<SavedSessionCard["previous"]> }
  | { ok: false; theirs: { rev: number; savedBy: SavedBy; savedAt: string } };

/**
 * Which saved session and version a save writes (§chat.saved-sessions/resave). With no lineage: a new saved
 * session at version 1. With one: the same saved session at the next version, unless the branch tip already
 * holds a newer version than the one this session saved or came from, which asks: a new copy (new id, version
 * 1) or replace theirs (their version + 1). A lineage whose saved session is gone from the tip writes the next
 * version of it again.
 */
export function decideRev(lineage: { bundleId: string; rev: number } | null, onTip: SavedSessionCard | null, onConflict: "new-copy" | "replace" | undefined, newId: () => string): RevDecision {
  if (!lineage || onConflict === "new-copy") return { ok: true, bundleId: newId(), rev: 1, previous: [] };
  const history = onTip ? [{ rev: onTip.rev, savedBy: onTip.savedBy, savedAt: onTip.savedAt }, ...(onTip.previous ?? [])] : [];
  if (onTip && onTip.rev > lineage.rev && onConflict !== "replace") return { ok: false, theirs: { rev: onTip.rev, savedBy: onTip.savedBy, savedAt: onTip.savedAt } };
  return { ok: true, bundleId: lineage.bundleId, rev: Math.max(onTip?.rev ?? 0, lineage.rev) + 1, previous: history.slice(0, 50) };
}

// ---- reading a session -------------------------------------------------------------------------------------

/** The text of a message's blocks (text only). */
function textOf(h: HEntry): string {
  if (h.kind !== "user" && h.kind !== "assistant") return "";
  return h.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
}

/** The last few user and assistant messages with text, oldest first. */
export function lastMessages(entries: readonly HEntry[], n = 6): SavedPreviewMessage[] {
  const out: SavedPreviewMessage[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < n; i--) {
    const h = entries[i]!;
    if (h.kind !== "user" && h.kind !== "assistant") continue;
    const text = textOf(h);
    if (text) out.unshift({ role: h.kind, text: text.length > 4000 ? `${text.slice(0, 4000)} […]` : text, ...(h.at ? { at: h.at } : {}) });
  }
  return out;
}

async function savedByOf(git: GitRun): Promise<SavedBy> {
  const name = (await git(["config", "user.name"])).stdout.trim();
  const email = (await git(["config", "user.email"])).stdout.trim();
  let fallback = "someone";
  try {
    fallback = userInfo().username || fallback;
  } catch {
    /* no passwd entry */
  }
  return { name: name || fallback, ...(email ? { email } : {}) };
}

/** Local branches, the saved-sessions branch aside. */
async function localBranches(git: GitRun): Promise<string[]> {
  const r = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter((b) => b && b !== SAVED_SESSIONS_BRANCH) : [];
}

/** The main branch: the remote's HEAD, else master, else main. */
export async function mainBranch(git: GitRun): Promise<string | null> {
  const remote = await savedRemote(git);
  if (remote) {
    const head = await git(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
    const name = head.stdout.trim().replace(new RegExp(`^${remote}/`), "");
    if (head.code === 0 && name && (await refSha(git, `refs/heads/${name}`))) return name;
  }
  for (const b of ["master", "main"]) if (await refSha(git, `refs/heads/${b}`)) return b;
  return null;
}

/** Every worktree of the repository, by branch. */
async function worktreesByBranch(git: GitRun): Promise<Map<string, string>> {
  const r = await git(["worktree", "list", "--porcelain"]);
  const out = new Map<string, string>();
  let path: string | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line.startsWith("branch refs/heads/") && path) out.set(line.slice(18), path);
  }
  return out;
}

/** A session's tracked worktrees (any status), from its own state. */
function trackedTrees(branch: readonly HEntry[]): { path: string; branch: string; status: string }[] {
  return (worktreesOf(branch)?.trees ?? []).map((t) => ({ path: t.path, branch: t.branch, status: t.status }));
}

// ---- prepare and save ------------------------------------------------------------------------------------------

interface Prepared {
  path: string;
  cwd: string;
  repoKey: string;
  createdAt: number;
  reviewIds: Set<string>;
  imageIds: Set<string>;
  lineage: { bundleId: string; rev: number; title: string } | null;
}
const prepared = new Map<string, Prepared>();

/** The session a prepared save is of (the review's image route), or null when it expired. */
export function preparedPath(prepareId: string): string | null {
  sweepPrepared();
  return prepared.get(prepareId)?.path ?? null;
}

function sweepPrepared(now = Date.now()): void {
  for (const [id, p] of prepared) if (now - p.createdAt > PREPARED_TTL_MS) prepared.delete(id);
}

export type Refusal<R extends string> = { ok: false; reason: R; message: string };
const refuse = <R extends string>(reason: R, message: string): Refusal<R> => ({ ok: false, reason, message });

interface SessionCtx {
  path: string;
  cwd: string;
  title: string;
  repo: RepoCtx;
  branch: HEntry[];
  trees: { path: string; branch: string; status: string }[];
  home: string | null;
}

async function sessionCtx(path: string): Promise<SessionCtx | Refusal<"not-a-repo" | "invalid">> {
  const summary = await getSessionSummary(path);
  if (!summary) return refuse("invalid", "That session can't be found.");
  const repo = await repoOf(summary.cwd);
  if (!repo) return refuse("not-a-repo", "Only a session in a folder inside a git repository can be saved.");
  const branch = await readBranch(path);
  return { path, cwd: summary.cwd, title: summary.title && summary.title !== "Untitled" ? summary.title : "", repo, branch, trees: trackedTrees(branch), home: repo.target ? null : homedir() };
}

function cleanerFor(ctx: SessionCtx, decisions?: Record<string, "keep" | "remove">): Cleaner {
  const trees = ctx.trees.filter((t) => t.path);
  return new Cleaner({
    roots: pathRoots(ctx.repo.top, trees, ctx.home ?? ""),
    envDirs: ctx.repo.target ? [] : [ctx.repo.top, ...trees.map((t) => t.path)],
    ...(decisions ? { decisions } : {}),
  });
}

function cleanWorkers(workers: BundleWorker[], c: Cleaner): SavedWorkerSummary[] {
  const site = { entryId: null, where: "note" as const };
  return workers.map((w) => ({
    kind: w.kind,
    ...(w.team ? { team: c.clean(w.team, site) } : {}),
    role: c.clean(w.role, site),
    task: c.clean(w.task, site),
    outcome: c.clean(w.outcome, site),
    ...(w.report ? { report: c.clean(w.report, site) } : {}),
  }));
}

/** POST /api/saved-sessions/prepare: the cleaned copy's report, nothing written. */
export async function prepareSave(path: string): Promise<SavePrepareResponse | Refusal<"not-a-repo" | "invalid" | "internal">> {
  sweepPrepared();
  const ctx = await sessionCtx(path);
  if ("ok" in ctx) return ctx;
  const cleaner = cleanerFor(ctx);
  const base = { includeThinking: false, clean: cleaner.clean, dropImages: new Set<string>() as ReadonlySet<string>, placeholderCwd: ROOT_TOKEN };
  const whole = piBundles.exportSession(path, { ...base, scope: "whole" });
  if (!whole.ok) return refuse(whole.reason === "not_found" ? "invalid" : whole.reason === "internal" ? "internal" : "invalid", whole.message);
  const sizeOf = (o: Partial<Parameters<typeof piBundles.exportSession>[1]>): number | null => {
    const c = cleanerFor(ctx);
    const r = piBundles.exportSession(path, { ...base, clean: c.clean, scope: "whole", ...o });
    return r.ok ? r.value.bytes : null;
  };
  const wholeTrimmed = sizeOf({ trimToolOutput: TRIM }) ?? whole.value.bytes;
  const since = whole.value.hasSummary ? sizeOf({ scope: "since-summary" }) : null;
  const sinceTrimmed = whole.value.hasSummary ? sizeOf({ scope: "since-summary", trimToolOutput: TRIM }) : null;
  const workers = cleanWorkers(whole.value.workers, cleaner);
  const review: SaveReviewItem[] = [
    ...cleaner.review.values(),
    ...whole.value.images.map((img) => ({ id: img.id, kind: "image" as const, where: siteName(img.where), ...(img.at ? { at: img.at } : {}), excerpt: "", mimeType: img.mimeType, bytes: img.bytes })),
  ];
  const latest = stateView(ctx.branch).latest(SAVED_LINEAGE)?.data ?? null;
  const lineage: { bundleId: string; rev: number; title: string } | null = latest ? { bundleId: latest.bundleId, rev: latest.rev, title: latest.title ?? ctx.title } : null;
  const git = ctx.repo.git;
  const remoteName = await savedRemote(git);
  const url = remoteName ? await remoteUrl(git, remoteName) : null;
  const tracked = ctx.trees.filter((t) => t.status !== "dropped").map((t) => t.branch);
  // Saving again: the saved session's own branches (and note) as the tip has them, then this session's.
  const tip = lineage ? await savedTip(git, remoteName) : null;
  const previous = lineage && tip ? parseCard(await readPath(git, tip.sha, cardPath(lineage.bundleId))) : null;
  const branches = [...new Set(tracked.length ? tracked : ctx.repo.branch ? [ctx.repo.branch] : [])];
  const prepareId = randomUUID();
  prepared.set(prepareId, {
    path,
    cwd: ctx.cwd,
    repoKey: ctx.repo.key,
    createdAt: Date.now(),
    reviewIds: new Set(cleaner.review.keys()),
    imageIds: new Set(whole.value.images.map((i) => i.id)),
    lineage,
  });
  return {
    prepareId,
    title: lineage?.title || ctx.title,
    branches,
    knownBranches: await localBranches(git),
    sizes: { whole: whole.value.bytes, wholeTrimmed, sinceSummary: since, sinceSummaryTrimmed: sinceTrimmed },
    // Before any decision nothing under review counts as kept or removed: the review lists them.
    cleaning: cleaner.cleaning({ imagesKept: 0, imagesRemoved: 0, thinkingDropped: whole.value.thinkingDropped, toolOutputsTrimmed: 0 }),
    review,
    lineage: lineage ? { ...lineage, ...(previous ? { title: previous.title } : {}), ...(previous?.note ? { note: previous.note } : {}), branches: previous?.branches ?? [] } : null,
    push: {
      remote: remoteName && url ? { name: remoteName, url } : null,
      remembered: projectPrefs(ctx.repo.key).push === true,
      publicWarningAccepted: url ? publicWarningAccepted(url) : false,
    },
    workers,
  };
}

const siteName = (where: string) => ({ user: "You", assistant: "Agent", "tool-call": "tool call", "tool-result": "tool result", note: "message", summary: "summary", setting: "setting" })[where] ?? where;

class ConflictStop extends Error {
  constructor(readonly theirs: { rev: number; savedBy: SavedBy; savedAt: string }) {
    super("conflict");
  }
}

/** POST /api/saved-sessions/save. */
export async function save(req: SaveRequest, hooks: Pick<SessionHooks, "appendState" | "liveElsewhere">): Promise<SaveResponse> {
  sweepPrepared();
  const prep = prepared.get(req.prepareId);
  if (!prep || prep.path !== req.path) return refuse("expired", "That save was prepared too long ago. Open Save Session again.");
  const title = typeof req.title === "string" ? req.title.trim() : "";
  if (!title || title.length > 200) return refuse("invalid", "Give the saved session a title (up to 200 characters).");
  const branches = Array.isArray(req.branches) ? [...new Set(req.branches.filter((b): b is string => typeof b === "string" && !!b.trim() && !/[\s~^:?*[\\]/.test(b)).map((b) => b.trim()))] : [];
  if (!branches.length) return refuse("invalid", "Name at least one branch it belongs to.");
  if (req.scope !== "whole" && req.scope !== "since-summary") return refuse("invalid", "Pick how much history to save.");
  const decisions = req.decisions && typeof req.decisions === "object" ? req.decisions : {};
  const needed = [...prep.reviewIds, ...(req.includeImages ? prep.imageIds : [])];
  const undecided = needed.filter((id) => decisions[id] !== "keep" && decisions[id] !== "remove");
  if (undecided.length) return refuse("undecided", `Decide Keep or Remove for ${undecided.length} more item${undecided.length === 1 ? "" : "s"} in the review.`);
  const ctx = await sessionCtx(req.path);
  if ("ok" in ctx) return refuse(ctx.reason, ctx.message);
  const git = ctx.repo.git;
  const remoteName = await savedRemote(git);
  const url = remoteName ? await remoteUrl(git, remoteName) : null;
  if (req.push && !remoteName) return refuse("invalid", "This repository has no remote to push to.");
  if (req.push && url && !publicWarningAccepted(url) && req.acceptPublicWarning !== true)
    return refuse("public-warning", `${url} may be public. Anyone who can read it will be able to read this conversation.`);
  const cleaner = cleanerFor(ctx, decisions);
  const removedImages = new Set([...prep.imageIds].filter((id) => decisions[id] === "remove"));
  const exported = piBundles.exportSession(req.path, {
    scope: req.scope,
    includeThinking: false,
    clean: cleaner.clean,
    dropImages: req.includeImages ? removedImages : "all",
    ...(req.trimToolOutput ? { trimToolOutput: TRIM } : {}),
    placeholderCwd: ROOT_TOKEN,
  });
  if (!exported.ok) return refuse(exported.reason === "too_big" ? "too-big" : exported.reason === "internal" ? "internal" : "invalid", exported.message);
  const ex: BundleExport = exported.value;
  if (ex.bytes > SAVE_LIMIT_BYTES)
    return refuse("too-big", `It is ${(ex.bytes / 1024 / 1024).toFixed(1)} MB after cleaning, over the ${SAVE_LIMIT_BYTES / 1024 / 1024} MB limit. Save only what the agent sees now, or trim long tool output.`);
  const savedBy = await savedByOf(git);
  const head = await refSha(git, "HEAD");
  const imagesKept = req.includeImages ? ex.images.length - removedImages.size : 0;
  const workers = cleanWorkers(ex.workers, cleaner);
  const roots = [{ token: ROOT_TOKEN }, ...ctx.trees.filter((t) => t.path && t.path !== ctx.repo.top).map((t) => ({ token: worktreeToken(t.branch), branch: t.branch }))];
  const read = piBundles.readBundle(ex.transcript, { maxBytes: SAVE_LIMIT_BYTES });
  const last = read.ok ? lastMessages(read.value.entries, 2) : [];
  try {
    const out = await applySaved(git, {
      push: req.push,
      remote: remoteName,
      message: "",
      plan: async (tip) => {
        const lin = prep.lineage;
        const onTip = lin ? parseCard(await tip.read(cardPath(lin.bundleId))) : null;
        const d = decideRev(lin, onTip, req.onConflict, () => randomUUID());
        if (!d.ok) throw new ConflictStop(d.theirs);
        const card: SavedSessionCard = {
          format: SAVED_SESSION_MARKER,
          bundleId: d.bundleId,
          rev: d.rev,
          title,
          ...(typeof req.note === "string" && req.note.trim() ? { note: req.note.trim().slice(0, 4000) } : {}),
          savedBy,
          savedAt: new Date().toISOString(),
          ...(d.previous.length ? { previous: d.previous } : {}),
          branches,
          ...(head ? { commit: head } : {}),
          harness: { name: "pi", sessionVersion: 3 },
          ...(ex.model ? { model: ex.model } : {}),
          ...(ex.thinking ? { thinking: ex.thinking } : {}),
          scope: req.scope,
          includes: { images: imagesKept > 0, thinking: false, trimmedToolOutput: !!req.trimToolOutput },
          counts: { entries: ex.entries, messages: ex.messages },
          bytes: ex.bytes,
          approxTokens: ex.approxTokens,
          roots,
          cleaning: cleaner.cleaning({ imagesKept, imagesRemoved: ex.images.length - imagesKept, thinkingDropped: ex.thinkingDropped, toolOutputsTrimmed: ex.toolOutputsTrimmed }),
          workers,
        };
        return {
          change: {
            write: {
              [cardPath(card.bundleId)]: `${JSON.stringify(card, null, 2)}\n`,
              [transcriptPath(card.bundleId)]: ex.transcript,
              [`${dirOf(card.bundleId)}/${SAVED_README_FILE}`]: readmeOf(card, last),
            },
            // A new version replaces the folder whole (git keeps the old files).
            removeFolders: [dirOf(card.bundleId)],
          },
          result: card,
          message: `Save session: ${title} (v${card.rev})`,
        };
      },
    });
    const card = out.result;
    if (req.push && url && req.acceptPublicWarning === true) acceptPublicWarning(url);
    setProjectPrefs(ctx.repo.key, { push: req.push === true });
    markSavedSeen(card.bundleId, card.rev);
    if (!hooks.liveElsewhere(req.path))
      await hooks.appendState(req.path, SAVED_LINEAGE, { bundleId: card.bundleId, rev: card.rev, how: "saved", at: card.savedAt, title: card.title, pushed: out.pushed }).catch(() => {});
    prepared.delete(req.prepareId);
    return { ok: true, card, commit: out.sha ?? "", pushed: out.pushed, ...(out.pushError ? { pushError: out.pushError } : {}) };
  } catch (err) {
    if (err instanceof ConflictStop)
      return { ok: false, reason: "conflict", message: `${err.theirs.savedBy.name} saved a newer version (v${err.theirs.rev}) on ${err.theirs.savedAt.slice(0, 10)}.`, theirs: err.theirs };
    return refuse("internal", err instanceof Error ? err.message : String(err));
  }
}

// ---- the Saved list of a session --------------------------------------------------------------------------------

export async function savedForSession(path: string): Promise<SavedForSessionResponse> {
  const summary = await getSessionSummary(path);
  const repo = summary ? await repoOf(summary.cwd) : null;
  const branch = summary ? await readBranch(path) : [];
  const saved = stateView(branch)
    .list(SAVED_LINEAGE)
    .map((r) => ({ bundleId: r.data.bundleId, rev: r.data.rev, title: r.data.title ?? "", savedAt: r.data.at, how: r.data.how, pushed: r.data.pushed === true }))
    .reverse();
  return { repo: !!repo, saved };
}

// ---- discovery ---------------------------------------------------------------------------------------------------

interface ReadTip {
  sha: string;
  cards: { card: SavedSessionCard | null; dir: string; bundleId: string; hasTranscript: boolean }[];
}

async function readTipCards(git: GitRun, sha: string): Promise<ReadTip> {
  const files = await listTree(git, sha);
  const byDir = new Map<string, { card?: string; transcript?: boolean }>();
  for (const f of files) {
    const m = /^sessions\/([^/]+)\/([^/]+)$/.exec(f.path);
    if (!m) continue;
    const e = byDir.get(m[1]!) ?? {};
    if (m[2] === SAVED_CARD_FILE) e.card = f.oid;
    if (m[2] === SAVED_TRANSCRIPT_FILE) e.transcript = true;
    byDir.set(m[1]!, e);
  }
  const blobs = await readBlobs(git, [...byDir.values()].map((e) => e.card ?? "").filter(isOid));
  return {
    sha,
    cards: [...byDir.entries()].map(([bundleId, e]) => ({ bundleId, dir: dirOf(bundleId), card: parseCard(e.card ? blobs.get(e.card) : null), hasTranscript: !!e.transcript })),
  };
}

/** GET /api/saved-sessions?cwd=: every saved session of the project, newest first. Never fetches. */
export async function listSaved(cwd: string): Promise<SavedListResponse> {
  const repo = await repoOf(cwd);
  if (!repo) return { repo: false, folderBranch: null, branches: [], sessions: [], hasRemote: false, remote: null, mergedBranches: [], pushOnSave: false };
  const git = repo.git;
  const remote = await savedRemote(git);
  const tip = await savedTip(git, remote);
  const seen = seenRevs();
  const rows: SavedSessionRow[] = [];
  if (tip) {
    for (const c of (await readTipCards(git, tip.sha)).cards) {
      if (!c.card) {
        rows.push({ bundleId: c.bundleId, rev: 0, title: c.bundleId, savedBy: { name: "" }, savedAt: "", branches: [], bytes: 0, approxTokens: 0, messages: 0, badge: null, unreadable: "Its card can't be read." });
        continue;
      }
      const k = c.card;
      rows.push({
        bundleId: k.bundleId,
        rev: k.rev,
        title: k.title,
        savedBy: k.savedBy,
        savedAt: k.savedAt,
        branches: k.branches,
        bytes: k.bytes,
        approxTokens: k.approxTokens,
        messages: k.counts.messages,
        badge: badgeOf(k.bundleId, k.rev, seen),
        ...(c.hasTranscript ? {} : { unreadable: "Its conversation is missing." }),
      });
    }
  }
  rows.sort((a, b) => (b.savedAt > a.savedAt ? 1 : b.savedAt < a.savedAt ? -1 : 0));
  const branches = [...new Set(rows.flatMap((r) => r.branches))].sort();
  const main = await mainBranch(git);
  const mainSha = main ? await refSha(git, `refs/heads/${main}`) : null;
  const mergedBranches: string[] = [];
  if (mainSha) {
    for (const b of branches) {
      if (b === main) continue;
      const sha = await refSha(git, `refs/heads/${b}`);
      if (sha && sha !== mainSha && (await git(["merge-base", "--is-ancestor", sha, mainSha])).code === 0) mergedBranches.push(b);
    }
  }
  const fetchedAt = projectPrefs(repo.key).fetchedAt;
  return {
    repo: true,
    folderBranch: repo.branch,
    branches,
    sessions: rows,
    hasRemote: !!remote,
    remote: remote ?? null,
    mergedBranches,
    pushOnSave: projectPrefs(repo.key).push === true,
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}

/** POST /api/saved-sessions/fetch: fetch only the saved-sessions branch, then list. */
export async function fetchAndList(cwd: string): Promise<({ ok: true } & SavedListResponse) | Refusal<"offline" | "no-remote" | "auth" | "no-saved-branch" | "internal">> {
  const repo = await repoOf(cwd);
  if (!repo) return refuse("no-remote", "That folder is not in a git repository.");
  const remote = await savedRemote(repo.git);
  if (!remote) return refuse("no-remote", "This repository has no remote to get saved sessions from.");
  let got: string | null;
  try {
    got = await fetchSaved(repo.git, remote);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/could not read|authentication|permission denied|denied|403|401/i.test(text)) return refuse("auth", `Couldn't sign in to ${remote}: ${text}`);
    if (/could not resolve|unable to access|timed out|connection|network|unreachable|offline/i.test(text)) return refuse("offline", `Couldn't reach ${remote}. Check the connection and try again.`);
    return refuse("internal", text);
  }
  setProjectPrefs(repo.key, { fetchedAt: new Date().toISOString() });
  if (!got) return refuse("no-saved-branch", `${remote} has no saved sessions yet.`);
  return { ok: true, ...(await listSaved(cwd)) };
}

async function readSaved(cwd: string, bundleId: string): Promise<{ repo: RepoCtx; card: SavedSessionCard; transcript: string } | Refusal<"not-found" | "invalid">> {
  if (!BUNDLE_ID.test(bundleId)) return refuse("not-found", "No such saved session.");
  const repo = await repoOf(cwd);
  if (!repo) return refuse("not-found", "That folder is not in a git repository.");
  const tip = await savedTip(repo.git);
  if (!tip) return refuse("not-found", "This repository has no saved sessions.");
  const card = parseCard(await readPath(repo.git, tip.sha, cardPath(bundleId)));
  if (!card) return refuse("invalid", "That saved session's card can't be read.");
  const transcript = await readPath(repo.git, tip.sha, transcriptPath(bundleId));
  if (transcript === null) return refuse("invalid", "That saved session's conversation is missing.");
  return { repo, card, transcript };
}

/** The model Continue would use: the saved one when this computer can run it, else the session's default. */
async function chooseModel(card: SavedSessionCard, path: string, hooks: Pick<SessionHooks, "models" | "defaultModel">): Promise<{ model: ContinueModel; window: number | null }> {
  const models = await hooks.models().catch(() => []);
  const want = card.model ? `${card.model.provider}/${card.model.id}` : null;
  const hit = want ? models.find((m) => m.ref === want) : undefined;
  if (hit && card.model) return { model: { provider: card.model.provider, id: card.model.id, saved: true }, window: hit.window };
  const def = (await hooks.defaultModel(path).catch(() => null)) ?? models[0]?.ref ?? null;
  const slash = def ? def.indexOf("/") : -1;
  // `reason` gives only a cause beyond "not set up here" (which savedId already says).
  const savedId = want ? { savedId: want } : {};
  if (!def || slash <= 0) return { model: { provider: card.model?.provider ?? "", id: card.model?.id ?? "", saved: false, ...savedId, reason: "No model is set up on this computer." }, window: null };
  return { model: { provider: def.slice(0, slash), id: def.slice(slash + 1), saved: false, ...savedId }, window: models.find((m) => m.ref === def)?.window ?? null };
}

/** GET /api/saved-sessions/preview: read only; marks the version seen. */
export async function preview(cwd: string, bundleId: string, path: string | null, hooks: Pick<SessionHooks, "models" | "defaultModel">): Promise<SavedPreviewResponse | Refusal<"not-found" | "invalid">> {
  const got = await readSaved(cwd, bundleId);
  if ("ok" in got) return got;
  const read = piBundles.readBundle(got.transcript, { maxBytes: SAVE_LIMIT_BYTES });
  if (!read.ok) return refuse("invalid", read.message);
  const { model, window } = await chooseModel(got.card, path ?? "", hooks);
  markSavedSeen(got.card.bundleId, got.card.rev);
  const tokens = read.value.approxTokens;
  return {
    card: got.card,
    lastMessages: lastMessages(read.value.entries),
    model,
    ...(window && tokens > window * FIT ? { wontFit: { approxTokens: tokens, window, hasSummary: read.value.hasSummary } } : {}),
  };
}

// ---- continue ------------------------------------------------------------------------------------------------------

/** The continuation note: what the agent is told once, and the user sees at the top. */
export function continuationText(d: ContinuationDetails): string {
  const lines = [
    `This conversation was saved by ${d.savedBy.name} on ${d.savedAt.slice(0, 10)} ("${d.title}", version ${d.rev}) and is being continued here, on another computer.`,
  ];
  if (d.note) lines.push(`Their note: ${d.note}`);
  if (d.workers.length) {
    lines.push(
      "The subagents and teams this conversation mentions ran on the original computer and don't exist here: they can't be messaged, steered or waited on, and their ids mean nothing here. What they did:",
      ...d.workers.map((w) => `- ${w.team ? `${w.team} · ` : ""}${w.role} (${w.kind === "team-member" ? "team member" : "subagent"}): ${w.outcome}. Task: ${w.task}${w.report ? `\n  Report: ${w.report}` : ""}`),
      "Start new ones if they are needed.",
    );
  }
  if (d.fromSummary) lines.push("The history was bigger than this model can hold, so it starts from its last summary.");
  if (!d.model.saved)
    lines.push(`It was saved on ${d.model.savedId ?? "a model"}, which this computer can't run${d.model.reason ? ` (${d.model.reason.replace(/\.$/, "")})` : ""}; it continues on ${d.model.provider}/${d.model.id}.`);
  lines.push("Paths in the conversation have been mapped to this computer's checkout; check that files still match before relying on them.");
  return lines.join("\n");
}

async function worktreeOffer(repo: RepoCtx, branches: string[]): Promise<WorktreeOfferItem[]> {
  const trees = await worktreesByBranch(repo.git);
  const remote = await savedRemote(repo.git);
  const out: WorktreeOfferItem[] = [];
  for (const b of branches) {
    if (b === repo.branch) out.push({ branch: b, where: "here" });
    else if (trees.has(b)) out.push({ branch: b, where: "local", existingPath: trees.get(b)! });
    else if (await refSha(repo.git, `refs/heads/${b}`)) out.push({ branch: b, where: "local" });
    else if (remote && (await refSha(repo.git, `refs/remotes/${remote}/${b}`))) out.push({ branch: b, where: "remote", remoteRef: `${remote}/${b}` });
    else out.push({ branch: b, where: "missing" });
  }
  return out;
}

/** POST /api/saved-sessions/continue: the saved conversation into the blank session at `path`. */
export async function continueInto(req: ContinueRequest, hooks: SessionHooks): Promise<ContinueResponse> {
  if (!req || typeof req.path !== "string" || typeof req.cwd !== "string" || typeof req.bundleId !== "string") return refuse("invalid", "Expected { path, cwd, bundleId, rev }.");
  if (hooks.liveElsewhere(req.path)) return refuse("not-blank", "That session is open in a terminal. Continue in a new session here.");
  const summary = await getSessionSummary(req.path);
  if (!summary) return refuse("not-found", "That session can't be found.");
  const own = await readBranch(req.path);
  if (own.some((h) => h.kind === "user" || h.kind === "assistant" || h.kind === "tool-result" || h.kind === "compaction"))
    return refuse("not-blank", "That session already has a conversation. Continue a saved session in a new, empty session.");
  const got = await readSaved(req.cwd, req.bundleId);
  if ("ok" in got) return got.reason === "not-found" ? refuse("not-found", got.message) : refuse("invalid", got.message);
  const read = piBundles.readBundle(got.transcript, { maxBytes: SAVE_LIMIT_BYTES });
  if (!read.ok) return refuse(read.reason === "too_big" ? "too-big" : "invalid", read.message);
  const { model, window } = await chooseModel(got.card, req.path, hooks);
  const fromSummary = !!window && read.value.approxTokens > window * FIT && read.value.hasSummary;
  const trees = await worktreesByBranch(got.repo.git);
  const details: ContinuationDetails = {
    bundleId: got.card.bundleId,
    rev: got.card.rev,
    title: got.card.title,
    savedBy: got.card.savedBy,
    savedAt: got.card.savedAt,
    ...(got.card.note ? { note: got.card.note } : {}),
    workers: got.card.workers,
    ...(fromSummary ? { fromSummary } : {}),
    model,
  };
  try {
    await hooks.closeForImport(req.path);
  } catch (err) {
    return refuse("not-blank", err instanceof Error ? err.message : String(err));
  }
  const imported = piBundles.importInto(req.path, got.transcript, {
    maxBytes: SAVE_LIMIT_BYTES,
    restore: restorer(got.repo.top, (b) => trees.get(b) ?? null),
    fromSummary,
    ...(!model.saved && model.provider && model.id ? { model: { provider: model.provider, id: model.id } } : {}),
    note: { noteType: CONTINUATION_NOTE_TYPE, content: continuationText(details), details },
  });
  if (!imported.ok) return refuse(imported.reason === "too_big" ? "too-big" : imported.reason === "not_found" ? "not-found" : imported.reason === "internal" ? "internal" : "invalid", imported.message);
  appendToClosedFile(req.path, SAVED_LINEAGE, { bundleId: got.card.bundleId, rev: got.card.rev, how: "continued", at: new Date().toISOString(), title: got.card.title });
  hooks.imported(req.path);
  // The continued session goes by the saver's title, not its first message's (the store wins over both).
  hooks.setTitle(summary.id, got.card.title);
  markSavedSeen(got.card.bundleId, got.card.rev);
  return { ok: true, model, fromSummary, worktreeOffer: await worktreeOffer(got.repo, got.card.branches) };
}

/** POST /api/saved-sessions/worktrees: set up a worktree for each branch, track them in the session, and tell
    the agent where they are. A branch here gets a worktree on it; one only on the remote a new local branch
    from the remote's; an existing worktree is used as it is. */
export async function setUpWorktrees(path: string, branches: string[], hooks: Pick<SessionHooks, "appendState" | "appendNote" | "liveElsewhere">): Promise<WorktreesResponse | Refusal<"invalid" | "not-a-repo">> {
  if (hooks.liveElsewhere(path)) return refuse("invalid", "That session is open in a terminal.");
  const summary = await getSessionSummary(path);
  if (!summary) return refuse("invalid", "That session can't be found.");
  const repo = await repoOf(summary.cwd);
  if (!repo) return refuse("not-a-repo", "That folder is not in a git repository.");
  if (repo.target) return refuse("invalid", "Worktrees are set up only for sessions on this computer.");
  const git = repo.git;
  const offer = await worktreeOffer(repo, branches.filter((b) => typeof b === "string"));
  const created: WorktreesResponse["created"] = [];
  const failed: WorktreesResponse["failed"] = [];
  for (const o of offer) {
    if (o.where === "here" || o.where === "missing") {
      if (o.where === "missing") failed.push({ branch: o.branch, message: "That branch isn't on this computer or its remote." });
      continue;
    }
    if (o.existingPath) {
      created.push({ branch: o.branch, path: o.existingPath });
      continue;
    }
    const dir = join(dirname(repo.top), ".worktrees", `${basename(repo.top)}-${o.branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`);
    const args = o.where === "local" ? ["worktree", "add", dir, o.branch] : ["worktree", "add", "-b", o.branch, dir, o.remoteRef!];
    const r = await git(args);
    if (r.code !== 0) failed.push({ branch: o.branch, message: (r.stderr || r.stdout).trim().split("\n").slice(-1)[0] || "git worktree add failed" });
    else created.push({ branch: o.branch, path: dir });
  }
  if (created.length) {
    const current = worktreesOf(await readBranch(path))?.trees ?? [];
    const now = Date.now();
    const trees = [...current.filter((t) => !created.some((c) => c.path === t.path))];
    for (const c of created) {
      const head = (await refSha(git, `refs/heads/${c.branch}`)) ?? "";
      trees.push({ path: c.path, branch: c.branch, base: head, status: "active", session: summary.id, how: "attached", at: now });
    }
    await hooks.appendState(path, WORKTREES, { version: 1, trees });
    await hooks.appendNote(
      path,
      "sova-saved-session-worktrees",
      `Worktrees for this continued session are set up on this computer:\n${created.map((c) => `- ${c.branch}: ${c.path}`).join("\n")}\nThe session's folder stays ${summary.cwd} on its own branch.`,
      false,
    );
  }
  return { created, failed };
}

// ---- main-branch recovery and pruning ------------------------------------------------------------------------------

/** Folders in `ref`'s tree that hold a saved session's card (found by its marker, wherever they sit). */
async function cardsIn(git: GitRun, ref: string): Promise<{ dir: string; path: string }[]> {
  const r = await git(["grep", "-l", "-F", "-e", SAVED_SESSION_MARKER, ref, "--"]);
  if (r.code !== 0) return [];
  const out: { dir: string; path: string }[] = [];
  for (const line of r.stdout.split("\n")) {
    const p = line.startsWith(`${ref}:`) ? line.slice(ref.length + 1) : line;
    if (!p) continue;
    const dir = dirname(p);
    if (dir === ".") continue;
    const had = out.find((o) => o.dir === dir);
    // The card names the saved session (its title); a README or transcript beside it only places it.
    if (had) {
      if (basename(p) === SAVED_CARD_FILE) had.path = p;
      continue;
    }
    out.push({ dir, path: p });
  }
  return out;
}

/** GET /api/saved-sessions/on-main?cwd=. */
export async function onMain(cwd: string): Promise<SavedOnMainResponse> {
  const repo = await repoOf(cwd);
  if (!repo) return { mainBranch: null, found: [], purgeable: false };
  const git = repo.git;
  const main = await mainBranch(git);
  if (!main) return { mainBranch: null, found: [], purgeable: false };
  const hits = await cardsIn(git, `refs/heads/${main}`);
  const found: SavedOnMainResponse["found"] = [];
  for (const h of hits) {
    const card = h.path.endsWith(SAVED_CARD_FILE) ? parseCard(await readPath(git, `refs/heads/${main}`, h.path)) : null;
    found.push({ dir: h.dir, ...(card ? { bundleId: card.bundleId, title: card.title } : {}) });
  }
  // Gone from the tree but still in main's unpushed history (a Merge Anyway of a branch that added and then
  // deleted one): only the purge can take it out, and only before the push.
  for (const dir of await unpushedCardDirs(git, main)) if (!found.some((f) => f.dir === dir)) found.push({ dir, historyOnly: true });
  const plan = found.length ? await purgePlan(git, main, found.map((f) => f.dir)) : null;
  return { mainBranch: main, found, purgeable: !!plan, ...(plan ? { purge: { commits: plan.commits.length, backupBranch: plan.backup } } : {}) };
}

/** Folders whose files gained or lost the marker in main's unpushed commits (all of main with no upstream). */
async function unpushedCardDirs(git: GitRun, main: string): Promise<string[]> {
  const remote = await savedRemote(git);
  const upstream = remote ? await refSha(git, `refs/remotes/${remote}/${main}`) : null;
  const r = await git(["log", "--format=@%H", "--name-only", "--no-renames", "-S", SAVED_SESSION_MARKER, `refs/heads/${main}`, ...(upstream ? [`^${upstream}`] : []), "--"]);
  if (r.code !== 0) return [];
  // Only where an unpushed commit BROUGHT the marker in (the file holds it after that commit): a deletion of
  // something already pushed is the checklist's, and a purge couldn't take it back anyway.
  const dirs = new Set<string>();
  let commit = "";
  for (const line of r.stdout.split("\n").map((l) => l.trim())) {
    if (!line) continue;
    if (line.startsWith("@")) {
      commit = line.slice(1);
      continue;
    }
    const dir = dirname(line);
    if (dir === "." || dirs.has(dir) || !commit) continue;
    const after = await readPath(git, commit, line);
    if (after !== null && after.includes(SAVED_SESSION_MARKER)) dirs.add(dir);
  }
  return [...dirs];
}

/** The unpushed commits a purge would rebuild, or null when any commit that brought a card in is pushed. */
async function purgePlan(git: GitRun, main: string, dirs: readonly string[]): Promise<{ commits: string[]; upstream: string | null; backup: string; head: string } | null> {
  const head = await refSha(git, `refs/heads/${main}`);
  if (!head) return null;
  const remote = await savedRemote(git);
  const upstream = remote ? await refSha(git, `refs/remotes/${remote}/${main}`) : null;
  if (upstream) {
    // Only these folders count: other saved sessions already in pushed history are the checklist's, not this purge's.
    if (!dirs.length) return null;
    const pushed = await git(["log", "--format=%H", "-S", SAVED_SESSION_MARKER, upstream, "--", ...dirs]);
    if (pushed.code !== 0 || pushed.stdout.trim()) return null;
    if ((await git(["merge-base", "--is-ancestor", upstream, head])).code !== 0) return null;
  }
  const list = await git(["rev-list", "--reverse", "--topo-order", head, ...(upstream ? [`^${upstream}`] : [])]);
  if (list.code !== 0) return null;
  const commits = list.stdout.split("\n").filter(isOid);
  return { commits, upstream, backup: `backstop/saved-sessions-${head.slice(0, 12)}`, head };
}

/** The checkout where `branch` is checked out, if any. */
async function checkoutOf(git: GitRun, branch: string): Promise<string | null> {
  return (await worktreesByBranch(git)).get(branch) ?? null;
}

/** POST /api/saved-sessions/remove-from-main: one commit on main deleting only those folders. */
export async function removeFromMain(cwd: string, dirs: string[]): Promise<RemoveFromMainResponse> {
  const repo = await repoOf(cwd);
  if (!repo) return refuse("not-found", "That folder is not in a git repository.");
  const git = repo.git;
  const main = await mainBranch(git);
  if (!main) return refuse("not-found", "This repository has no main branch.");
  const known = new Set((await cardsIn(git, `refs/heads/${main}`)).map((h) => h.dir));
  const pick = [...new Set(dirs.filter((d) => typeof d === "string" && known.has(d)))];
  if (!pick.length) return refuse("not-found", "None of those saved sessions is on main anymore.");
  const message = `Remove ${pick.length === 1 ? "a saved session" : `${pick.length} saved sessions`} from ${main}`;
  const at = await checkoutOf(git, main);
  try {
    if (at) {
      // In main's checkout, like a merge: it must have no tracked changes; only those folders are committed.
      const co = repo.target ? git : localGit(at);
      const dirty = await co(["status", "--porcelain", "--untracked-files=no"]);
      if (dirty.code !== 0 || dirty.stdout.trim()) return refuse("dirty", `${main} is checked out at ${at} with uncommitted changes. Commit or put them aside, then remove it.`);
      const rm = await co(["rm", "-r", "-q", "--", ...pick]);
      if (rm.code !== 0) return refuse("internal", (rm.stderr || rm.stdout).trim());
      const c = await co(["-c", "commit.gpgsign=false", "commit", "-q", "-m", message, "--", ...pick]);
      if (c.code !== 0) return refuse("internal", (c.stderr || c.stdout).trim());
      return { ok: true, commit: (await refSha(co, "HEAD")) ?? "" };
    }
    const before = (await refSha(git, `refs/heads/${main}`))!;
    const sha = await commitChange(git, before, { removeFolders: pick }, message);
    const u = await git(["update-ref", "-m", message, `refs/heads/${main}`, sha, before]);
    if (u.code !== 0) return refuse("internal", (u.stderr || u.stdout).trim());
    return { ok: true, commit: sha };
  } catch (err) {
    return refuse("internal", err instanceof Error ? err.message : String(err));
  }
}

/** POST /api/saved-sessions/purge-from-main: rebuild only the unpushed commits without those folders, a backup
    branch first; the result must fast-forward the remote's main and differ from the old head only there. */
export async function purgeFromMain(cwd: string, dirs: string[]): Promise<PurgeFromMainResponse> {
  const repo = await repoOf(cwd);
  if (!repo) return refuse("not-found", "That folder is not in a git repository.");
  const git = repo.git;
  const main = await mainBranch(git);
  if (!main) return refuse("not-found", "This repository has no main branch.");
  const requested = [...new Set(dirs.filter((d): d is string => typeof d === "string" && !!d))];
  const plan = await purgePlan(git, main, requested);
  if (!plan) return refuse("pushed", `A commit that brought a saved session into ${main} is already pushed, so Sova won't rewrite it. Remove it from main instead, and follow the checklist.`);
  const known = new Set([...(await cardsIn(git, `refs/heads/${main}`)).map((h) => h.dir), ...(await unpushedCardDirs(git, main))]);
  const pick = [...new Set(dirs.filter((d) => typeof d === "string" && known.has(d)))];
  if (!pick.length) return refuse("not-found", "None of those saved sessions is on main anymore.");
  const at = await checkoutOf(git, main);
  const co = at && !repo.target ? localGit(at) : null;
  if (co) {
    const dirty = await co(["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.code !== 0 || dirty.stdout.trim()) return refuse("dirty", `${main} is checked out at ${at} with uncommitted changes. Commit or put them aside first.`);
  }
  try {
    const b = await git(["branch", "--", plan.backup, plan.head]);
    if (b.code !== 0 && !/already exists/.test(b.stderr)) return refuse("internal", (b.stderr || b.stdout).trim());
    const mapped = new Map<string, string>();
    for (const c of plan.commits) {
      const info = await git(["log", "-1", "--format=%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B", c]);
      const [parents, an, ae, ad, cn, ce, cd, ...body] = info.stdout.split("\0");
      const ps = (parents ?? "").split(" ").filter(isOid).map((p) => mapped.get(p) ?? p);
      const tree = await commitChange(git, c, { removeFolders: pick }, "scratch");
      const treeOid = (await git(["rev-parse", `${tree}^{tree}`])).stdout.trim();
      // A commit that only brought the saved session in is left with nothing: it goes.
      if (ps.length === 1) {
        const parentTree = (await git(["rev-parse", `${ps[0]}^{tree}`])).stdout.trim();
        // Dropped only when the purge emptied it: a commit that was empty to begin with stays.
        const ownTree = (await git(["rev-parse", `${c}^{tree}`])).stdout.trim();
        const wasTree = (await git(["rev-parse", `${c}^1^{tree}`])).stdout.trim();
        if (treeOid === parentTree && ownTree !== wasTree) {
          mapped.set(c, ps[0]!);
          continue;
        }
      }
      const env = { GIT_AUTHOR_NAME: an!, GIT_AUTHOR_EMAIL: ae!, GIT_AUTHOR_DATE: ad!, GIT_COMMITTER_NAME: cn!, GIT_COMMITTER_EMAIL: ce!, GIT_COMMITTER_DATE: cd! };
      const made = await git(["commit-tree", treeOid, ...ps.flatMap((p) => ["-p", p]), "-m", body.join("\0").replace(/\n+$/, "")], { env });
      if (made.code !== 0) return refuse("internal", made.stderr.trim());
      mapped.set(c, made.stdout.trim());
    }
    const next = mapped.get(plan.head) ?? plan.head;
    // Proofs: it fast-forwards the remote's main, and differs from the old head only by those folders.
    if (plan.upstream && (await git(["merge-base", "--is-ancestor", plan.upstream, next])).code !== 0) return refuse("internal", "The rebuilt main wouldn't fast-forward the remote's; nothing was changed.");
    const diff = (await git(["diff", "--name-only", plan.head, next])).stdout.split("\n").filter(Boolean);
    if (diff.some((p) => !pick.some((d) => p === d || p.startsWith(`${d}/`)))) return refuse("internal", "The rebuilt main differs in more than the saved sessions; nothing was changed.");
    if (co) {
      const rt = await co(["read-tree", "-m", "-u", plan.head, next]);
      if (rt.code !== 0) return refuse("internal", (rt.stderr || rt.stdout).trim());
    }
    const u = await git(["update-ref", "-m", "purge saved sessions", `refs/heads/${main}`, next, plan.head]);
    if (u.code !== 0) return refuse("internal", (u.stderr || u.stdout).trim());
    return { ok: true, backupBranch: plan.backup, head: next };
  } catch (err) {
    return refuse("internal", err instanceof Error ? err.message : String(err));
  }
}

/** POST /api/saved-sessions/prune: delete a merged branch's saved sessions from the saved-sessions branch (one
    that also belongs to other branches only loses that branch). Pushed when the project's push choice is on. */
export async function prune(cwd: string, branch: string): Promise<PruneResponse> {
  const repo = await repoOf(cwd);
  if (!repo) return refuse("not-a-repo", "That folder is not in a git repository.");
  if (typeof branch !== "string" || !branch) return refuse("invalid", "Name the branch.");
  const push = projectPrefs(repo.key).push === true;
  try {
    const out = await applySaved(repo.git, {
      push,
      message: "",
      plan: async (tip) => {
        const write: Record<string, string> = {};
        const removeFolders: string[] = [];
        let removed = 0;
        if (tip.sha) {
          for (const c of (await readTipCards(repo.git, tip.sha)).cards) {
            if (!c.card || !c.card.branches.includes(branch)) continue;
            const rest = c.card.branches.filter((b) => b !== branch);
            if (rest.length) write[cardPath(c.bundleId)] = `${JSON.stringify({ ...c.card, branches: rest }, null, 2)}\n`;
            else removeFolders.push(c.dir);
            removed++;
          }
        }
        return { change: { write, removeFolders }, result: removed, message: `Remove saved sessions of ${branch}` };
      },
    });
    return { ok: true, removed: out.result, commit: out.sha };
  } catch (err) {
    return refuse("internal", err instanceof Error ? err.message : String(err));
  }
}
