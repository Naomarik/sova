/**
 * Fix and Fix in New Chat (§app.merge-queue/fix): a failure holding a branch up (its dry run's, or its landing's) sent
 * with its whole context to the branch's own chat, as the user's message, or as the first message of a fresh coding
 * chat; either way the chat explains, proposes and waits for the user, editing nothing before they answer.
 */
import type { BranchFailure, FixOffer, MergeRun } from "../../shared/merge-queue";

/** The seeded message's last line: what the chat does, and doesn't, before the user answers. */
export const FIX_ENDING = "Explain what's wrong and propose how to fix it, then stop and wait for my guidance. Don't change any files before I answer.";
/** Fix in New Chat: a coding chat is also told to commit and merge its target before it ends its turn; this waits. */
export const FIX_NEW_CHAT_HOLD = "Until I answer, that holds over anything else this chat is told: no edits, no commits and no merges, not even of the target.";

export const fixWorking = (chat: string): string => `${chat} is working: wait for its turn to end, then press Fix.`;
export const fixLive = (chat: string): string => `${chat} is open in a terminal: Fix can't send to it from here.`;
export const FIX_NO_CHAT = "No chat works on this branch: use Fix in New Chat.";

/** The failure's whole context, as the message Fix sends. Pure. */
export function fixText(o: {
  /** A fresh chat's first message: it adds FIX_NEW_CHAT_HOLD after the ending. */
  newChat?: boolean;
  failure: BranchFailure;
  branch: string;
  target: string;
  runPage: string;
  run: MergeRun | null;
  logs: { label: string; path: string; tail: string[] }[];
  holdsUp: string[];
}): string {
  const f = o.failure;
  const sha = f.commit.slice(0, 7);
  const what = f.kind === "dry-run" ? "A dry run" : "The landing";
  const checks = f.checks.length ? f.checks.map((c) => c.label).join(", ") : "its checks";
  const lines = [`${what} of ${o.branch} at ${sha} failed ${checks}.`, f.line];
  for (const c of f.checks) {
    lines.push("", `${c.label} (${c.whose === "branch" ? "this branch's" : c.whose === "master" ? `fails on ${o.target} too` : "can't tell whose"}):`);
    for (const t of (c.tests ?? []).slice(0, 20)) lines.push(`- ${[t.file, t.name].filter(Boolean).join(" › ") || "a test"}${t.message ? `: ${t.message.split("\n").slice(0, 6).join(" ").slice(0, 600)}` : ""}`);
    if ((c.tests?.length ?? 0) > 20) lines.push(`- +${c.tests!.length - 20} more`);
  }
  lines.push("", `Logs: ${o.runPage} · merge.logs {run: "${f.run}"}`);
  for (const l of o.logs) {
    lines.push(`- ${l.label}: ${l.path}`);
    if (l.tail.length) lines.push("```", ...l.tail.slice(-40), "```");
  }
  const whose = f.whose === "branch" ? "This branch's change breaks it." : f.whose === "master" ? `Fails on ${o.target} too: not this branch's.` : f.whose === "unclear" ? `Can't tell whose failure: it fails on ${o.target} alone too.` : "The machine's: nothing of the branch's ran.";
  lines.push("", `Whose: ${whose}`);
  lines.push(`It holds up: ${o.holdsUp.length ? o.holdsUp.join(", ") : `${o.branch} only`}`);
  lines.push("", FIX_ENDING);
  if (o.newChat) lines.push(FIX_NEW_CHAT_HOLD);
  return lines.join("\n");
}

/** A chat as Fix sees it: its title, and whether it works now or is open in a terminal. */
export interface FixChatState {
  id: string;
  path: string;
  title: string;
  working: boolean;
  live: boolean;
}

/** Fix and Fix in New Chat on a failure, each with why not. `shared`: the target shares it (a new branch from the
 *  target); else on this branch, refused like Fix while the branch's chat there works. Pure. */
export function fixOfferOf(chat: FixChatState | null, shared: boolean, target: string | null): FixOffer {
  const why = !chat ? FIX_NO_CHAT : chat.live ? fixLive(chat.title) : chat.working ? fixWorking(chat.title) : null;
  const newChat: FixOffer["newChat"] = shared
    ? target
      ? { ok: true, on: "new-branch" }
      : { ok: false, why: "There is no target branch to start from.", on: "new-branch" }
    : chat && (chat.live || chat.working)
      ? { ok: false, why: chat.live ? fixLive(chat.title) : fixWorking(chat.title), on: "this-branch" }
      : { ok: true, on: "this-branch" };
  return { chat: why || !chat ? { ok: false, why: why ?? FIX_NO_CHAT } : { ok: true, session: chat.id }, newChat };
}
