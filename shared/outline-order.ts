/**
 * The order a session's summary topics are shown in: newest first, by when each was last updated
 * (`at`); on a tie the later topic in the stored list comes first. Display only — the stored list
 * stays in creation order, which the summarizer's 40-topic cap relies on to drop the oldest.
 * Pure, so the web strip and the Overseer's `sova_session` share it.
 */
export function newestTopics<T extends { at: number }>(topics: readonly T[]): T[] {
  return topics
    .map((topic, index) => ({ topic, index }))
    .sort((a, b) => b.topic.at - a.topic.at || b.index - a.index)
    .map(({ topic }) => topic);
}
