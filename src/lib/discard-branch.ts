// Discard Branch… (the Land ▾ menu's last item): the words its menu item, its confirm, its toast and a partial stop
// say, from the server's dry run (DiscardBranchPreview) and its answer (DiscardBranchResult). Pure, so the copy is
// tested without a DOM.
import type { DiscardBranchPreview, DiscardBranchResult } from "../../shared/merge-queue";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}`);

/** The menu item's one line when it may run. */
export const DISCARD_LINE = "Deletes the branch and its folder, and archives its chat.";

/** The chats a discard archives: the branch's own first, then the others idle in its folder. */
export const discardChats = (p: Pick<DiscardBranchPreview, "chat"> & { others?: DiscardBranchPreview["others"] }) => [...(p.chat ? [p.chat] : []), ...(p.others ?? [])];

/** The menu item's line, by what the dry run found: only the parts it has, and no chat before it answers. */
export function discardMenuLine(p: (Pick<DiscardBranchPreview, "folder" | "chat"> & { others?: DiscardBranchPreview["others"] }) | undefined): string {
  if (!p) return "Deletes the branch and its folder.";
  const n = discardChats(p).length;
  const chats = n > 1 ? "archives its chats" : "archives its chat";
  if (p.folder && n) return n > 1 ? `Deletes the branch and its folder, and ${chats}.` : DISCARD_LINE;
  if (p.folder) return "Deletes the branch and its folder.";
  if (n) return `Deletes the branch and ${chats}.`;
  return "Deletes the branch.";
}

/** The files Discard deletes with the folder that git can't bring back (uncommitted, untracked, ignored, nested
    repositories): Remove Anyway's listing shows them, its rebuildable folders with them. */
export const discardFileCount = (p: Pick<DiscardBranchPreview, "files">): number => (p.files ? p.files.counts.uncommitted + p.files.counts.ignored + p.files.counts.nested : 0);

/** One thing that goes, as the confirm lists it. */
export interface DiscardPart {
  key: "commits" | "files" | "drafts" | "folder" | "chat";
  text: string;
  /** A path after the words, drawn in mono. */
  code?: string;
}

export interface DiscardWords {
  title: string;
  /** What goes, in order; a missing part (no folder, no chat, no commits of its own, no files, no drafts) is left out. */
  parts: DiscardPart[];
  /** Plainly, what can't be brought back. */
  line: string;
  /** What stays that the user might expect to go: the branch's chat, when it works in another folder. */
  stays?: string;
  confirm: string;
}

/**
 * The confirm's words. `here`: the file of the chat whose list this is: if it is archived too, it reads "This chat". `folder`: the folder
 * as the page shows it (with ~). The files themselves are drawn from `files` by Remove Anyway's listing; here they are
 * one counted part.
 */
export function discardConfirmWords(p: DiscardBranchPreview, o: { here?: string; folder?: string } = {}): DiscardWords {
  const target = p.target || "the target branch";
  const commits = p.commits.count;
  const files = discardFileCount(p);
  const parts: DiscardPart[] = [];
  if (commits > 0) parts.push({ key: "commits", text: `${plural(commits, "commit")} not on ${target}` });
  // Each kind in its own words (the listing under the list names every one); rebuildable folders only when no listing
  // shows them.
  const f = p.files?.counts;
  if (f?.uncommitted) parts.push({ key: "files", text: plural(f.uncommitted, "uncommitted file") });
  if (f?.ignored) parts.push({ key: "files", text: plural(f.ignored, "ignored file") });
  if (f?.nested) parts.push({ key: "files", text: plural(f.nested, "nested repository", "nested repositories") });
  if (f?.rebuildable && !files) parts.push({ key: "files", text: `Rebuildable files: ${rebuildableWords(p.files!.rebuildable, f.rebuildable)}` });
  if (p.drafts.length > 0) parts.push({ key: "drafts", text: plural(p.drafts.length, "spec draft") });
  if (p.folder) parts.push({ key: "folder", text: "Its folder,", code: o.folder ?? p.folder });
  // Each chat archived by name: the branch's own, then every other idle chat working in its folder.
  const title = (c: { title: string }) => c.title || "untitled";
  if (p.chat) parts.push({ key: "chat", text: o.here && p.chat.path === o.here ? "This chat, archived" : `Its chat, ${title(p.chat)}, archived` });
  for (const c of p.others ?? []) parts.push({ key: "chat", text: o.here && c.path === o.here ? "This chat, archived" : `A chat in its folder, ${title(c)}, archived` });
  // The files' own listing says they can't be brought back; this line is about the commits.
  const line =
    commits > 0
      ? `No backup is kept: ${commits === 1 ? `its commit not on ${target} can't` : `its ${commits} commits not on ${target} can't`} be brought back.`
      : `Every commit is already on ${target}. No backup is kept.`;
  return { title: `Discard ${p.branch}?`, parts, line, confirm: "Discard Branch", ...(!p.chat && p.chatStays ? { stays: p.chatStays } : {}) };
}

/** The rebuildable folders by name, the first 3 and how many more. */
const rebuildableWords = (rows: string[], total: number) => `${rows.slice(0, 3).join(", ")}${total > Math.min(3, rows.length) ? `, and ${total - Math.min(3, rows.length)} more` : ""}`;

type Steps = DiscardBranchResult["steps"];
type Chats = DiscardBranchResult["chats"] | undefined;
/** How many chats were archived: by each chat's outcome, else (an answer without them) the chat step's. */
const archivedCount = (steps: Steps, chats: Chats) => (chats ? chats.filter((c) => c.state === "done").length : steps.some((x) => x.step === "chat" && x.state === "done") ? 1 : 0);
const chatsWords = (n: number) => (n === 1 ? "its chat" : `its ${n} chats`);

/** The toast once it is all done: the chat clause only when a chat was archived, with how many. */
export function discardDoneToast(branch: string, steps: Steps, chats?: Chats): string {
  const n = archivedCount(steps, chats);
  return `Discarded ${branch}.${n ? ` ${sentenceCase(chatsWords(n))} ${n === 1 ? "is" : "are"} archived.` : ""}`;
}

const DID: Record<Steps[number]["step"], string> = { folder: "removed its folder", branch: "deleted the branch", chat: "archived its chat" };
const LEFT: Record<Steps[number]["step"], string> = { folder: "its folder", branch: "the branch", chat: "its chat" };

/** A partial stop, on the row: what was done, then what stayed, with the failed step's reason. A part the branch never
    had (skipped, or absent from the dry run: no folder, no chat) names nothing, even when the stop left it "not run". */
export function discardPartialLine(steps: Steps, had: { folder?: boolean; chat?: boolean } = {}, chats?: Chats): string {
  const has = (s: Steps[number]) => s.step === "branch" || had[s.step] !== false;
  // With each chat's outcome, the chat step counts them: "archived 2 chats", "1 chat stayed".
  const chatDid = chats ? chats.filter((c) => c.state === "done").length : 0;
  const chatLeft = chats ? chats.filter((c) => c.state !== "done").length : 0;
  const did = steps
    .filter((s) => (chats && s.step === "chat" ? chatDid > 0 : s.state === "done"))
    .map((s) => (chats && s.step === "chat" ? `archived ${chatDid === 1 && !chatLeft ? "its chat" : plural(chatDid, "chat")}` : DID[s.step]));
  const left = steps
    .filter((s) => has(s) && (chats && s.step === "chat" ? chatLeft > 0 : s.state === "failed" || s.state === "not-run"))
    .map((s) => (chats && s.step === "chat" ? (chatLeft === 1 && !chatDid ? "its chat" : plural(chatLeft, "chat")) : LEFT[s.step]));
  const why = (steps.find((s) => s.state === "failed")?.detail ?? chats?.find((c) => c.state === "failed")?.detail)?.replace(/\.$/, "");
  const head = did.length ? `${sentenceCase(list(did))}.` : "Nothing was discarded.";
  const tail = left.length ? ` ${sentenceCase(list(left))} stayed${why ? `: ${why}` : ""}.` : "";
  return `${head}${tail}`;
}
