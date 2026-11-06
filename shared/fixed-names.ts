/**
 * The chats whose name Sova fixes (SessionSummary.fixedName): the Overseer reads "Overseer", a project's overseer
 * "Overseer · {project}" (the project's current name), and the merge queue's thread and reviewers, release chats
 * and gathering sessions the name Sova gave each when it started. Neither a first message, an automatic title,
 * a rename (the user's or the Overseer's), an alias nor a pi session name changes it.
 * Pure: imported by the server and the client.
 */
import { queueChatRole } from "./merge-queue";

export type FixedNameKind = "overseer" | "project-overseer" | "merge-thread" | "merge-reviewer" | "release" | "gathering";

/** The Sova profile a release chat starts on (server/project-services/release-wire.ts). */
export const RELEASE_THREAD_PROFILE = "release-thread";

/** The kinds Sova names when it starts the chat (the name lives in server/sova-chat-names.ts). */
export type SovaNamedKind = "merge-thread" | "merge-reviewer" | "release";

/** Which of Sova's own started chats a profile pick marks, by the profile alone (never the title). */
export function sovaNamedKind(profile: { id?: string; source?: string; builtin?: boolean } | null | undefined): SovaNamedKind | undefined {
  const role = queueChatRole(profile);
  if (role === "thread") return "merge-thread";
  if (role === "reviewer") return "merge-reviewer";
  if (!profile || profile.id !== RELEASE_THREAD_PROFILE) return undefined;
  const sova = profile.source === "sova" || (profile.source === undefined && profile.builtin === true);
  return sova ? "release" : undefined;
}

/** The name a Sova-started chat reads when Sova's record of the name it gave is missing (a chat started before
    that record existed, whose stored title isn't Sova's either). */
export const SOVA_NAMED_FALLBACK: Readonly<Record<SovaNamedKind, string>> = {
  "merge-thread": "Merge thread",
  "merge-reviewer": "Merge review",
  release: "Release chat",
};

// ---- the names Sova gives its chats: one formatter per start path, also used to rebuild a name it didn't record ----

const lastPart = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/** A merge thread's name: the project folder's name and the day (UTC) it started. */
export const mergeThreadTitle = (root: string, startedAt: number): string => `Merge thread \u00b7 ${lastPart(root)} \u00b7 ${new Date(startedAt).toISOString().slice(0, 10)}`;

/** A reviewer chat's name: what it reviews, and which attempt. */
export const reviewerTitle = (o: { branch: string; commit: string; attempt: number }): string =>
  `Review \u00b7 ${o.branch} \u00b7 ${o.commit.slice(0, 7)}${o.attempt > 1 ? ` \u00b7 attempt ${o.attempt}` : ""}`;

/** A release chat's name: the same shape throughout, with the tag once known. */
export const releaseChatTitle = (rec: { tag?: string | null; project: string }): string => `Release ${rec.tag ?? "(version not picked yet)"} of ${lastPart(rec.project)}`;

/** The chat a withdrawn release starts for its withdraw steps when its release chat can't take them. */
export const withdrawChatTitle = (tag: string): string => `Withdraw ${tag}`;

/** The sentence a rename or alias of such a chat is refused with. */
export function fixedNameRefusal(kind: FixedNameKind): string {
  switch (kind) {
    case "overseer":
    case "project-overseer":
      return "An overseer keeps its own name.";
    case "merge-thread":
    case "merge-reviewer":
      return "The merge queue's chats keep the names Sova gives them.";
    case "release":
      return "A release chat keeps the name Sova gives it.";
    case "gathering":
      return "A gathering session keeps its public title as its name.";
  }
}
