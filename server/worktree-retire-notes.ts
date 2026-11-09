// What retirement says, and when a chat's folder comes back (§chat.worktrees/retirement): the gate before a
// message reaches a chat, the one-shot hidden line that tells the chat, the home-folder banner's facts, and the
// first pass's summary in the Overseer's chat.
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { CwdFallback } from "../shared/protocol";
import { setRetireNoteSource } from "./merge-queue/card-note";
import { canonical } from "../pi-config/extensions/worktrees/state.ts";
import { heldPartialEntry, readLedger, type RemovedWorktree } from "./removed-worktrees";
import { type BringBackResult, bringBack, type PassResult, realRetireDeps, retiredEntryFor } from "./worktree-retire";

/** Lines waiting for a chat's next turn, by session id. */
const lines = new Map<string, string[]>();

/** The note's source: each line once, at the chat's next turn. */
export function takeRetireLines(session: string): string | null {
  const said = lines.get(session);
  if (!said?.length) return null;
  lines.delete(session);
  return said.join("\n");
}
setRetireNoteSource(takeRetireLines);

export function tellChat(session: string, line: string): void {
  if (!session) return;
  const said = lines.get(session) ?? [];
  said.push(line);
  lines.set(session, said);
}

/** The folder a chat means to work in: the stored one when it runs in the home folder for now. */
export function ownFolderOf(mirror: { cwd?: string; cwdFallback?: CwdFallback | null }): string | null {
  const cwd = mirror.cwdFallback?.original ?? mirror.cwd;
  return cwd && isAbsolute(cwd) ? cwd : null;
}

/** Still open in what a stopped delete left, and quiet enough to move: its next message goes to the home folder. */
const strandedIn = (mirror: { cwd?: string; cwdFallback?: CwdFallback | null; running?: boolean }, cwd: string, ledger: () => readonly RemovedWorktree[]): RemovedWorktree | null =>
  mirror.cwdFallback || mirror.running ? null : heldPartialEntry(ledger(), canonical(cwd));

/** Cheap and sync, for every message: is this chat's folder gone and in a retired worktree, or held after a stopped delete? */
export function needsBringBack(mirror: { cwd?: string; cwdFallback?: CwdFallback | null; running?: boolean }, ledger: () => readonly RemovedWorktree[] = readLedger): boolean {
  const cwd = ownFolderOf(mirror);
  if (!cwd) return false;
  if (existsSync(cwd)) return strandedIn(mirror, cwd, ledger) !== null;
  return retiredEntryFor(ledger(), cwd) !== null;
}

/**
 * Bring a chat's folder back before its message. A chat in the home folder then reopens there
 * (`reopen`, "every open looks again"); one whose process opened it before it retired just finds it again.
 * Whatever happens the message goes on, and the chat is told.
 */
export async function bringBackForChat(h: { mirror: { sessionId?: string; cwd?: string; cwdFallback?: CwdFallback | null; running?: boolean }; reopenHere(): Promise<unknown> }, deps = realRetireDeps()): Promise<BringBackResult> {
  const cwd = ownFolderOf(h.mirror);
  if (!cwd) return { state: "none" };
  const stranded = existsSync(cwd) ? strandedIn(h.mirror, cwd, deps.ledger) : null;
  if (stranded) {
    const line = `Your worktree was retired after ${stranded.branch} landed, but files stayed in ${stranded.path}, so you're in the home folder for now.`;
    tellChat(h.mirror.sessionId ?? "", line);
    // Reopening looks at the folder again, and a held one opens in the home folder (resolveOpenCwd).
    await h.reopenHere().catch((err: Error) => console.warn(`[retire] reopen: ${err.message}`));
    return { state: "failed", reason: "Files stayed in its folder.", line };
  }
  const r = await bringBack(deps, cwd);
  if (r.state === "none") return r;
  tellChat(h.mirror.sessionId ?? "", r.line);
  if (r.state === "back" && h.mirror.cwdFallback && existsSync(cwd)) await h.reopenHere().catch((err: Error) => console.warn(`[retire] reopen: ${err.message}`));
  return r;
}

/** The first pass's one summary, in the global Overseer's chat, starting no turn. Nothing to say when it looked at no worktree. */
export function firstPassSummary(r: PassResult): string | null {
  const parts = r.repos.flatMap((x) => {
    const retired = x.retired.filter((t) => !t.queueMade).length;
    const queue = x.queueOwn.length + x.retired.filter((t) => t.queueMade).length;
    const words = [[retired, "retired"], [x.held.length, "held"], [x.waiting.length, "waiting"], [x.hasWork.length, "have work"], [queue, "the queue's own"]] as const;
    const said = words.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
    return said.length ? [`- ${basename(x.repo)}: ${said.join(" · ")}`] : [];
  });
  return parts.length ? [`Sova retired finished worktrees for the first time. Every branch's last commit stays restorable from each project's Merge Queue tab.`, ...parts].join("\n") : null;
}
