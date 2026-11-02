import { lazy, Show, type Component } from "solid-js";
import type { LiveCallBlock, LiveInput, LiveKindViewProps, LiveUserEntry, LiveView } from "../lib/transcript-kinds";
import type { LiveBlock } from "../lib/live";
import { shownUserState } from "../lib/live";
import { stampTime } from "../lib/format";
import { stripPastedPaths } from "../lib/path-attachments";
import { rowProvider } from "../lib/subagent-limit";
import { tourLine } from "../lib/tour-rows";
import type { AlignRowInfo } from "../../shared/protocol";
import type { WakeInfo } from "../../shared/wake";
import type { TopicBatchInfo } from "../../shared/topic-message";
import type { OfferCard } from "../../shared/session-offers";
import type { CardInfo } from "../../shared/transcript-cards";
import { CARD_TOOL as RAISE_CARD_TOOL } from "../../shared/transcript-cards";
import type { ShowChangesDetails } from "../../pi-config/extensions/show-changes/details";
import type { TourCardDetails } from "../../shared/tour";
import { normalizeTourCardDetails, TOUR_TOOLS } from "../../shared/tour";
import type { SettingsToolDetails } from "../../shared/project-settings";
import { CARD_TOOL, normalizeCardDetails } from "../../shared/overseer-card";
import { useLiveRows } from "./thread-rows";
import { AssistantText, Thinking, TurnError, UserTurn } from "./MessageRows";
import { MessageActions } from "./MessageActions";
import { InfoRow } from "./InfoRow";
import { WakeCard } from "./WakeCard";
import { TopicCard } from "./TopicCard";
import { SubagentLimitRow } from "./SubagentLimitRow";
import { AlignRow } from "./AlignDocCard";
import { TourCard } from "./TourCard";
import { ShowChangesCard } from "./ChangesViewer";
import { OfferCardView } from "./OfferCard";
import { SettingsToolCard } from "./SettingsChangeCard";
import { ToolCard, type ToolStatus } from "./ToolCard";
import { BriefRow, CardRevision, DeckCard, LinkCard, linkDetails, NavigateGo, useOverseerThread } from "./OverseerCards";

/** A card the running turn raised, before its row settles: the toolkit's own card view, loaded when first needed. */
const LiveTranscriptCard = lazy(() => import("./TranscriptCard"));

/**
 * The live views of Sova's own kinds (lib/transcript-kinds.ts `live`): what a kind draws while its turn
 * still streams, before the settled row (its `view`, components/BuiltinKinds.tsx) replaces it. Drawn by
 * the toolkit's host like every view, they ask the run around them through components/thread-rows.ts
 * (`LiveRows`), never Thread.tsx itself.
 */
export const LIVE_VIEWS: { [K in LiveView]: Component<LiveKindViewProps<never>> } = {
  wake: (props: LiveKindViewProps<WakeInfo>) => <WakeCard nudge={props.value} text={userOf(props.input).text} />,
  topic: (props: LiveKindViewProps<TopicBatchInfo>) => <TopicCard batch={props.value} />,
  brief: (props: LiveKindViewProps<LiveUserEntry>) => <BriefRow text={props.value.text} />,
  user: LiveUserRow,
  "assistant-text": (props: LiveKindViewProps<Extract<LiveBlock, { type: "text" }>>) => {
    const facts = factsOf(props.input);
    return (
      <Show when={props.value.text}>
        <AssistantText text={props.value.text} author={facts.author()} model={facts.model()} streaming={facts.streaming()} showHead={facts.showHead()} timing={facts.timing()} time={facts.timing() ? facts.time() : undefined} />
      </Show>
    );
  },
  thinking: (props: LiveKindViewProps<Extract<LiveBlock, { type: "thinking" }>>) => <Thinking text={props.value.text} streaming={factsOf(props.input).streaming()} />,
  align: (props: LiveKindViewProps<AlignRowInfo>) => (
    <div class="entry-live-align" data-align-live={props.value?.doc?.id}>
      <AlignRow row={props.value} newest />
    </div>
  ),
  info: LiveEndRow,
  tour: (props: LiveKindViewProps<TourCardDetails>) => <TourCard details={props.value} />,
  "show-changes": (props: LiveKindViewProps<ShowChangesDetails>) => <ShowChangesCard details={props.value} />,
  offer: (props: LiveKindViewProps<OfferCard>) => <OfferCardView card={props.value} />,
  card: (props: LiveKindViewProps<CardInfo>) => <LiveTranscriptCard item={{ id: callOf(props.input).id, kind: "tool-call", text: RAISE_CARD_TOOL, toolCallId: callOf(props.input).id }} value={props.value} />,
  settings: (props: LiveKindViewProps<SettingsToolDetails>) => <SettingsToolCard details={props.value} />,
  tool: LiveToolRow,
};

const userOf = (input: LiveInput): LiveUserEntry => {
  if (input.kind !== "user") throw new Error("a message's view drawn for another part of the run");
  return input.entry;
};
const factsOf = (input: LiveInput) => {
  if (input.kind !== "text" && input.kind !== "thinking" && input.kind !== "call") throw new Error("a block's view drawn for another part of the run");
  return input.facts;
};
const callOf = (input: LiveInput): LiveCallBlock => {
  if (input.kind !== "call") throw new Error("a call's view drawn for another part of the run");
  return input.block;
};

/** A message going in: yours (queued with its Remove until delivered), or one sent by the Overseer, another chat or a baton person. */
function LiveUserRow(props: LiveKindViewProps<LiveUserEntry>) {
  const rows = useLiveRows();
  const e = props.value;
  /* A message of yours settles with its action strip under it (Thread `strips`, a chat's only: the
     run that offers queueActions); until then this row holds the strip's height empty, so nothing
     below it moves at the handover. */
  const reserve = () => (rows.queueActions ? <div class="message-actions message-actions-end" aria-hidden="true" /> : null);
  return (
    /* A queued row has no `.entry` around it, so it brings the hover/tap region its Remove needs to
       be revealed by (base.css; `display: contents`, so the wrapper changes nothing about how the row
       lays out). */
    <div class="message-actions-host">
      <UserTurn
        text={e.attachments ? stripPastedPaths(e.text) : e.text}
        state={shownUserState(e)}
        origin={e.origin}
        overseer={e.overseer}
        fromSession={e.fromSession}
        sender={e.by ? (rows.names()?.[e.by] ?? (e.by === "operator" ? "You" : "Someone")) : undefined}
        images={e.images}
        attachments={e.attachments}
      />
      <Show when={rows.queueActions && e.state !== "delivered" ? rows.queueActions(e) : null} fallback={reserve()}>
        {(items) => (
          <Show when={items().length > 0} fallback={reserve()}>
            <MessageActions label="Actions for your queued message" align="end" items={items()} />
          </Show>
        )}
      </Show>
    </div>
  );
}

/** The reply's end: stopped by you, or an error (in a held chat, with the limit row and the failure's own provider). */
function LiveEndRow(props: LiveKindViewProps<Extract<LiveInput, { kind: "stopped" | "error" }>>) {
  const rows = useLiveRows();
  const end = props.value;
  return end.kind === "stopped" ? (
    <InfoRow>
      Stopped by you at <code>{stampTime(end.at)}</code>.
    </InfoRow>
  ) : (
    <>
      <TurnError message={end.message} />
      {/* The failure's own row carries its own provider (its producing model): never a worker's,
          never the chat model of right now. */}
      <Show when={rows.limitPath()}>{(p) => <SubagentLimitRow path={p()} message={end.message} provider={rowProvider(end.model)} />}</Show>
    </>
  );
}

/** A call still running or done: its tool card (streamed arguments, output, an earlier tour call's
    line, navigate's Go), or the card its result reads as (a deck card, a link). */
function LiveToolRow(props: LiveKindViewProps<LiveCallBlock>) {
  const rows = useLiveRows();
  const overseerThread = useOverseerThread();
  const b = props.value;
  const tool = () => rows.tool(b.id);
  const status = (): ToolStatus => {
    const t = tool();
    if (t) return t.status;
    return rows.live().running ? "running" : "none";
  };
  /** A card this run raised or changed: the card itself, as soon as the result lands. */
  const card = () => (b.name === CARD_TOOL && status() === "done" ? normalizeCardDetails(tool()?.details) : undefined);
  /** The card at the fold's newest snapshot; null when a later call (this run's too) changed it
      since this one, so this call is a revision line and never takes a click. */
  const deck = () => {
    const own = card()?.card;
    if (!own) return undefined;
    const newest = overseerThread?.card?.(own.id) ?? own;
    return newest.rev > own.rev ? null : newest;
  };
  const linked = () => ((b.name === "sova_link" || b.name === "sova_unlink") && status() === "done" ? linkDetails(tool()?.details) : null);
  /** An earlier call of a tour this run called again: its line (§app.tours/one-card). */
  const tourEarlier = () => {
    const d = TOUR_TOOLS.has(b.name) && status() === "done" ? normalizeTourCardDetails(tool()?.details) : undefined;
    return d && rows.tourCall(d.tourId) !== b.id ? tourLine(d) : undefined;
  };
  return (
    <Show
      when={!card()?.card}
      fallback={
        <Show when={deck()} fallback={<CardRevision card={card()!.card!} line={card()!.line} />}>
          {(c) => <DeckCard card={c()} line={card()!.line} />}
        </Show>
      }
    >
      <Show
        when={linked()}
        fallback={
          <ToolCard
            name={b.name}
            summary={tourEarlier()}
            args={b.args ?? tool()?.args}
            argsText={b.argsText}
            details={tool()?.details}
            status={status()}
            output={tool()?.output}
            images={tool()?.images}
            action={b.name === "sova_navigate" && status() === "done" ? <NavigateGo details={tool()?.details} /> : undefined}
          />
        }
      >
        {(d) => <LinkCard details={d()} ended={b.name === "sova_unlink"} />}
      </Show>
    </Show>
  );
}
