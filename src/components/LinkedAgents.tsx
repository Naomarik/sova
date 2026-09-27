import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { LinkThread, LinkedAgentInfo } from "../../shared/mesh-links";
import { ApiError, fetchLinkThread, markLinkSeen } from "../lib/api";
import { clockTime, compactModel } from "../lib/format";
import { type LinkReach, type OfferRow, linkStateChip, newestFrom, sessionIdOfPath, threadItems, threadSignature, transferChip, unreadText } from "../lib/links";
import { asOfClock } from "../lib/workers";
import { Markdown } from "./Markdown";
import { Banner, Chip, Icon } from "./ui";

// The Agents tab's "Remotely linked agents" (§mesh.links/agents-pane): a linked member's row, the
// head of its view, and the message thread above its transcript. The pane never sends: the thread
// is read-only here. SubagentPane composes them with its read-only transcript.

const MetaSep = () => (
  <span class="meta-line-sep" aria-hidden="true">
    ·
  </span>
);

const iso = (t: number) => new Date(t).toISOString();

/** The row's state chip: working pulses, idle and offline say as of when. */
export function LinkStateChip(props: { row: LinkedAgentInfo; liveSource: boolean }) {
  const chip = () => linkStateChip(props.row, props.liveSource);
  return (
    <Chip tone={chip().tone} live={chip().live}>
      {chip().text}
    </Chip>
  );
}

/** The row's file-transfer chip, beside its state chip: neutral, no pulse of its own. */
export function LinkTransferChip(props: { row: LinkedAgentInfo }) {
  const chip = () => transferChip(props.row.transfer);
  return (
    <Show when={chip()}>
      {(c) => (
        <span class="chip chip-count link-transfer-chip" title={c().title} data-transfer-state={props.row.transfer?.state}>
          {c().text}
        </span>
      )}
    </Show>
  );
}

/** One file offer in the thread: who offered what, then one line per recipient. Read-only. */
function LinkOfferStatus(props: { offer: OfferRow }) {
  const o = () => props.offer;
  return (
    <li class="link-offer" data-own={o().own ? "true" : undefined} data-dir={o().dir ?? undefined} data-offer={o().id}>
      <p class="link-message-head text-caption">
        <span class="link-message-from">{o().from}</span>
        <span class="text-mono" title={iso(o().at)}>
          {clockTime(iso(o().at))}
        </span>
      </p>
      <p class="link-offer-what">
        {o().verb} <span class="text-mono">{o().roots}</span>
        <MetaSep />
        {o().size}
      </p>
      <Show when={o().note}>{(n) => <p class="link-offer-note">{n()}</p>}</Show>
      <Show when={o().packing}>{(p) => <p class="text-caption link-message-note">{p()}</p>}</Show>
      <For each={o().warnings}>{(w) => <p class="text-caption link-offer-warning">{w}</p>}</For>
      <ul class="link-offer-recipients">
        <For each={o().recipients}>
          {(r) => (
            <li class="link-offer-recipient text-caption" data-state={r.state}>
              <span class="link-message-from">{r.who}</span>
              <Chip tone={r.tone}>{r.label}</Chip>
              <Show when={r.progress}>{(p) => <span class="text-mono">{p()}</span>}</Show>
              <Show when={r.dest}>
                {(d) => (
                  <span class="text-mono link-offer-dest" title={d()}>
                    {d()}
                  </span>
                )}
              </Show>
              <Show when={r.at}>
                {(t) => (
                  <span class="text-mono" title={iso(t())}>
                    {clockTime(iso(t()))}
                  </span>
                )}
              </Show>
              <Show when={r.took}>{(t) => <span>in {t()}</span>}</Show>
              <Show when={r.message}>{(m) => <span class="link-offer-message">{m()}</span>}</Show>
            </li>
          )}
        </For>
      </ul>
    </li>
  );
}

/** One linked member: title and state, then host · model · as of, and its unread count. A local
    member (the Overseer's pane) opens its own session instead of a view here. */
export function LinkedAgentRow(props: {
  row: LinkedAgentInfo;
  hostLabel: string;
  liveSource: boolean;
  current: boolean;
  /** Set for a local member: the row is a link to that session. */
  href?: string;
  onOpen(): void;
}) {
  const r = () => props.row;
  const at = () => linkStateChip(r(), props.liveSource).asOf;
  const unread = () => unreadText(r().unread);
  const body = () => (
    <>
      <span class="subagent-row-name" title={r().title}>
        <span class="subagent-row-label">{r().title}</span>
      </span>
      <span class="subagent-row-status">
        <Show when={unread()}>
          {(u) => (
            <span class="chip chip-count" title={`${u()} message${r().unread === 1 ? "" : "s"} from ${r().title}`}>
              {r().unread}
              <span class="visually-hidden"> unread</span>
            </span>
          )}
        </Show>
        <LinkTransferChip row={r()} />
        <LinkStateChip row={r()} liveSource={props.liveSource} />
      </span>
      <span class="subagent-row-meta meta-line">
        <span>{props.hostLabel}</span>
        <Show when={compactModel(r().model)}>
          {(m) => (
            <>
              <MetaSep />
              <span class="text-mono meta-line-shrink" title={r().model ?? undefined}>
                {m()}
              </span>
            </>
          )}
        </Show>
        <Show when={at()}>
          {(t) => (
            <>
              <MetaSep />
              <span>as of</span>
              <span class="text-mono" title={iso(t())}>
                {asOfClock(t())}
              </span>
            </>
          )}
        </Show>
      </span>
      <Icon name={props.href ? "arrow-right" : "chevron-right"} small class="subagent-row-go" />
    </>
  );
  return (
    <Show
      when={props.href}
      fallback={
        <button type="button" class="subagent-row" aria-current={props.current ? "true" : undefined} onClick={() => props.onOpen()}>
          {body()}
        </button>
      }
    >
      {(href) => (
        <a class="subagent-row" href={href()} title={`Open ${r().title}`}>
          {body()}
        </a>
      )}
    </Show>
  );
}

/** The open member's head facts under its title: host · model · session id · as of. */
export function LinkedAgentMeta(props: { row: LinkedAgentInfo; hostLabel: string; liveSource: boolean }) {
  const r = () => props.row;
  const at = () => linkStateChip(r(), props.liveSource).asOf;
  return (
    <p class="subagents-view-meta meta-line">
      <span>{props.hostLabel}</span>
      <Show when={compactModel(r().model)}>
        {(m) => (
          <span class="text-mono meta-line-shrink" title={r().model ?? undefined}>
            <MetaSep />
            {m()}
          </span>
        )}
      </Show>
      <span class="text-mono" title={r().sessionId}>
        <MetaSep />
        {r().sessionId.slice(0, 8)}
      </span>
      <Show when={at()}>
        {(t) => (
          <span>
            <MetaSep />
            as of{" "}
            <span class="text-mono" title={iso(t())}>
              {asOfClock(t())}
            </span>
          </span>
        )}
      </Show>
    </p>
  );
}

/**
 * The thread between the members, both directions, oldest first, read from a member host's inbox
 * (`reach`, lib/links.ts `threadHost`): it holds every message that host delivered or sent.
 * Fetched when the row opens and again whenever the row says there is new traffic (the chat
 * socket's `links` frame, else the insight poll). Opening it marks the partner's messages seen on
 * that same host.
 */
export function LinkThreadView(props: {
  row: LinkedAgentInfo;
  /** Every row of the pane, for naming the thread's senders. */
  rows: readonly LinkedAgentInfo[];
  /** The pane's session: the local member. */
  path: string;
  /** The member host whose inbox is read; not ok: none the page can reach. */
  reach: LinkReach;
  /** The pane is the Overseer's: no member is "you", and nothing is marked seen. */
  overseer: boolean;
}) {
  const [thread, setThread] = createSignal<LinkThread | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const viewer = createMemo(() => {
    if (props.overseer) return null;
    const id = sessionIdOfPath(props.path);
    return id ? { nodeId: "", sessionId: id } : null;
  });
  /** The viewer by session id alone: this host's nodeId may be unknown to the page. */
  const viewerRef = () => {
    const v = viewer();
    const t = thread();
    if (!v || !t) return null;
    const m = t.link.members.find((x) => x.sessionId === v.sessionId);
    return m ? { nodeId: m.nodeId, sessionId: m.sessionId } : null;
  };
  const rows = createMemo(() => {
    const t = thread();
    return t ? threadItems(t, viewerRef(), props.rows) : [];
  });

  /** By value (a string, "" for none): a new reach object on every render must not refetch. */
  const hostKey = createMemo(() => (props.reach.ok ? `h:${props.reach.host ?? ""}` : ""));
  const hostOf = (k: string): string | null => k.slice(2) || null;

  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    const linkId = props.row.linkId;
    const k = hostKey();
    if (!k) {
      setThread(null);
      setLoading(false);
      return;
    }
    const host = hostOf(k);
    try {
      const t = await fetchLinkThread(host, linkId);
      if (mine !== seq) return;
      setThread(t);
      setError(null);
      const me = viewerRef();
      const from = { nodeId: props.row.nodeId, sessionId: props.row.sessionId };
      const at = newestFrom(t, from);
      if (me && at !== null && props.row.unread > 0) void markLinkSeen(host, linkId, { session: me.sessionId, from, at }).catch(() => {});
    } catch (err) {
      if (mine !== seq) return;
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq) setLoading(false);
    }
  };
  // By value: the row object is new on every frame and poll, and on() would fire on each
  // (CLAUDE.md, Method). The key and the traffic signature are strings, so only a change refetches.
  const key = createMemo(() => `${props.row.key}\n${hostKey()}`);
  const signature = createMemo(() => threadSignature(props.row));
  createEffect(
    on(key, () => {
      setThread(null);
      setLoading(true);
      void load();
    }),
  );
  createEffect(on(signature, () => void load(), { defer: true }));

  let list: HTMLOListElement | undefined;
  createEffect(
    on(rows, () =>
      queueMicrotask(() => {
        if (list) list.scrollTop = list.scrollHeight;
      }),
    ),
  );

  return (
    <section class="link-thread" aria-label={`Messages with ${props.row.title}`}>
      <Show when={error()}>
        {(e) => (
          <Banner
            tone="warn"
            title="Couldn't load the messages."
            body={<>{e()} What's shown is the last we read.</>}
            action={
              <button type="button" class="button button-sm" onClick={() => void load()}>
                Retry
              </button>
            }
          />
        )}
      </Show>
      <Show when={!hostKey()}>
        <p class="text-caption link-thread-empty">None of this link's hosts is reachable from here, so its messages can't be read.</p>
      </Show>
      <Show
        when={rows().length > 0}
        fallback={
          <Show when={!loading() && !error() && hostKey()}>
            <p class="text-caption link-thread-empty">0 messages between these sessions yet. They show up here as they're sent.</p>
          </Show>
        }
      >
        <ol class="link-thread-list" ref={list} tabindex="0">
          <For each={rows()}>
            {(m) =>
              m.kind === "offer" ? (
                <LinkOfferStatus offer={m} />
              ) : (
                <li class="link-message" data-own={m.own ? "true" : undefined}>
                  <p class="link-message-head text-caption">
                    <span class="link-message-from">{m.from}</span>
                    <span class="text-mono" title={iso(m.at)}>
                      {clockTime(iso(m.at))}
                    </span>
                  </p>
                  <Markdown text={m.text} />
                  <For each={m.notes}>{(n) => <p class="text-caption link-message-note">{n}</p>}</For>
                </li>
              )
            }
          </For>
        </ol>
      </Show>
    </section>
  );
}
