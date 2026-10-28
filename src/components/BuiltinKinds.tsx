import type { Component } from "solid-js";
import type { KindViewProps } from "../lib/transcript-kinds";
import type { TranscriptItem } from "../../shared/protocol";
import { WorktreeMergeCard } from "./WorktreeMergeCard";
import { SettingsToolCard } from "./SettingsChangeCard";
import type { SettingsToolDetails } from "../../shared/project-settings";
import { OfferCardView } from "./OfferCard";
import type { OfferCard } from "../../shared/session-offers";

/**
 * The views of Sova's own transcript cards, moved onto the card toolkit one kind at a time
 * (§chat.transcript-cards/built-ins), each drawing exactly what its old branch in Thread.tsx drew.
 * They draw in the page, from the page's own chunk (no lazy load, so nothing flashes), and ask the
 * list around their row through components/thread-rows.ts, never Thread.tsx itself.
 */
export const BUILTIN_VIEWS = {
  "worktree-merge": (props: KindViewProps<NonNullable<TranscriptItem["worktreeMerge"]>>) => <WorktreeMergeCard merge={props.value} time={props.item.at} />,
  settings: (props: KindViewProps<SettingsToolDetails>) => <SettingsToolCard details={props.value} />,
  offer: (props: KindViewProps<OfferCard>) => <OfferCardView card={props.value} />,
} satisfies Record<string, Component<KindViewProps<never>>>;
