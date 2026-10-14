import { UnreadReplies } from "./unread-replies";

/**
 * Each project overseer's unseen-reply count, one counter per project kept between reads
 * (server/unread-replies): the project overseer page (`ProjectOverseerInfo.unread`) and every
 * session summary of its current conversation (`SessionSummary.unreadReplies`) read the same one,
 * so a list rebuild re-reads only what the file gained.
 */
const counters = new Map<string, UnreadReplies>();

export function projectOverseerUnread(projectId: string, path: string, since: number | undefined): Promise<number> {
  let counter = counters.get(projectId);
  if (!counter) counters.set(projectId, (counter = new UnreadReplies()));
  return counter.count(path, since);
}
