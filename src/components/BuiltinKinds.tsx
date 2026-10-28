import { Show, type Component } from "solid-js";
import { Chip, Icon } from "./ui";
import type { KindViewProps } from "../lib/transcript-kinds";
import type { HandoffRunInfo, TranscriptItem } from "../../shared/protocol";
import { WorktreeMergeCard } from "./WorktreeMergeCard";
import { SettingsToolCard } from "./SettingsChangeCard";
import type { SettingsToolDetails } from "../../shared/project-settings";
import { OfferCardView } from "./OfferCard";
import type { OfferCard } from "../../shared/session-offers";
import { ShowChangesCard } from "./ChangesViewer";
import type { ShowChangesDetails } from "../../pi-config/extensions/show-changes/details";
import { TourCard } from "./TourCard";
import type { TourCardDetails } from "../../shared/tour";
import { OwnerRequestNote } from "./OwnerRequestNote";
import { OverseerChoiceRow } from "./OverseerCards";
import { profileIconName } from "../lib/profiles";
import { useThreadRows } from "./thread-rows";
import { BriefRow } from "./OverseerCards";

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
  "show-changes": (props: KindViewProps<ShowChangesDetails>) => <ShowChangesCard details={props.value} />,
  tour: (props: KindViewProps<TourCardDetails>) => <TourCard details={props.value} />,
  // An owner request a Start Chat put at the top (§app.project-assistant/request-chat).
  "owner-request": (props: KindViewProps<NonNullable<TranscriptItem["ownerRequest"]>>) => <OwnerRequestNote card={props.value} />,
  "handoff-run": (props: KindViewProps<HandoffRunInfo>) => <HandoffRunRow run={props.value} text={props.item.text ?? ""} />,
  "overseer-answer": (props: KindViewProps<Extract<NonNullable<TranscriptItem["overseerMark"]>, { kind: "dialog-answer" }>>) => <OverseerChoiceRow title={props.value.title} answer={props.value.answer} />,
  "profile-mark": ProfileMarkRow,
  brief: (props: KindViewProps) => <BriefRow text={props.item.text ?? ""} time={props.item.at} />,
} satisfies Record<string, Component<KindViewProps<never>>>;

/** A /compact-handoff run (§chat.slash-commands/compact-handoff-row): an info row whose icon is
    the live dot while the fork writes; the result entry (same id) replaces it in place. */
function HandoffRunRow(props: { run: HandoffRunInfo; text: string }) {
  return (
    <div class="info-row" role="note">
      <span class="info-row-text">
        <Show when={props.run.status === "running"} fallback={<Icon name="info" small />}>
          {/* The explain card's 16px slot, so the dot sits where the icon would. */}
          <span class="explain-card-live" aria-hidden="true">
            <span class="live-dot" />
          </span>
        </Show>
        <Show when={props.run.status === "failed"}>
          <Chip tone="error">Failed</Chip>
        </Show>
        <Show when={props.run.status === "interrupted"}>
          <Chip tone="warn">Interrupted</Chip>
        </Show>
        <span>{props.text}</span>
      </span>
    </div>
  );
}

/** The profile a session runs with, shown once a message is on the branch (§chat.profiles/after-first-message). */
function ProfileMarkRow(props: KindViewProps<NonNullable<TranscriptItem["profileMark"]>>) {
  const rows = useThreadRows();
  return (
    <Show when={rows.hasUserRow() && props.value.profile}>
      {(p) => (
        <p class="profile-row" title="The profile this session runs with. It was fixed when the first message was sent.">
          <Icon name={profileIconName(p().icon)} small />
          {props.item.text}
        </p>
      )}
    </Show>
  );
}
