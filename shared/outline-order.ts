/**
 * When a summary topic last moved: the end of its own section of the conversation (`sectionAt`),
 * falling back to when the summarizer last wrote it (`at`) for topics without one. Topics updated in
 * one summarizer run share `at`, so only the section tells them apart.
 */
export function topicTime(topic: { at: number; sectionAt?: number }): number {
  return topic.sectionAt && topic.sectionAt > 0 ? topic.sectionAt : topic.at;
}

/**
 * The order a session's summary topics are shown in: newest first, by `topicTime`; on a tie the
 * later topic in the stored list comes first. Display only — the stored list stays in creation
 * order, which the summarizer's 40-topic cap relies on to drop the oldest.
 * Pure, so the web strip and the Overseer's `sova_session` share it.
 */
export function newestTopics<T extends { at: number; sectionAt?: number }>(topics: readonly T[]): T[] {
  return topics
    .map((topic, index) => ({ topic, index }))
    .sort((a, b) => topicTime(b.topic) - topicTime(a.topic) || b.index - a.index)
    .map(({ topic }) => topic);
}
