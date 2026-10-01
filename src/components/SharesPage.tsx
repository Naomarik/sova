import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { OrgLinkRow, SessionShare, SessionShareVisit, SharesOverview } from "../../shared/session-share";
import { relativeTime } from "../lib/format";
import { absoluteTime } from "../lib/spend";
import { hostLabel, meshOn, meshPeers, selfLabel } from "../lib/mesh";
import { getPreviews, turnOffPreview } from "../lib/api";
import { senderLine } from "../lib/preview-rows";
import { type PreviewGroup, previewGroups, recipientName, recipientOffConfirm, recipientOffTip, runningLine, sentToLine, TURN_OFF_ALL_TIP, turnOffConfirm } from "../lib/previews";
import { expiresWord, openedLine, presenceWord, revokeHandoff, revokeOwnerLink, sharesOverview, shareLine, shareLive, stopShare, visitLine, visitTitle } from "../lib/session-shares";
import { InsightsPage } from "./InsightsPage";
import { RecipientChip, ShareSheet } from "./ShareSheet";
import { Icon } from "./ui";
import "../shares.css";

/** Every host is read again this often while the page is visible. */
const REFRESH_MS = 5_000;

interface HostShares {
  host: string | null;
  overview: SharesOverview | null;
  error: string | null;
}

const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));
const sessionLink = (sessionId: string) => `#/sid/${encodeURIComponent(sessionId)}`;

/**
 * The Shares page (§app.session-share/shares-page): every live public link this host and each up
 * peer serve, session shares first, then organization links, then this host's preview links
 * (§mesh.public/preview-card), each with the people it was sent to. Read-only over the org stores;
 * Turn Off Link uses their own revoke routes, and a preview's Turn Off its own.
 */
export function SharesPage(props: { now: number; titleRef(el: HTMLHeadingElement): void }) {
  const [hosts, setHosts] = createSignal<HostShares[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [managing, setManaging] = createSignal<{ host: string | null; share: SessionShare } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [previews, setPreviews] = createSignal<PreviewGroup[]>([]);

  let run = 0;
  const read = async () => {
    const mine = ++run;
    setRefreshing(true);
    const targets: (string | null)[] = [null, ...meshPeers().filter((p) => p.state === "up").map((p) => p.id)];
    const answers = await Promise.all(
      targets.map(async (host): Promise<HostShares> => {
        try {
          return { host, overview: await sharesOverview(host), error: null };
        } catch (x) {
          return { host, overview: null, error: errText(x) };
        }
      }),
    );
    const mineOnly = await getPreviews().then((l) => previewGroups(l.previews), () => null);
    if (mine !== run) return;
    if (mineOnly) setPreviews(mineOnly);
    setHosts(answers);
    setLoaded(true);
    setRefreshing(false);
  };
  onMount(() => {
    void read();
    const tick = setInterval(() => document.visibilityState === "visible" && void read(), REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && void read();
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      run++;
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    });
  });

  const hostName = (h: string | null) => (h ? hostLabel(h) : selfLabel());
  const shares = createMemo(() => hosts().flatMap((h) => (h.overview?.sessionShares ?? []).map((share) => ({ host: h.host, share }))));
  const live = () => shares().filter((s) => shareLive(s.share));
  const ended = () => shares().filter((s) => !shareLive(s.share));
  const orgLinks = createMemo(() => hosts().flatMap((h) => (h.overview?.orgLinks ?? []).map((link) => ({ host: h.host, link }))));
  const down = () => hosts().filter((h) => h.error);
  /** This host's preview visits (§mesh.public/visitor-log), by preview id. */
  const previewVisits = (id: string) => hosts().find((h) => h.host === null)?.overview?.previewVisits?.[id] ?? [];
  const viewing = () => live().reduce((n, s) => n + s.share.recipients.filter((r) => r.presence === "viewing").length, 0) + orgLinks().filter((l) => l.link.presence === "viewing").length;

  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
    } catch (x) {
      setError(errText(x));
    }
    void read();
  };

  return (
    <InsightsPage
      title="Shares"
      class="shares-page"
      meta={
        <Show when={loaded()}>
          {live().length} session {live().length === 1 ? "share" : "shares"} · {orgLinks().length} organization {orgLinks().length === 1 ? "link" : "links"}
          <Show when={viewing() > 0}> · {viewing()} viewing now</Show>
        </Show>
      }
      refreshLabel="Refresh Shares"
      refreshing={refreshing() && loaded()}
      onRefresh={() => void read()}
      error={error()}
      errorTitle="That didn't go through."
      busy={!loaded()}
      titleRef={props.titleRef}
    >
      <For each={down()}>{(h) => <p class="usage-note">{hostName(h.host)} can't be reached, so its links aren't listed.</p>}</For>

      <Show when={loaded() && shares().length === 0 && orgLinks().length === 0 && previews().length === 0 && down().length === 0}>
        <div class="empty">
          <p class="empty-title">No public links are open.</p>
          <p class="empty-body">Share a session from its Sharing tab: Session details, then Sharing.</p>
        </div>
      </Show>

      <Show when={shares().length > 0}>
        <section class="card shares-card" aria-labelledby="shares-sessions-title">
          <h2 class="shares-card-title" id="shares-sessions-title">
            Session shares
          </h2>
          <Show when={live().length > 0} fallback={<p class="usage-note">No session share has a live link.</p>}>
            <ul class="list">
              <For each={live()}>{(s) => <ShareRow host={s.host} share={s.share} now={props.now} hostName={meshOn() ? hostName(s.host) : null} onManage={() => setManaging(s)} onStop={() => void act(() => stopShare(s.host, s.share.id))} />}</For>
            </ul>
          </Show>
          <Show when={ended().length > 0}>
            <details class="disclosure">
              <summary class="disclosure-summary">
                <Icon name="chevron-right" small class="icon-twist" />
                <span class="disclosure-label">Ended</span>
                <span class="disclosure-preview">· {ended().length}</span>
              </summary>
              <ul class="list disclosure-body">
                <For each={ended()}>{(s) => <ShareRow host={s.host} share={s.share} now={props.now} hostName={meshOn() ? hostName(s.host) : null} onManage={() => setManaging(s)} />}</For>
              </ul>
            </details>
          </Show>
        </section>
      </Show>

      <Show when={orgLinks().length > 0}>
        <section class="card shares-card" aria-labelledby="shares-org-title">
          <h2 class="shares-card-title" id="shares-org-title">
            Organization links
          </h2>
          <ul class="list">
            <For each={orgLinks()}>
              {(l) => (
                <OrgLinkItem
                  link={l.link}
                  now={props.now}
                  hostName={meshOn() ? hostName(l.host) : null}
                  onRevoke={() => void act(() => (l.link.kind === "handoff" && l.link.sessionId ? revokeHandoff(l.host, l.link.sessionId) : revokeOwnerLink(l.host, l.link.orgId)))}
                />
              )}
            </For>
          </ul>
        </section>
      </Show>

      <Show when={previews().length > 0}>
        <section class="card shares-card" aria-labelledby="shares-preview-title">
          <h2 class="shares-card-title" id="shares-preview-title">
            Preview links
          </h2>
          <ul class="list">
            <For each={previews()}>
              {(g) => {
                const v = g.preview;
                return (
                  <li class="list-row shares-row">
                    <div class="list-main">
                      <p class="list-title shares-row-title">
                        <a href={`#/orgs/${encodeURIComponent(v.orgId)}/projects/${encodeURIComponent(v.projectId)}`}>Port {v.port}</a>
                        <span class={v.running ? "chip chip-success" : "chip"}>
                          <span class="chip-dot" aria-hidden="true" />
                          {runningLine(v)}
                        </span>
                      </p>
                      <p class="list-meta">
                        Project {v.projectId} · {sentToLine(v) ? `${sentToLine(v)} · ` : ""}
                        {expiresWord(v.expiresAt, props.now)}
                      </p>
                      <Show when={g.recipients.length > 0}>
                        <div class="list-meta previews-sent">
                          <span class="previews-sent-label">Sent to</span>
                          <ul class="previews-recipients">
                            <For each={g.recipients}>
                              {(r) => (
                                <li class="previews-recipient">
                                  <span class="previews-recipient-name" title={senderLine(r.createdBy) ?? undefined}>
                                    {recipientName(r)}
                                  </span>
                                  <TwoStep
                                    label="Turn Off"
                                    confirm={recipientOffConfirm(recipientName(r))}
                                    title={recipientOffTip(recipientName(r))}
                                    class="previews-recipient-off"
                                    onRun={() => void act(() => turnOffPreview(r.id))}
                                  />
                                  <Visits visits={previewVisits(r.id)} now={props.now} />
                                </li>
                              )}
                            </For>
                          </ul>
                        </div>
                      </Show>
                      <Visits visits={previewVisits(v.id)} now={props.now} />
                    </div>
                    <div class="shares-row-actions">
                      <TwoStep
                        label="Turn Off"
                        confirm={turnOffConfirm(g.recipients.length)}
                        title={v.siblingOf ? undefined : TURN_OFF_ALL_TIP}
                        onRun={() => void act(() => turnOffPreview(v.id))}
                      />
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </section>
      </Show>

      <Show when={managing()}>
        {(m) => (
          <ShareSheet
            host={m().host}
            share={m().share}
            onClose={() => {
              setManaging(null);
              void read();
            }}
          />
        )}
      </Show>
    </InsightsPage>
  );
}

/** A two-press destructive button: the first press asks, the second runs; leaving it disarms. */
function TwoStep(props: { label: string; confirm: string; title?: string; class?: string; onRun(): void }) {
  const [armed, setArmed] = createSignal(false);
  return (
    <button
      type="button"
      class={`button button-sm button-destructive${props.class ? ` ${props.class}` : ""}`}
      title={props.title}
      onClick={() => {
        if (!armed()) return setArmed(true);
        setArmed(false);
        props.onRun();
      }}
      onBlur={() => setArmed(false)}
    >
      {armed() ? props.confirm : props.label}
    </button>
  );
}

function ShareRow(props: { host: string | null; share: SessionShare; now: number; hostName: string | null; onManage(): void; onStop?(): void }) {
  const s = () => props.share;
  return (
    <li class="list-row shares-row">
      <div class="list-main">
        <p class="list-title shares-row-title">
          <a href={sessionLink(s().sessionId)} title={`Open ${s().sessionTitle}`}>
            {s().title}
          </a>
          <Show when={props.hostName}>{(h) => <span class="chip chip-count">{h()}</span>}</Show>
        </p>
        <p class="list-meta">
          {s().stoppedAt ? `Stopped ${relativeTime(s().stoppedAt!, props.now)}` : shareLine(s(), (iso) => absoluteTime(iso, props.now))}
          <Show when={s().sessionTitle !== s().title}> · session “{s().sessionTitle}”</Show>
        </p>
        <ul class="shares-recipients">
          <For each={s().recipients}>
            {(r) => (
              <li class="shares-recipient">
                <span class="shares-recipient-name">{r.label}</span>
                <RecipientChip state={r.state} presence={r.presence} />
                <span class="text-caption text-muted">
                  {openedLine(r.opened, r.lastAt, (iso) => relativeTime(iso, props.now))}
                  <Show when={r.state === "live"}> · {expiresWord(r.expiresAt, props.now)}</Show>
                </span>
                <Visits visits={r.visits ?? []} now={props.now} />
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="shares-row-actions">
        <button type="button" class="button button-sm" onClick={() => props.onManage()}>
          Manage
        </button>
        <Show when={props.onStop}>
          <TwoStep label="Stop Sharing" confirm="Stop Every Link?" onRun={() => props.onStop!()} />
        </Show>
      </div>
    </li>
  );
}

/** A link's visits folded under it, newest first; nothing when there are none. */
function Visits(props: { visits: SessionShareVisit[]; now: number }) {
  return (
    <Show when={props.visits.length > 0}>
      <details class="disclosure share-visits">
        <summary class="disclosure-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="disclosure-label">Visits</span>
          <span class="disclosure-preview">· {props.visits.length}</span>
        </summary>
        <ul class="disclosure-body share-visit-list">
          <For each={props.visits}>
            {(v) => (
              <li class="text-caption" title={visitTitle(v, absoluteTime(v.at, props.now))}>
                {visitLine(v, (iso) => relativeTime(iso, props.now))}
              </li>
            )}
          </For>
        </ul>
      </details>
    </Show>
  );
}

function OrgLinkItem(props: { link: OrgLinkRow; now: number; hostName: string | null; onRevoke(): void }) {
  const l = () => props.link;
  const what = () => (l().kind === "owner" ? "Owner page" : `${l().sessionTitle ?? "Hand-off"}${l().n ? ` · hand-off ${l().n}` : ""}`);
  return (
    <li class="list-row shares-row">
      <div class="list-main">
        <p class="list-title shares-row-title">
          <span>{l().personName}</span>
          <Show when={presenceWord(l().presence)}>
            {(w) => (
              <span class={l().presence === "viewing" ? "chip chip-success" : "chip"}>
                <span class="chip-dot" aria-hidden="true" />
                {w()}
              </span>
            )}
          </Show>
          <Show when={props.hostName}>{(h) => <span class="chip chip-count">{h()}</span>}</Show>
        </p>
        <p class="list-meta">
          <Show when={l().kind === "handoff" && l().sessionId} fallback={what()}>
            <a href={sessionLink(l().sessionId!)}>{what()}</a>
          </Show>
          {" · "}
          {l().orgName} · {l().state} · {expiresWord(l().expiresAt, props.now)}
        </p>
        <p class="list-meta">{openedLine(l().opened, l().lastAt, (iso) => relativeTime(iso, props.now))}</p>
        <Visits visits={l().visits} now={props.now} />
      </div>
      <div class="shares-row-actions">
        <TwoStep label="Turn Off Link" confirm={`Turn Off ${l().personName}'s Link?`} onRun={() => props.onRevoke()} />
      </div>
    </li>
  );
}
