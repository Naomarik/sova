// A chat's merge queue cards (one per branch it owns) and its review cards (one per blocking review), read for the
// thread: at once, again on any queue action, adopted from the session feed's `merge_cards` frame, and placed as
// outside-card rows.
import { createEffect, createResource, on, type Accessor } from "solid-js";
import type { ReviewCard as MergeReviewCard } from "../../shared/merge-queue";
import type { CardInfo } from "../../shared/transcript-cards";
import { getMergeCards } from "./api";
import { queueCardRows, type QueueCard } from "./merge-queue-card";
import { mergeCardsFeed, mergeChanged } from "./merge-queue-client";
import { reviewCardRows } from "./merge-review-card";

interface Read {
  cards: QueueCard[];
  reviews: MergeReviewCard[];
}

export function createMergeCards(sessionId: Accessor<string | null | undefined>): { cards: Accessor<QueueCard[]>; reviews: Accessor<MergeReviewCard[]>; rows: Accessor<CardInfo[]> } {
  const [read, { refetch, mutate }] = createResource(
    () => sessionId() || null,
    async (id): Promise<Read> => {
      const r = await getMergeCards(id);
      return { cards: r.cards as QueueCard[], reviews: r.reviews ?? [] };
    },
  );
  createEffect(on(mergeChanged, () => sessionId() && void refetch(), { defer: true }));
  // A frame from an older server carries no reviews: keep the ones read.
  createEffect(on(mergeCardsFeed, (f) => f && f.session === sessionId() && mutate((prev) => ({ cards: f.cards as QueueCard[], reviews: f.reviews ?? prev?.reviews ?? [] })), { defer: true }));
  // An older server has no cards route: no cards, never an error in the thread.
  const cards = () => (read.error ? [] : (read.latest?.cards ?? []));
  const reviews = () => (read.error ? [] : (read.latest?.reviews ?? []));
  return { cards, reviews, rows: () => [...queueCardRows(cards()), ...reviewCardRows(reviews())] };
}
