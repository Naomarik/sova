import { createContext, createSignal, For, Show, useContext } from "solid-js";
import type { OverseerQuickAction, SovaConfirmDetails, SovaConfirmItem } from "../../shared/protocol";
import type { MeshLinkView } from "../../shared/mesh-links";
import { briefBody, confirmReply, confirmRows, goTo, navigateDetails, settingsTarget } from "../lib/overseer";
import { clockTime, relativeTime } from "../lib/format";
import { groupLinkIndex, resolveAppLink, sessionIndex, sessionIndexVersion } from "../lib/session-links";
import { personHref, projectHref } from "../lib/orgs-route";
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
  /** Sends `text` as the user's next message; false when it couldn't be sent. `card`: the confirm
      card's tool call id, so the server knows a click (never typed text) opened the turn. */
  answer(text: string, card?: string): boolean;
}
export const OverseerThreadContext = createContext<OverseerThread | null>(null);
export const useOverseerThread = () => useContext(OverseerThreadContext);

/**
 * `sova_confirm`, drawn as the question it asks. Its buttons send the choice as the user's next
 * message. Once any later user message exists the card is answered: the buttons go and the
 * choice is said, so a reload or a restart shows the same thing, because it lives in the transcript.
 */
export function ConfirmCard(props: { details: SovaConfirmDetails; answered: boolean; choice: string | null; pending?: boolean; card?: string }) {
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
      <Show when={props.details.items?.length}>
        <ConfirmItems items={props.details.items!} />
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
                onClick={() => canAnswer() && thread!.answer(confirmReply(o), props.card)}
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
 * What a confirm card is about: the sessions, ideas, todos, projects and people the server resolved
 * when the card was raised, as a snapshot. Ideas, todos, projects and people come first and always
 * show; only the sessions after them collapse (confirmRows). A session links to its route, named by
 * its summary (else its title); an idea is its id and title as text, never a link; a todo is its
 * text; a project and a person link to their page, with the org after the name (and a person's
 * status chip unless active). Each may carry the Overseer's note under it.
 */
function ConfirmItems(props: { items: SovaConfirmItem[] }) {
  const [all, setAll] = createSignal(false);
  const view = () => confirmRows(props.items, all());
  return (
    <div class="card-body overseer-confirm-items">
      <ul class="overseer-confirm-list" aria-label={`${props.items.length} ${props.items.length === 1 ? "item" : "items"}`}>
        <For each={view().rows}>{(it) => <ConfirmItemRow item={it} />}</For>
      </ul>
      <Show when={view().collapsible}>
        <button type="button" class="button button-ghost button-sm overseer-confirm-more" aria-expanded={all()} onClick={() => setAll(!all())}>
          <Icon name={all() ? "chevron-down" : "chevron-right"} small />
          {all() ? "Show fewer" : `Show all ${view().sessions} sessions`}
        </button>
      </Show>
    </div>
  );
}

/** The Overseer's note on an item: what it is and why the card acts on it, up to 2 lines. */
function ItemNote(props: { note?: string }) {
  return (
    <Show when={props.note}>
      <span class="overseer-confirm-item-note" title={props.note}>
        {props.note}
      </span>
    </Show>
  );
}

function ConfirmItemRow(props: { item: SovaConfirmItem }) {
  const it = props.item;
  if (it.kind === "idea")
    return (
      <li class="overseer-confirm-item">
        <span class="overseer-confirm-item-line">
          <span class="overseer-confirm-idea-id">{it.id}</span>
          <Show when={it.title}>
            <span class="overseer-confirm-item-name"> — {it.title}</span>
          </Show>
        </span>
        <ItemNote note={it.note} />
      </li>
    );
  if (it.kind === "todo")
    return (
      <li class="overseer-confirm-item">
        <span class="overseer-confirm-item-line">
          <span class="overseer-confirm-item-name">{it.text}</span>
        </span>
        <ItemNote note={it.note} />
      </li>
    );
  if (it.kind === "project" || it.kind === "person") {
    const href = it.kind === "project" ? projectHref(it.orgId, it.id) : personHref(it.orgId, it.id);
    return (
      <li class="overseer-confirm-item">
        <span class="overseer-confirm-item-line">
          <a class="overseer-confirm-item-name" href={href}>
            {it.name}
          </a>
          <span class="overseer-confirm-item-meta">{it.orgName}</span>
          <Show when={it.kind === "person" && it.status !== "active" ? it.status : null}>
            {(st) => (
              <span class={`chip ${st() === "proposed" ? "chip-info" : ""}`}>
                <span class="chip-dot" />
                {st() === "proposed" ? "Proposed" : "Left"}
              </span>
            )}
          </Show>
        </span>
        <ItemNote note={it.note} />
      </li>
    );
  }
  /** The session's route, and its title now (else the snapshot's). */
  const view = () => {
    sessionIndexVersion();
    const v = resolveAppLink(`sova://s/${it.id}`, sessionIndex(), groupLinkIndex());
    return v?.kind === "route" ? { href: v.href, title: v.title ?? it.title } : null;
  };
  // The summary names the work; the title is the first prompt, so it is only the fallback.
  const name = () => it.summary ?? view()?.title ?? it.title;
  const meta = () => [it.project, it.lastActiveAt ? relativeTime(it.lastActiveAt) : ""].filter(Boolean).join(" · ");
  return (
    <li class="overseer-confirm-item">
      <span class="overseer-confirm-item-line">
        <Show when={view()} fallback={<span class="overseer-confirm-item-name">{name()}</span>}>
          {(v) => (
            <a class="overseer-confirm-item-name" href={v().href} title={v().title}>
              {name()}
            </a>
          )}
        </Show>
        <Show when={meta()}>
          <span class="overseer-confirm-item-meta">{meta()}</span>
        </Show>
        <Show when={it.workers}>
          {(n) => (
            <span class="chip chip-warn">
              <span class="chip-dot" />
              {n()} {n() === 1 ? "subagent" : "subagents"} working
            </span>
          )}
        </Show>
      </span>
      <ItemNote note={it.note} />
    </li>
  );
}

/** A sova_link / sova_unlink result's details (the link as this host saw it then), or null. */
export function linkDetails(v: unknown): MeshLinkView | null {
  const d = v as MeshLinkView | null | undefined;
  if (!d || typeof d !== "object" || typeof d.link?.id !== "string" || !Array.isArray(d.members)) return null;
  return d.members.every((m) => m && typeof m.hostLabel === "string" && typeof m.sessionId === "string") ? d : null;
}

/**
 * `sova_link` and `sova_unlink`, drawn as the link they made or ended: its members with their
 * hosts (§app.overseer/links-tools). A snapshot of the call, not a live view: states live in the
 * Agents tab. A member on this host opens its session; one on another host is named, not linked.
 */
export function LinkCard(props: { details: MeshLinkView; ended: boolean }) {
  const title = () => (props.ended ? "Link ended" : `Linked ${props.details.members.length} sessions`);
  return (
    <section class="card overseer-link" aria-label={`${title()}: ${props.details.link.id}`}>
      <div class="card-head">
        <Icon name="network" small />
        <h3 class="card-title">{title()}</h3>
        <span class="overseer-link-id">{props.details.link.id}</span>
      </div>
      <ul class="card-body overseer-link-members">
        <For each={props.details.members}>
          {(m) => (
            <li>
              <span class="overseer-link-host">{m.self ? "This host" : m.hostLabel}</span>
              <Show when={m.self} fallback={<span title={m.sessionId}>{m.title ?? m.sessionId}</span>}>
                <a href={`#/s/${encodeURIComponent(m.path)}`} title={m.sessionId}>
                  {m.title ?? m.sessionId}
                </a>
              </Show>
            </li>
          )}
        </For>
      </ul>
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
