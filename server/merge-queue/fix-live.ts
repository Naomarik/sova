/**
 * Fix and Fix in New Chat on the live server (§app.merge-queue/fix): the failure of a run, read from its project's
 * queue, sent to the branch's own chat as the user's message, or as a fresh coding chat's first message. Refused,
 * nothing sent, while the chat works or is open in a terminal.
 */
import { join } from "node:path";
import type { FixOffer } from "../../shared/merge-queue";
import { fixLive, FIX_NO_CHAT, fixOfferOf, fixText, fixWorking, type FixChatState } from "./fix";
import type { FixAnswer } from "./routes-landing";
import { MergeFailure } from "./queue";

/** The owner's chat id (owners.ts answers an id or a record). */
const ownerId = (o: string | { session: string; archived?: boolean } | null | undefined): { session: string } | null => (!o ? null : typeof o === "string" ? { session: o } : o.archived ? null : { session: o.session });

/** A chat as Fix reads it, by its id; null: no such chat (or archived). */
export async function fixChatState(session: string | undefined): Promise<FixChatState | null> {
  if (!session) return null;
  const { listedSession } = await import("../sessions-index");
  const s = await listedSession(session).catch(() => undefined);
  if (!s || s.archived) return null;
  const { runLive } = await import("../projects/playbook-review");
  const live = await runLive(s.path).catch(() => undefined);
  return { id: s.id, path: s.path, title: s.title || "Its chat", working: !!live?.working, live: !!s.live };
}

/** The offer on a row (queue.ts deps.fixOffer): the branch's chat (the entry's, else the worktree's owner). */
export async function liveFixOffer(o: { root: string; branch: string; worktree?: string; session?: string; shared: boolean }): Promise<FixOffer> {
  let session = o.session;
  if (!session && o.worktree) {
    const { worktreeOwnerOf } = await import("./wire");
    session = ownerId(await worktreeOwnerOf(o.worktree).catch(() => null))?.session;
  }
  const chat = await fixChatState(session);
  // A failure the target shares starts its new chat on a new branch from the target, which must be readable.
  const { mergeQueues } = await import("./wire");
  const target = o.shared ? ((await mergeQueues()?.peek(o.root))?.target ?? null) : null;
  return fixOfferOf(chat, o.shared, target);
}

export async function liveFix(projectId: string, req: { branch: string; commit: string; run: string; newChat: boolean; check?: string }): Promise<FixAnswer> {
  const [{ mergeQueues }, { listProjects }] = await Promise.all([import("./wire"), import("../projects/spaces")]);
  const root = listProjects().find((p) => p.id === projectId)?.root;
  const qs = mergeQueues();
  if (!root || !qs) throw new MergeFailure("not-found", `no project ${projectId}`);
  const q = await qs.get(root);
  const view = await q.cachedView();
  // A check broken on the target: the failure is the target's own (a new branch from it).
  const broken = req.check ? view.heads.targetBroken?.find((b) => b.check === req.check && b.run === req.run) : undefined;
  const ctx = broken
    ? { failure: { kind: "landing" as const, run: broken.run, commit: view.heads.target, whose: "master" as const, line: `${broken.why}. Every branch skips it until it's fixed on ${q.target}.`, checks: [{ id: broken.check, label: broken.label, step: broken.step, whose: "master" as const }] }, branch: q.target, holdsUp: ["every branch (they skip it meanwhile)"] as string[], session: undefined as string | undefined, worktree: undefined as string | undefined }
    : await q.fixContext(req.run);
  if (!ctx) throw new MergeFailure("not-found", `no failure of ${req.run} holds a branch up now`);
  if (!broken && (ctx.branch !== req.branch || ctx.failure.commit !== req.commit)) throw new MergeFailure("invalid-request", "That failure is no longer the branch's newest: look again.");
  const run = q.store.readRun(req.run);
  const runDir = q.store.runDir(req.run);
  const { stepLog } = await import("./run");
  const logs = ctx.failure.checks.map((c) => {
    const st = run?.steps.find((x) => x.id === c.step) ?? run?.steps.find((x) => x.id === `check:${c.id}`);
    return { label: c.label, path: st ? join(runDir, st.log) : runDir, tail: st ? stepLog(runDir, st, 40) : [] };
  });
  const runPage = `#/projects/${encodeURIComponent(projectId)}/merge-queue/${req.run}`;
  const text = fixText({ failure: ctx.failure, branch: ctx.branch, target: q.target, runPage, run, logs, holdsUp: ctx.holdsUp });
  const shared = ctx.failure.whose !== "branch";
  let session = ctx.session;
  if (!session && ctx.worktree) {
    const { worktreeOwnerOf } = await import("./wire");
    session = ownerId(await worktreeOwnerOf(ctx.worktree).catch(() => null))?.session;
  }
  const chat = broken ? null : await fixChatState(session);
  if (!req.newChat) {
    if (!chat) throw new MergeFailure("invalid-request", FIX_NO_CHAT);
    if (chat.live) throw new MergeFailure("busy", fixLive(chat.title));
    if (chat.working) throw new MergeFailure("busy", fixWorking(chat.title));
    const { promptSession } = await import("../session-prompt");
    const r = await promptSession(chat.path, text);
    if (!r.ok) throw new MergeFailure(r.status === 404 ? "not-found" : "busy", r.error ?? "it couldn't be sent");
    return { session: chat.id, path: chat.path };
  }
  // Fix in New Chat: a new branch from the target for a failure it shares; else on this branch, in its worktree.
  let cwd: string | undefined;
  if (!shared) {
    if (chat?.live) throw new MergeFailure("busy", fixLive(chat.title));
    if (chat?.working) throw new MergeFailure("busy", fixWorking(chat.title));
    cwd = ctx.worktree ?? ctx.entry?.worktree;
    if (!cwd) throw new MergeFailure("invalid-request", `${ctx.branch} has no folder to work in: use Fix on its chat`);
  }
  const first = ctx.failure.checks[0]?.label ?? "the failure";
  const { startFixChat } = await import("../project-overseer");
  const made = await startFixChat(projectId, { prompt: text, title: `Fix ${first} on ${shared ? q.target : ctx.branch}`, ...(cwd ? { cwd } : {}) });
  const wt = made.worktree as { path?: string; branch?: string } | undefined;
  return { session: made.sessionId, path: made.path, ...(wt?.branch ? { branch: wt.branch } : !shared ? { branch: ctx.branch } : {}), ...(wt?.path ? { worktree: wt.path } : cwd ? { worktree: cwd } : {}) };
}
