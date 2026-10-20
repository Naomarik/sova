import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import type { OrgDetail } from "../../shared/orgs";
import type { AssistantInfo, OwnerRequest } from "../../shared/project-assistant";
import { ApiError, assistantInfo, getSessionSummaryById, setOwnerRequest, startOwnerRequestChat } from "../lib/api";
import { orgHostOf } from "../lib/mesh";
import { relativeTime, stampTime } from "../lib/format";
import { useMinuteNow } from "../lib/minute-clock";
import { orgSessionHref } from "../lib/orgs-route";
import { emptyLine, filterCounts, filterShowing, firstName, groupRequests, isOpenRequest, KIND_WORD, REQUEST_FILTERS, STATUS_TONE, STATUS_WORD, type RequestFilter } from "../lib/owner-requests";
import { adoptSession, announce } from "../lib/ui-state";
import { Chip, Icon } from "./ui";
import "./OrgRequests.css";

/**
 * The organization page's Requests tab (§app.project-assistant/requests-tab): what the org's owner
 * asked for through their Project Assistant, under a status filter, grouped by project, with Start
 * Chat / Open Chat, Mark Done and Decline. `focus`: the request `#/orgs/<id>/requests/<rid>` names.
 */

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

export function OrgRequests(props: { org: OrgDetail; focus?: string; ownerName: string; onChanged(): void }) {
  const now = useMinuteNow();
  const orgId = createMemo(() => props.org.id);
  const [info, { mutate, refetch }] = createResource(orgId, (id) => assistantInfo(id));
  const [filter, setFilter] = createSignal<RequestFilter>("open");
  const [err, setErr] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const requests = (): OwnerRequest[] => info()?.requests ?? [];
  const counts = createMemo(() => filterCounts(requests()));
  const groups = createMemo(() => groupRequests(requests(), filter(), info()?.projects ?? []));
  const who = () => (props.ownerName ? firstName(props.ownerName) : "the owner");
  const focus = createMemo(() => props.focus);
  const rowEls = new Map<string, HTMLLIElement>();

  // A focused request (from Needs you or a chat's card) is shown whatever the filter, then scrolled to.
  createEffect(
    on([focus, () => info.state], ([rid]) => {
      if (!rid || !info()) return;
      const r = requests().find((x) => x.id === rid);
      if (!r) return;
      setFilter((f) => filterShowing(r, f));
      queueMicrotask(() => rowEls.get(rid)?.scrollIntoView({ block: "center" }));
    }),
  );

  const run = async (rid: string, fn: () => Promise<void>) => {
    if (busy()) return;
    setBusy(rid);
    try {
      await fn();
      setErr(null);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(null);
    }
  };
  const answer = (r: OwnerRequest, status: "done" | "declined") =>
    void run(r.id, async () => {
      const next: AssistantInfo = await setOwnerRequest(orgId(), r.id, status);
      mutate(next);
      props.onChanged();
      announce(`${r.title}: ${status === "done" ? "done" : "declined"}.`);
    });
  const openChat = (path: string) => {
    location.hash = orgSessionHref(orgId(), path);
  };
  const startChat = (r: OwnerRequest) =>
    void run(r.id, async () => {
      try {
        const { sessionId, path } = await startOwnerRequestChat(orgId(), r.id);
        props.onChanged();
        // Empty until the operator writes, so the list hides it: the app adopts it (composer
        // focused), as the project page's New Coding Session does. A peer's chat opens by address.
        const s = orgHostOf(orgId()) ? null : await getSessionSummaryById(sessionId).catch(() => null);
        if (!s || !adoptSession(s)) openChat(path);
      } catch (x) {
        const body = x instanceof ApiError && x.status === 409 ? (x.body as { code?: unknown; path?: unknown } | undefined) : undefined;
        // One chat per request: one that already has a live chat opens it.
        if (body?.code === "has-chat" && typeof body.path === "string") return openChat(body.path);
        void refetch();
        throw x;
      }
    });

  return (
    <section class="card orgs-section org-requests" aria-labelledby="org-requests-h">
      <h2 class="orgs-h2" id="org-requests-h">
        Requests
      </h2>
      <p class="orgs-line project-muted">What {who()} asked for through their Project Assistant, and your answers.</p>
      <div class="org-requests-filters" role="group" aria-label="Show requests">
        <For each={REQUEST_FILTERS}>
          {(f) => (
            <button type="button" class="org-requests-filter" aria-pressed={filter() === f.id ? "true" : "false"} onClick={() => setFilter(f.id)}>
              <Show when={filter() === f.id}>
                <Icon name="check" small />
              </Show>
              {f.label}
              <span class="org-requests-filter-count text-num">{counts()[f.id]}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={info.error}>
        <p class="field-error">
          Couldn't read the requests.{" "}
          <button type="button" class="button button-sm button-ghost" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={info()}>
        <Show when={groups().length} fallback={<p class="orgs-empty">{emptyLine(requests(), filter(), props.ownerName)}</p>}>
          <For each={groups()}>
            {(g) => (
              <div class="org-requests-group">
                <h3 class="orgs-h3 org-requests-project">{g.name}</h3>
                <ul class="org-requests-list">
                  <For each={g.rows}>
                    {(r) => (
                      <li class="org-request" classList={{ "org-request-focus": r.id === focus() }} id={`org-request-${r.id}`} ref={(el) => rowEls.set(r.id, el)} aria-current={r.id === focus() ? "true" : undefined}>
                        <div class="org-request-head">
                          <span class="org-request-title">{r.title}</span>
                          <Chip tone={STATUS_TONE[r.status]}>{STATUS_WORD[r.status]}</Chip>
                        </div>
                        <span class="field-hint">
                          {KIND_WORD[r.kind]} · <span title={stampTime(r.createdAt)}>{relativeTime(r.createdAt, now())}</span>
                          <Show when={r.chat?.startedAt}>{(at) => <> · <span title={stampTime(at())}>Chat started {relativeTime(at(), now())}</span></>}</Show>
                        </span>
                        <Show when={r.text}>
                          <p class="org-request-text">{r.text}</p>
                        </Show>
                        <Show when={isOpenRequest(r) || r.chat}>
                          <div class="button-row org-request-actions">
                            <Show
                              when={r.chat}
                              fallback={
                                <button type="button" class="button button-sm" disabled={!!busy()} aria-busy={busy() === r.id ? "true" : undefined} aria-label={`Start Chat: ${r.title}`} onClick={() => startChat(r)}>
                                  Start Chat
                                </button>
                              }
                            >
                              {(c) => (
                                <a class="button button-sm" href={orgSessionHref(orgId(), c().path)} aria-label={`Open Chat: ${r.title}`}>
                                  Open Chat
                                </a>
                              )}
                            </Show>
                            <Show when={isOpenRequest(r)}>
                              <span class="org-request-answers">
                                <button type="button" class="button button-sm" disabled={!!busy()} aria-label={`Mark Done: ${r.title}`} onClick={() => answer(r, "done")}>
                                  Mark Done
                                </button>
                                <button type="button" class="button button-sm button-ghost" disabled={!!busy()} aria-label={`Decline: ${r.title}`} onClick={() => answer(r, "declined")}>
                                  Decline
                                </button>
                              </span>
                            </Show>
                          </div>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            )}
          </For>
        </Show>
      </Show>
      <Show when={err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
    </section>
  );
}
