// A chat's merge queue cards (one per branch it owns), read for the thread: at once, again on any queue
// action, adopted from the session feed's `merge_cards` frame, and placed as outside-card rows.
import { createEffect, createResource, on, type Accessor } from "solid-js";
import type { CardInfo } from "../../shared/transcript-cards";
import { getMergeCards } from "./api";
import { queueCardRows, type QueueCard } from "./merge-queue-card";
import { mergeCardsFeed, mergeChanged } from "./merge-queue-client";

export function createMergeCards(sessionId: Accessor<string | null | undefined>): { cards: Accessor<QueueCard[]>; rows: Accessor<CardInfo[]> } {
  const [read, { refetch, mutate }] = createResource(
    () => sessionId() || null,
    async (id) => (await getMergeCards(id)).cards as QueueCard[],
  );
  createEffect(on(mergeChanged, () => sessionId() && void refetch(), { defer: true }));
  createEffect(on(mergeCardsFeed, (f) => f && f.session === sessionId() && mutate(f.cards as QueueCard[]), { defer: true }));
  // An older server has no cards route: no cards, never an error in the thread.
  const cards = () => (read.error ? [] : (read.latest ?? []));
  return { cards, rows: () => queueCardRows(cards()) };
}
