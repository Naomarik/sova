import { createContext, createEffect, createMemo, createSignal, For, type JSX, on, Show, useContext } from "solid-js";
import type { OverseerQuickAction, SovaConfirmDetails, SovaConfirmItem } from "../../shared/protocol";
import {
  answerOptions,
  cardLetter,
  choiceByLetter,
  choicesOf,
  hasChoices,
  itemsClick,
  linkOptions,
  optionByLetter,
  optionClick,
  type CardItem,
  type OverseerCard,
} from "../../shared/overseer-card";
import { actsText, GRANT_DEFAULT_MS, GRANTABLE_ACTS, type Permit, sessionsText } from "../../shared/overseer-grants";
import type { MeshLinkView } from "../../shared/mesh-links";
import { briefBody, confirmRows, goTo, navigateDetails, settingsTarget } from "../lib/overseer";
import { scrollToCardId } from "../lib/card-refs";
import { clockTime, relativeTime, stampTime } from "../lib/format";
import { groupLinkIndex, resolveAppLink, sessionActiveAt, sessionIndex, sessionIndexVersion } from "../lib/session-links";
import { personHref } from "../lib/orgs-route";
import { projectHref } from "../lib/projects-route";
import { openSettings } from "../lib/settings-nav";
import { ActionMenu } from "./ActionMenu";
import { Markdown } from "./Markdown";
import { Icon } from "./ui";

/**
 * What an Overseer chat hands its thread: how a card's click answers. Absent everywhere else (a
 * history file, another session's transcript), where a card is shown but can't be answered; its
 * link options still open.
 */
export interface OverseerThread {
  /** Sends `text` as the user's next message; false when it couldn't be sent. `card`: the card's id
      (`c_N`), so the server knows a click (never typed text) opened the turn; `sent`: what the click
      chose ("b", "1a, 2b"), shown on the card while the turn it started runs. */
  answer(text: string, card?: string, sent?: string): boolean;
  /** What a click on `card` sent, while the turn it started runs; undefined otherwise. */
  sent(card: string): string | undefined;
  /** The conversation's approvals and rules, for an option's state line (§app.overseer/approvals). */
  permits?(): Permit[];
  /** The fold's newest snapshot of a card (settled rows and this run's results), so a live call
      that a later call in the same run changed draws as a revision, never as live buttons. */
  card?(id: string): OverseerCard | undefined;
}
export const OverseerThreadContext = createContext<OverseerThread | null>(null);
export const useOverseerThread = () => useContext(OverseerThreadContext);

/**
 * A legacy `sova_confirm` card (§app.overseer/confirm, from before card ids), read-only: the
 * question it asked and its items; "You chose X" or "Answered below." by the rule it had then (any
 * later user message answered it), else no buttons and a line saying to ask again.
 */
export function ConfirmCard(props: { details: SovaConfirmDetails; answered: boolean; choice: string | null }) {
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
        <Show when={props.answered} fallback={<span class="overseer-confirm-hint">From before card ids: ask the Overseer again.</span>}>
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
        </Show>
      </div>
    </section>
  );
}

/** Scrolls the thread to a card's full rendering, when it is on screen. */
export const scrollToCard = scrollToCardId;

/**
 * A `sova_card` card at its newest snapshot (§app.overseer/confirm): the id as the eyebrow, the
 * title, detail, numbered items (each with its per-item choices when the card has them) and the
 * lettered options. Its state comes from the fold, never from later messages. A click only composes
 * a message ("c_4 b: …"); the model records it. Link options open their target, in every state and
 * in read-only views, and never answer the card.
 */
export function DeckCard(props: { card: OverseerCard; line?: string }) {
  const thread = useOverseerThread();
  const open = () => props.card.phase === "open";
  const sent = () => (thread ? thread.sent(props.card.id) : undefined);
  const canAnswer = () => !!thread && open() && !sent();
  const why = () => (!thread ? "Read only." : sent() ? "Wait for the turn to end." : undefined);
  /** The per-item picks, from each item's decided choice, else its default. */
  const initial = () => Object.fromEntries(props.card.items.flatMap((it) => { const l = it.decided?.choice ?? it.default; return l ? [[it.n, l]] : []; })) as Record<number, string>;
  const [picks, setPicks] = createSignal<Record<number, string>>(initial());
  // A newer snapshot (a partial answer recorded, a reopen) starts the picks again from it; a memo,
  // so a fresh card object with the same rev never resets the user's picks.
  const rev = createMemo(() => props.card.rev);
  createEffect(on(rev, () => setPicks(initial()), { defer: true }));
  /** What Apply sends: the items picked whose pick isn't already their recorded choice. */
  const applyPicks = () => Object.fromEntries(Object.entries(picks()).filter(([n, l]) => props.card.items.find((it) => it.n === Number(n))?.decided?.choice !== l)) as Record<number, string>;
  const applyText = () => itemsClick(props.card, applyPicks());
  const click = (letter: string) => {
    const text = optionClick(props.card, letter);
    if (text && canAnswer()) thread!.answer(text, props.card.id, letter);
  };
  const apply = () => {
    const text = applyText();
    if (!text || !canAnswer()) return;
    thread!.answer(text, props.card.id, Object.entries(applyPicks()).map(([n, l]) => `${n}${l}`).join(", "));
  };
  const rec = () => props.card.recommendation;
  return (
    <section class="card overseer-confirm overseer-card" data-card-id={props.card.id} data-phase={props.card.phase} aria-label={`Card ${props.card.id}: ${props.card.title}`}>
      <div class="card-head overseer-card-head">
        <span class="text-mono overseer-card-id">{props.card.id}</span>
        <h3 class="card-title" title={props.card.title}>
          {props.card.title}
        </h3>
        <Show when={props.line}>
          <span class="overseer-card-change">{props.line}</span>
        </Show>
      </div>
      <Show when={props.card.detail}>
        <div class="card-body overseer-confirm-detail">{props.card.detail}</div>
      </Show>
      <Show when={props.card.items.length}>
        <ConfirmItems
          items={props.card.items}
          since={open() ? props.card.createdAt : undefined}
          below={(item) => <CardItemAnswer card={props.card} item={item as CardItem} pick={picks()[(item as CardItem).n]} disabled={!canAnswer()} onPick={(l) => setPicks({ ...picks(), [(item as CardItem).n]: l })} />}
        />
      </Show>
      <div class="card-foot overseer-card-foot">
        <Show when={open()} fallback={<CardOutcome card={props.card} />}>
          <Show when={rec()}>
            {(r) => (
              <p class="overseer-card-rec">
                <span class="align-q-kicker">Recommended</span>
                <Show when={r().option}>
                  {(l) => (
                    <>
                      <span class="text-mono align-q-letter">{l()}</span> — <strong>{optionByLetter(props.card, l())?.label}</strong>.{" "}
                    </>
                  )}
                </Show>
                {r().why}
              </p>
            )}
          </Show>
          <div class="overseer-card-buttons">
            <For each={answerOptions(props.card)}>
              {(o) => (
                <button
                  type="button"
                  class={`button button-sm${o.option.tone === "danger" ? " button-destructive" : ""}`}
                  aria-disabled={canAnswer() ? undefined : "true"}
                  aria-label={`${o.letter}: ${o.option.label}`}
                  title={why() ?? o.option.reply}
                  onClick={() => click(o.letter)}
                >
                  <span class="text-mono overseer-card-letter">{o.letter}</span>
                  {o.option.label}
                </button>
              )}
            </For>
            <Show when={hasChoices(props.card)}>
              <button
                type="button"
                class="button button-sm button-primary overseer-card-apply"
                aria-disabled={canAnswer() && applyText() ? undefined : "true"}
                title={why() ?? (applyText() ?? "Pick a choice on an item first.")}
                onClick={apply}
              >
                Apply
              </button>
            </Show>
            <CardLinks card={props.card} />
          </div>
          <OptionGrants card={props.card} />
          <Show when={sent()} fallback={<Show when={thread && !props.card.clickOnly}><span class="overseer-confirm-hint">Or type your answer.</span></Show>}>
            {(s) => <span class="overseer-confirm-hint">Sent: {s()}</span>}
          </Show>
        </Show>
        <For each={(thread?.permits?.() ?? []).filter((p) => p.card === props.card.id && !p.from)}>{(p) => <p class="overseer-card-permit">{permitState(p)}</p>}</For>
        <Show when={!open() && linkOptions(props.card).length}>
          <div class="overseer-card-buttons">
            <CardLinks card={props.card} />
          </div>
        </Show>
      </div>
    </section>
  );
}

/** What an option's click approves, under the buttons: "b · Approves any act on these 2 sessions
    until 6:00 PM" / "c · Adopts a standing rule: …" (§app.overseer/approvals). */
function OptionGrants(props: { card: OverseerCard }) {
  const sessions = () => props.card.items.filter((it) => it.kind === "session").length;
  return (
    <For each={answerOptions(props.card).filter((o) => o.option.later || o.option.rule)}>
      {(o) => (
        <p class="overseer-card-grant">
          <span class="text-mono align-q-letter">{o.letter}</span>{" "}
          {o.option.later
            ? `Approves any act on ${sessionsText(sessions())} until ${stampTime(o.option.later.until ?? Date.parse(o.option.later.at) + GRANT_DEFAULT_MS)}, without you.`
            : `Adopts a standing rule until you revoke it: ${o.option.rule!.text} (${actsText(o.option.rule!.acts ?? [...GRANTABLE_ACTS])} on ${o.option.rule!.anySession ? "any session" : sessionsText(sessions())}).`}
        </p>
      )}
    </For>
  );
}

/** "Approved until 6:00 PM (g_2)", "Expired (g_2)", "Revoked (g_2)"; "Rule r_1 adopted" / "Rule r_1 revoked". */
export function permitState(p: Permit): string {
  if (p.kind === "rule") return p.status === "revoked" ? `Rule ${p.id} revoked` : `Rule ${p.id} adopted`;
  return p.status === "live" ? `Approved until ${stampTime(p.until!)} (${p.id})` : `${p.status === "expired" ? "Expired" : "Revoked"} (${p.id})`;
}

/** A card's link options: an in-app target opens in this tab (a route as a link, Settings as a
    button), an https URL in a new tab. Never a message, never a turn. */
function CardLinks(props: { card: OverseerCard }) {
  return (
    <For each={linkOptions(props.card)}>
      {(o) => {
        const href = o.href!;
        if (href.startsWith("https://"))
          return (
            <a class="button button-sm button-ghost overseer-card-link" href={href} target="_blank" rel="noopener noreferrer" title={href}>
              {o.label}
              <Icon name="external" small />
            </a>
          );
        if (settingsTarget(href))
          return (
            <button type="button" class="button button-sm button-ghost overseer-card-link" title={o.label} onClick={() => goTo(href)}>
              {o.label}
              <Icon name="arrow-right" small />
            </button>
          );
        return (
          <a class="button button-sm button-ghost overseer-card-link" href={href} title={o.label}>
            {o.label}
            <Icon name="arrow-right" small />
          </a>
        );
      }}
    </For>
  );
}

/** A closed card's state: answered (the option, or the user's words), replaced, or dropped. */
function CardOutcome(props: { card: OverseerCard }) {
  const c = () => props.card;
  return (
    <p class="overseer-confirm-answer">
      <Show when={c().phase === "answered"}>
        <Icon name="check" small />
        <Show
          when={c().answer?.option}
          fallback={
            <span>
              {c().answer?.by === "accepted-recommendation" ? "Took the recommendation" : "Answered"}: {c().answer?.text}
            </span>
          }
        >
          {(l) => (
            <span>
              {c().answer?.by === "accepted-recommendation" ? "Took the recommendation" : "You chose"} <span class="text-mono">{l()}</span> —{" "}
              <strong>{optionByLetter(c(), l())?.label}</strong>
            </span>
          )}
        </Show>
      </Show>
      <Show when={c().phase === "superseded"}>
        <span>
          Replaced by{" "}
          <button type="button" class="overseer-card-jump text-mono" onClick={() => scrollToCard(c().supersededBy!)}>
            {c().supersededBy}
          </button>
        </span>
      </Show>
      <Show when={c().phase === "dropped"}>
        <span>Dropped: {c().droppedWhy}</span>
      </Show>
    </p>
  );
}

/** Under an item with choices (its own, else the card's): its recorded answer, and (open) a
    segmented control of its own row's choices set to its pick. A row without choices shows only a
    recorded answer. */
function CardItemAnswer(props: { card: OverseerCard; item: CardItem; pick?: string; disabled: boolean; onPick(letter: string): void }) {
  const name = `card-${props.card.id}-${props.item.n}-${Math.random().toString(36).slice(2, 8)}`;
  const decided = () => props.item.decided;
  const row = () => choicesOf(props.card, props.item);
  return (
    <>
      <Show when={decided()}>
        {(d) => (
          <span class="overseer-card-decided">
            <Icon name="check" small />
            {d().choice ? (
              <>
                <span class="text-mono">{d().choice}</span> {choiceByLetter(props.card, props.item, d().choice!)?.label ?? d().text}
              </>
            ) : (
              d().text
            )}
            <Show when={d().by === "accepted-recommendation"}> · recommendation</Show>
          </span>
        )}
      </Show>
      <Show when={row() && props.card.phase === "open"}>
        <div class="overseer-card-seg" role="radiogroup" aria-label={`Item ${props.item.n}`}>
          <For each={row()}>
            {(c, i) => (
              <label class="overseer-card-seg-opt">
                <input type="radio" name={name} value={cardLetter(i())} checked={props.pick === cardLetter(i())} disabled={props.disabled} onChange={() => props.onPick(cardLetter(i()))} />
                <span class="text-mono">{cardLetter(i())}</span>
                <span>{c.label}</span>
              </label>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

/** An earlier snapshot of a card: one line, its id, title and what that call changed. */
export function CardRevision(props: { card: OverseerCard; line: string }) {
  return (
    <div class="info-row overseer-card-rev" role="note">
      <span class="info-row-text">
        <span class="text-mono">{props.card.id}</span>
        <span class="overseer-card-rev-title">{props.card.title}</span>
        <Show when={props.line}>
          <span> · {props.line}</span>
        </Show>
      </span>
    </div>
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
function ConfirmItems(props: { items: SovaConfirmItem[]; since?: string; below?: (item: SovaConfirmItem) => JSX.Element }) {
  const [all, setAll] = createSignal(false);
  const view = () => confirmRows(props.items, all());
  return (
    <div class="card-body overseer-confirm-items">
      <ul class="overseer-confirm-list" aria-label={`${props.items.length} ${props.items.length === 1 ? "item" : "items"}`}>
        <For each={view().rows}>
          {(it) => (
            <ConfirmItemRow item={it} since={props.since}>
              {props.below?.(it)}
            </ConfirmItemRow>
          )}
        </For>
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

/** A card item's number ("2."), when it has one (a `sova_card` card; a legacy card's rows have none). */
function ItemNumber(props: { item: SovaConfirmItem }) {
  const n = (props.item as { n?: number }).n;
  return (
    <Show when={n}>
      <span class="text-mono overseer-card-n">{n}.</span>
    </Show>
  );
}

/** `since`: an open card's createdAt; a session row whose session the list shows active after it
    says "Changed since asked" (§app.overseer/confirm). */
function ConfirmItemRow(props: { item: SovaConfirmItem; since?: string; children?: JSX.Element }) {
  const it = props.item;
  if (it.kind === "idea")
    return (
      <li class="overseer-confirm-item">
        <span class="overseer-confirm-item-line">
          <ItemNumber item={it} />
          <span class="overseer-confirm-idea-id">{it.id}</span>
          <Show when={it.title}>
            <span class="overseer-confirm-item-name"> — {it.title}</span>
          </Show>
        </span>
        <ItemNote note={it.note} />
        {props.children}
      </li>
    );
  if (it.kind === "todo")
    return (
      <li class="overseer-confirm-item">
        <span class="overseer-confirm-item-line">
          <ItemNumber item={it} />
          <span class="overseer-confirm-item-name">{it.text}</span>
        </span>
        <ItemNote note={it.note} />
        {props.children}
      </li>
    );
  if (it.kind === "project" || it.kind === "person") {
    const href = it.kind === "project" ? projectHref(it.id) : personHref(it.orgId, it.id);
    return (
      <li class="overseer-confirm-item">
        <span class="overseer-confirm-item-line">
          <ItemNumber item={it} />
          <a class="overseer-confirm-item-name" href={href}>
            {it.name}
          </a>
          {/* A standalone project has no organization: its name alone. */}
          <Show when={it.orgName}>
            <span class="overseer-confirm-item-meta">{it.orgName}</span>
          </Show>
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
        {props.children}
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
  /** When the session was active after the card was raised (the list's activity), else null. */
  const changed = () => {
    if (!props.since) return null;
    const at = sessionActiveAt(it.id);
    return at && Date.parse(at) > Date.parse(props.since) ? at : null;
  };
  return (
    <li class="overseer-confirm-item">
      <span class="overseer-confirm-item-line">
        <ItemNumber item={it} />
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
        <Show when={changed()}>
          {(at) => (
            <span class="chip chip-info overseer-card-changed" title={`Active ${stampTime(at())}, after this card was raised`}>
              <span class="chip-dot" />
              Changed since asked
            </span>
          )}
        </Show>
      </span>
      <ItemNote note={it.note} />
      {props.children}
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
