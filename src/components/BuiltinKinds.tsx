import { createMemo, For, Match, Show, Switch, type Component } from "solid-js";
import type { BatonMark } from "../../shared/baton";
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
import { profileIconName } from "../lib/profiles";
import { useThreadRows } from "./thread-rows";
import { AssistantText, Thinking, UserTurn } from "./MessageRows";
import { modelLabel, modelMismatch } from "../lib/format";
import { resultDetails as detailsOf, toolCallArgs, toolResultView } from "../lib/message";
import { confirmDetails } from "../lib/overseer";
import { CARD_TOOL, LEGACY_CONFIRM_TOOL } from "../../shared/overseer-card";
import { profileToolCard, ProfileToolCardView } from "./ProfileCards";
import { BriefRow, CardRevision, ConfirmCard, DeckCard, LinkCard, linkDetails, NavigateGo, OverseerChoiceRow } from "./OverseerCards";
import { toolContent } from "../lib/tool-content";
import { ToolCard, type ToolStatus } from "./ToolCard";
import { AlignCard } from "./AlignCard";
import { ExplainCard } from "./ExplainCard";
import { TeamMessageCard } from "./TeamMessageCard";
import { ReportRow } from "./ReportRow";
import { AlignRow } from "./AlignDocCard";

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
  explain: (props: KindViewProps<NonNullable<NonNullable<TranscriptItem["report"]>["explain"]>>) => <ExplainCard explain={props.value} />,
  "team-report": (props: KindViewProps<NonNullable<NonNullable<TranscriptItem["report"]>["team"]>>) => (
    <TeamMessageCard report={props.item.report!} team={props.value} time={props.item.at} attachments={props.item.attachments} />
  ),
  report: (props: KindViewProps<NonNullable<TranscriptItem["report"]>>) => <ReportRow report={props.value} attachments={props.item.attachments} />,
  baton: (props: KindViewProps<Exclude<BatonMark, { kind: "sent" }>>) => {
    const rows = useThreadRows();
    return <BatonCard mark={props.value} name={rows.nameOf} wrapupShown={rows.wrapupShown()} onWrapupToggle={rows.toggleWrapup} />;
  },
  user: UserRow,
  "assistant-text": ReplyText,
  thinking: (props: KindViewProps) => <Thinking text={props.item.text ?? ""} />,
  "tool-result": OrphanResult,
  tool: ToolRow,
  "align-report": AlignReportRow,
  align: AlignDocRow,
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

/** A baton entry in the operator's transcript (§app.baton/attribution): a hand-off, an offer and its
    lease, a decision, a proposed person, the wrap-up, done. Typed as the full mark so kinds the
    protocol field gains later render here once. */
function BatonCard(props: { mark: Exclude<BatonMark, { kind: "sent" }>; name(ref: string): string; wrapupShown: boolean; onWrapupToggle(): void }) {
  const m = props.mark;
  const names = (refs: string[]) => refs.map(props.name).join(", ");
  return (
    <Switch>
      <Match when={m.kind === "handoff" && m}>
        {(h) => (
          <aside class="baton-card" aria-label={`Hand-off ${h().n}`}>
            <span class="baton-card-head">
              Hand-off {h().n}: {props.name(h().from)} → {props.name(h().to)}
            </span>
            <div class="baton-card-body">{h().question}</div>
            <Show when={h().briefing}>
              <div class="baton-card-brief">Briefing: {h().briefing}</div>
            </Show>
          </aside>
        )}
      </Match>
      <Match when={m.kind === "offer" && m}>
        {(o) => (
          <aside class="baton-card" aria-label={`Offer, hand-off ${o().n}`}>
            <span class="baton-card-head">
              Hand-off {o().n}: {props.name(o().from)} → offered to {names(o().to)}
            </span>
            <div class="baton-card-body">{o().question}</div>
            <Show when={o().briefing}>
              <div class="baton-card-brief">Briefing: {o().briefing}</div>
            </Show>
          </aside>
        )}
      </Match>
      <Match when={m.kind === "lease" && m}>
        {(l) => (
          <p class="baton-card-line">
            {l().event === "claimed" ? `${props.name(l().by)} took the offer.` : `${props.name(l().by)} went quiet, so the offer is open to every invitee again.`}
          </p>
        )}
      </Match>
      <Match when={m.kind === "decision" && m}>
        {(d) => (
          <aside class="baton-card" aria-label="Decision">
            <span class="baton-card-head">
              Decision · {d().area} · {props.name(d().by)}
            </span>
            <div class="baton-card-body">{d().statement}</div>
            <div class="baton-card-quote">“{d().quote}”</div>
          </aside>
        )}
      </Match>
      <Match when={m.kind === "proposal" && m}>
        {(r) => (
          <aside class="baton-card" aria-label={`Proposed: ${r().name}`}>
            <span class="baton-card-head">
              Proposed for the roster · {r().name}
              {r().role ? ` (${r().role})` : ""} · by {props.name(r().by)}
            </span>
            <div class="baton-card-body">{r().why}</div>
          </aside>
        )}
      </Match>
      <Match when={m.kind === "wrapup" && m}>
        {(w) => {
          const end = () => (w().phase === "end" ? (w() as Extract<BatonMark, { kind: "wrapup"; phase: "end" }>) : null);
          return (
            <Show
              when={end()}
              fallback={
                <p class="baton-card-line">
                  Wrap-up turn: it reads this session for profile updates and quotes profiles, so it's folded here.{" "}
                  <button type="button" class="button button-sm button-ghost" aria-expanded={props.wrapupShown} onClick={() => props.onWrapupToggle()}>
                    {props.wrapupShown ? "Fold Wrap-up Turn" : "Show Wrap-up Turn"}
                  </button>
                </p>
              }
            >
              {(e) => (
                <aside class="baton-card" aria-label="Wrap-up">
                  <span class="baton-card-head">Wrap-up</span>
                  <div class="baton-card-body">
                    {e().error
                      ? `Stopped: ${e().error} No profile changed after that.`
                      : `${e().applied.length} profile ${e().applied.length === 1 ? "field" : "fields"} updated${e().refused.length ? `, ${e().refused.length} refused` : ""}.`}
                  </div>
                  <For each={e().applied}>{(a) => <div class="baton-card-brief">{props.name(a.personId)} · {a.field}</div>}</For>
                  <For each={e().refused}>
                    {(r) => (
                      <div class="baton-card-brief">
                        Refused: {props.name(r.personId)} · {r.field} — {r.reason}
                      </div>
                    )}
                  </For>
                </aside>
              )}
            </Show>
          );
        }}
      </Match>
      <Match when={m.kind === "done" && m}>
        {(d) => (
          <aside class="baton-card" aria-label="Done">
            <span class="baton-card-head">Done</span>
            <div class="baton-card-body">{d().summary}</div>
          </aside>
        )}
      </Match>
    </Switch>
  );
}

/** A user's turn, with who sent it when its marker says: the Overseer, a baton person, another session. */
function UserRow(props: KindViewProps) {
  const rows = useThreadRows();
  const item = props.item;
  return (
    <UserTurn
      text={item.text ?? ""}
      time={item.at}
      overseer={rows.senderOf(item.id)?.kind === "overseer"}
      sender={((s) => (s?.kind === "baton" ? rows.nameOf(s.by) : undefined))(rows.senderOf(item.id))}
      fromSession={((s) => (s?.kind === "session" ? { sessionId: s.sessionId, title: s.title, hop: s.hop } : undefined))(rows.senderOf(item.id))}
      images={item.images}
      attachments={item.attachments}
    />
  );
}

/** A reply's text; its head shows unless the row above is the same model's reply text. */
function ReplyText(props: KindViewProps) {
  const rows = useThreadRows();
  const item = props.item;
  const above = () => rows.row((props.index?.() ?? 0) - 1);
  return (
    <AssistantText
      text={item.text ?? ""}
      author={modelLabel(item.model, item.answered) ?? rows.author()}
      model={[item.model, modelMismatch(item.model, item.answered)].filter(Boolean).join(" · ") || undefined}
      time={item.at}
      showHead={above()?.kind !== "assistant-text" || above()?.model !== item.model}
      attachments={item.attachments}
      timing={rows.timing(item.id)}
    />
  );
}

/** A tool result: a paired one draws inside its call's card (nothing here); an orphan gets its own. */
function OrphanResult(props: KindViewProps) {
  const rows = useThreadRows();
  const item = props.item;
  return (
    <Show when={!item.toolCallId || !rows.hasCall(item.toolCallId)}>
      {(() => {
        const view = toolResultView(item);
        const source = rows.toolSource();
        const lazy = source && item.tool?.lazy ? toolContent.handle(source, item.id, { resultId: item.id, size: item.tool.bytes }) : undefined;
        return (
          <ToolCard
            name="result"
            args={undefined}
            lazy={lazy}
            status={view.isError ? "error" : "done"}
            output={view.output}
            images={item.images}
            attachments={item.attachments}
          />
        );
      })()}
    </Show>
  );
}

/** A tool call: its card (a deck card, a legacy confirm, a link, a profile's send) when its result
    reads as one, else the tool card with its result folded in. */
function ToolRow(props: KindViewProps) {
  const rows = useThreadRows();
  const item = props.item;
  const source = rows.toolSource();
  const view = () => {
    const r = item.toolCallId ? rows.result(item.toolCallId) : undefined;
    return r ? toolResultView(r) : undefined;
  };
  const status = (): ToolStatus => {
    const v = view();
    if (v) return v.isError ? "error" : "done";
    return rows.running(props.index?.() ?? 0) ? "running" : "none";
  };
  const resultDetails = () => {
    const r = item.toolCallId ? rows.result(item.toolCallId) : undefined;
    return r ? detailsOf(r) : undefined;
  };
  // A legacy card (from before card ids): read-only, answered by the rule it had then.
  const confirm = () =>
    item.text === LEGACY_CONFIRM_TOOL && status() !== "error"
      ? (confirmDetails(resultDetails()) ?? confirmDetails(toolCallArgs(item)))
      : null;
  const card = () => (item.text === CARD_TOOL && status() === "done" ? rows.cardRow(item) : undefined);
  /** A made or ended link reads as a card naming its members (§app.overseer/links-tools);
      running or failed, the plain tool card. */
  const linked = () =>
    (item.text === "sova_link" || item.text === "sova_unlink") && status() === "done" ? linkDetails(resultDetails()) : null;
  /** session_send and a profile's sova_create_session read as cards (§chat.profiles/delivery). */
  /** The arguments and output its rows don't carry, asked for by the call's row id. */
  const lazy = createMemo(() => {
    const r = item.toolCallId ? rows.result(item.toolCallId) : undefined;
    if (!source || !(item.tool?.lazy || r?.tool?.lazy)) return undefined;
    return toolContent.handle(source, item.id, { resultId: r?.id, callId: item.toolCallId, size: (item.tool?.bytes ?? 0) + (r?.tool?.bytes ?? 0) });
  });
  const profileCard = () => profileToolCard(item.text, status(), toolCallArgs(item), resultDetails(), view()?.output);
  return (
    <Show
      when={!card()}
      fallback={
        <Show when={card()!.newest} fallback={<CardRevision card={card()!.card} line={card()!.details.line} />}>
          <DeckCard card={card()!.card} line={card()!.details.line} />
        </Show>
      }
    >
    <Show
      when={confirm()}
      fallback={
    <Show
      when={linked()}
      fallback={
    <Show
      when={profileCard()}
      fallback={
    <ToolCard
      name={item.text ?? "tool"}
      args={toolCallArgs(item)}
      summary={rows.tourEarlier(item) ?? item.tool?.summary}
      stats={(item.text === "edit" || item.text === "write") && item.toolCallId ? rows.result(item.toolCallId)?.tool?.stats : undefined}
      calls={item.toolCallId ? rows.result(item.toolCallId)?.tool?.calls : undefined}
      lazy={lazy()}
      details={resultDetails()}
      status={status()}
      output={view()?.output}
      images={item.toolCallId ? rows.result(item.toolCallId)?.images : undefined}
      attachments={item.toolCallId ? rows.result(item.toolCallId)?.attachments : undefined}
      action={item.text === "sova_navigate" && status() === "done" ? <NavigateGo details={resultDetails()} /> : undefined}
    />
      }
    >
      {(card) => <ProfileToolCardView card={card()} />}
    </Show>
      }
    >
      {(d) => <LinkCard details={d()} ended={item.text === "sova_unlink"} />}
    </Show>
      }
    >
      {(details) => {
        const answer = () => rows.confirmAnswer(item, details());
        return <ConfirmCard details={details()} answered={answer().answered} choice={answer().choice} />;
      }}
    </Show>
    </Show>
  );
}

/** An alignment report from before the alignment document: only the newest draws its card. */
function AlignReportRow(props: KindViewProps<NonNullable<NonNullable<TranscriptItem["report"]>["align"]>>) {
  const rows = useThreadRows();
  return (
    <Show when={props.item.id === rows.latestAlign()} fallback={<span class="align-superseded" hidden />}>
      <AlignCard report={props.item.report!} align={props.value} attachments={props.item.attachments} />
    </Show>
  );
}

/** An alignment document's revision: the newest draws the whole card, each earlier one a line. */
function AlignDocRow(props: KindViewProps<NonNullable<TranscriptItem["align"]>>) {
  const rows = useThreadRows();
  return <AlignRow row={props.value} newest={rows.alignNewest(props.item)} />;
}
