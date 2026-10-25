import { createMemo, For, Show } from "solid-js";
import type { TeamInboxItemInfo } from "../../shared/protocol";
import { fetchTeamInbox, fetchTeamInboxBody } from "../lib/api";
import { agoTime, stampTime } from "../lib/format";
import { createInboxReader, emptyInboxText, fromWord, inboxSummary, kindWord, movedWord, statusChip } from "../lib/team-inbox";
import { Banner, Chip } from "./ui";

const Sep = () => (
  <span class="meta-line-sep" aria-hidden="true">
    ·
  </span>
);

/**
 * A team member's inbox, read-only (§app.subagents-pane/member-inbox): its items newest first, each
 * opening to its whole message, read from the server only then. Nothing here marks, sends or
 * deletes: only the member marks its items. Polled while it is shown.
 */
export function TeamInbox(props: { path: string; teamId: string; workerId: string; name: string; panelId: string; tabId: string }) {
  const reader = createInboxReader({
    key: () => ({ path: props.path, teamId: props.teamId, workerId: props.workerId }),
    active: () => true,
    list: (k) => fetchTeamInbox(k.path, k.teamId, k.workerId),
    body: (k, id) => fetchTeamInboxBody(k.path, k.teamId, k.workerId, id),
  });
  const items = () => reader.view()?.items ?? [];
  const shownAll = () => {
    const v = reader.view();
    return !v || v.total <= v.items.length;
  };

  /** Rows render by id, never by object: each poll builds new items, and a <For> over those
      remounted every row, dropping focus and an open item's place. */
  const byId = createMemo(() => new Map(items().map((x) => [x.id, x])));
  const ids = createMemo(() => items().map((x) => x.id), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });

  const item = (id: string) => (
    <Show when={byId().get(id)}>
      {(i) => itemRow(i)}
    </Show>
  );
  const itemRow = (it: () => TeamInboxItemInfo) => {
    const chip = () => statusChip(it());
    const bodyId = `inbox-body-${props.workerId}-${it().id}`.replace(/[^A-Za-z0-9_-]/g, "_");
    return (
      <li class="inbox-item" data-status={it().returned ? "returned" : it().status} data-closed-by={it().status === "addressed" ? (it().closedBy ?? "member") : undefined}>
        <button type="button" class="inbox-item-line" aria-expanded={reader.isOpen(it().id) ? "true" : "false"} aria-controls={bodyId} onClick={() => reader.toggle(it().id)}>
          <span class="inbox-item-head">
            <Show when={it().urgent}>
              <Chip tone="warn">Urgent</Chip>
            </Show>
            <span class="inbox-item-subject" title={`${it().id} · ${it().subject}`}>
              {it().subject || "(no subject)"}
            </span>
          </span>
          <span class="inbox-item-meta meta-line">
            {/* A separator belongs to the fact it introduces, so a wrap never strands it. */}
            <span>{kindWord(it().kind)}</span>
            <span class="meta-line-shrink">
              <Sep />
              {fromWord(it())}
            </span>
            <Show when={movedWord(it())}>
              {(m) => (
                <span>
                  <Sep />
                  {m()}
                </span>
              )}
            </Show>
            <span>
              <Sep />
              <Chip tone={chip().tone === "info" ? "info" : chip().tone === "success" ? "success" : undefined}>{chip().word}</Chip>
            </span>
            <span class="text-mono" title={new Date(it().sentAt).toISOString()}>
              <Sep />
              {agoTime(it().sentAt) || stampTime(it().sentAt)}
            </span>
          </span>
        </button>
        <Show when={it().note}>
          {(n) => <p class="inbox-item-note text-caption">Note: {n()}</p>}
        </Show>
        <Show when={reader.isOpen(it().id)}>
          <div class="inbox-item-body" id={bodyId}>
            <Show when={reader.body(it().id)}>
              {(b) => (
                <Show when={!b().loading} fallback={<div class="skeleton skeleton-line" aria-busy="true" />}>
                  <Show when={b().error === undefined} fallback={<p class="text-caption inbox-item-error">Couldn't read this message. {b().error} Close it and open it again to retry.</p>}>
                    <p class="inbox-item-text">{b().text}</p>
                  </Show>
                </Show>
              )}
            </Show>
          </div>
        </Show>
      </li>
    );
  };

  return (
    <section class="subagents-inbox pane" role="tabpanel" id={props.panelId} aria-labelledby={props.tabId} aria-label={`${props.name} inbox`} aria-busy={reader.view() ? undefined : "true"} tabindex="0">
      <Show when={reader.error()}>
        {(e) => (
          <div class="subagents-banner stack-2">
            <Banner
              tone="error"
              title={`Couldn't read ${props.name}'s inbox.`}
              body={<>Nothing in it changed. {e()}</>}
              action={
                <button type="button" class="button button-sm" onClick={() => reader.retry()}>
                  Retry
                </button>
              }
            />
          </div>
        )}
      </Show>
      <Show when={reader.view()} fallback={<Show when={!reader.error()}><div class="inbox-skeleton"><div class="skeleton skeleton-row" /><div class="skeleton skeleton-row" /></div></Show>}>
        <Show
          when={items().length > 0}
          fallback={
            <div class="empty subagents-empty">
              <p class="empty-title">{emptyInboxText(props.name)}</p>
              <p class="empty-body">Messages and notices sent to it show up here.</p>
            </div>
          }
        >
          <Show when={inboxSummary(reader.view()?.counts, props.name)}>
            {(line) => <p class="text-caption inbox-more inbox-summary">{line()}</p>}
          </Show>
          <ul class="inbox-list" aria-label={`${props.name} inbox items`}>
            <For each={ids()}>{(id) => item(id)}</For>
          </ul>
          <Show when={!shownAll()}>
            <p class="text-caption inbox-more">
              The newest {reader.view()!.items.length} of {reader.view()!.total} items.
            </p>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
