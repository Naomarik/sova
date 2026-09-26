import { createContext, For, Show, useContext } from "solid-js";
import type { OverseerQuickAction, SovaConfirmDetails } from "../../shared/protocol";
import { briefBody, confirmReply, goTo, navigateDetails, settingsTarget } from "../lib/overseer";
import { clockTime } from "../lib/format";
import { openSettings } from "../lib/settings-nav";
import { ActionMenu } from "./ActionMenu";
import { Markdown } from "./Markdown";
import { Icon } from "./ui";

/**
 * What an Overseer chat hands its thread: how a confirm card's button answers. Absent everywhere
 * else (a history file, another session's transcript), where a confirm card is shown but can't
 * be answered.
 */
export interface OverseerThread {
  /** Sends `text` as the user's next message; false when it couldn't be sent. */
  answer(text: string): boolean;
}
export const OverseerThreadContext = createContext<OverseerThread | null>(null);
export const useOverseerThread = () => useContext(OverseerThreadContext);

/**
 * `sova_confirm`, drawn as the question it asks. Its buttons send the choice as the user's next
 * message. Once any later user message exists the card is answered: the buttons go and the
 * choice is said, so a reload or a restart shows the same thing, because it lives in the transcript.
 */
export function ConfirmCard(props: { details: SovaConfirmDetails; answered: boolean; choice: string | null; pending?: boolean }) {
  const thread = useOverseerThread();
  const canAnswer = () => !!thread && !props.answered && !props.pending;
  return (
    <section class="card overseer-confirm" aria-label={`Question: ${props.details.title}`}>
      <div class="card-head">
        <Icon name="eye" small />
        <h3 class="card-title" title={props.details.title}>
          {props.details.title}
        </h3>
      </div>
      <Show when={props.details.detail}>
        <div class="card-body overseer-confirm-detail">{props.details.detail}</div>
      </Show>
      <div class="card-foot">
        <Show
          when={!props.answered}
          fallback={
            <p class="overseer-confirm-answer">
              <Icon name="check" small />
              <Show when={props.choice} fallback="Answered below.">
                {(c) => (
                  <span>
                    You chose <strong>{c()}</strong>.
                  </span>
                )}
              </Show>
            </p>
          }
        >
          <For each={props.details.options}>
            {(o) => (
              <button
                type="button"
                class={`button button-sm${o.tone === "danger" ? " button-destructive" : ""}`}
                aria-disabled={canAnswer() ? undefined : "true"}
                title={!thread ? "Read only." : props.pending ? "Wait for the turn to end." : undefined}
                onClick={() => canAnswer() && thread!.answer(confirmReply(o))}
              >
                {o.label}
              </button>
            )}
          </For>
          <Show when={thread && !props.pending}>
            <span class="overseer-confirm-hint">Or type your answer.</span>
          </Show>
        </Show>
      </div>
    </section>
  );
}

/**
 * A navigate result's "Go": the same target the tab that asked was moved to, for every other
 * reader — another tab, a reload, the history. A route is a link; a Settings target is a button.
 */
export function NavigateGo(props: { details: unknown }) {
  const nav = () => navigateDetails(props.details);
  return (
    <Show when={nav()}>
      {(n) => (
        <Show
          when={!settingsTarget(n().href)}
          fallback={
            <button type="button" class="button button-sm button-ghost overseer-go" title={n().label} onClick={() => goTo(n().href)}>
              Go
              <Icon name="arrow-right" small />
            </button>
          }
        >
          <a class="button button-sm button-ghost overseer-go" href={n().href} title={n().label}>
            Go
            <Icon name="arrow-right" small />
          </a>
        </Show>
      )}
    </Show>
  );
}

/** A proactive brief: a machine row, like a wake nudge — the server wrote it, not you. Its body is
    markdown (a list of blockers, each a sova:// link), rendered like the Overseer's own replies. */
export function BriefRow(props: { text: string; time?: string }) {
  return (
    <div class="overseer-brief" role="note">
      <div class="info-row overseer-machine-row">
        <span class="info-row-text">
          <Icon name="eye" small />
          <span>Brief{props.time ? ` · ${clockTime(props.time)}` : ""}</span>
        </span>
      </div>
      <div class="overseer-brief-body">
        <Markdown text={briefBody(props.text)} />
      </div>
    </div>
  );
}

/** The Overseer answered this session's dialog: a machine row, never a message of yours. */
export function OverseerChoiceRow(props: { title: string; answer: string }) {
  return (
    <div class="info-row overseer-machine-row" role="note">
      <span class="info-row-text" title={props.title}>
        <Icon name="eye" small />
        <span>
          Overseer chose: <strong>{props.answer}</strong>
        </span>
      </span>
    </div>
  );
}

/**
 * The Overseer's one button at the right end of its composer foot, where other chats have their
 * mode switch: a menu of quick actions, each with the line that says what it asks. Picking one sends its prompt — while a turn runs it waits in the
 * queue like any follow-up. Edited in Settings → Overseer.
 */
export function QuickActions(props: { actions: OverseerQuickAction[]; onPick(prompt: string): void; disabled?: string | null }) {
  return (
    <ActionMenu label="Quick Actions" title="Quick actions · ask the Overseer" icon="command" text="Quick Actions" align="end" class="button-ghost quick-actions-trigger">
      {(menu) => (
        <Show
          when={props.actions.length > 0}
          fallback={
            <menu.Item
              label="No quick actions"
              aria="No quick actions. Add them in Settings, Overseer."
              description="Add them in Settings → Overseer."
              onRun={() => openSettings("overseer")}
            />
          }
        >
          <For each={props.actions}>
            {(a) => (
              <menu.Item
                label={a.label}
                aria={`${a.label}: ${a.description}`}
                title={a.prompt}
                description={a.description}
                disabled={props.disabled ?? undefined}
                onRun={() => props.onPick(a.prompt)}
              />
            )}
          </For>
        </Show>
      )}
    </ActionMenu>
  );
}
