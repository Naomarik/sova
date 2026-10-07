import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { OrgLinkRow, SessionShare, SessionShareVisit } from "../../shared/session-share";
import { projectHref } from "../lib/projects-route";
import { relativeTime } from "../lib/format";
import { absoluteTime } from "../lib/spend";
import { hostLabel, meshOn, meshPeers, selfLabel } from "../lib/mesh";
import { getPreviews, turnOffPreview } from "../lib/api";
import { senderLine } from "../lib/preview-rows";
import {
  DELETE_ALL_TIP,
  DELETE_CONFIRM,
  deleteLabel,
  deleteNote,
  type PreviewGroup,
  PREVIEW_DELETED,
  previewGroups,
  RECIPIENT_DELETE_LABEL,
  recipientCopied,
  recipientCopyLabel,
  recipientCopyTip,
  recipientDeleteConfirm,
  recipientDeleted,
  recipientDeleteName,
  recipientDeleteNote,
  recipientDeleteTip,
  recipientName,
  runningLine,
  sentToLine,
} from "../lib/previews";
import { DELETE_LINK, deleteLinkConfirm, LINK_DELETED, linkGone } from "../lib/link-delete";
import { copyText, toast } from "../lib/ui-state";
import { copyableLink, expiresWord, type HostShares, openedLine, presenceWord, readShares, revokeHandoff, revokeOwnerLink, sharesOverview, shareLine, shareLive, stopShare, linksViewingNow, visitLine, visitTitle } from "../lib/session-shares";
import { DeleteButton } from "./DeleteButton";
import { InsightsPage } from "./InsightsPage";
import { RecipientChip, ShareSheet } from "./ShareSheet";
import { CopyButton, Icon } from "./ui";
import "../shares.css";

/** Every host is read again this often while the page is visible. */
const REFRESH_MS = 5_000;

const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));
const sessionLink = (sessionId: string) => `#/sid/${encodeURIComponent(sessionId)}`;

/**
 * The Shares page (§app.session-share/shares-page): every live public link this host and each up
 * peer serve, session shares first, then organization links, then this host's preview links
 * (§mesh.public/preview-card), each with the people it was sent to. Read-only over the org stores;
 * Delete Link uses their own revoke routes, and a preview's Delete its own.
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
    const r = await readShares(targets, { overview: sharesOverview, previews: () => getPreviews().then((l) => l.previews) });
    if (mine !== run) return;
    if (r.previews) setPreviews(previewGroups(r.previews));
    setHosts(r.hosts);
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
  const viewing = () => linksViewingNow(live().map((s) => s.share), orgLinks().map((l) => l.link));

  /** `done` is the toast once it went through. */
  const act = async (run: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await run();
      if (done) toast(done);
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
                  onRevoke={() => void act(() => (l.link.kind === "handoff" && l.link.sessionId ? revokeHandoff(l.host, l.link.sessionId) : revokeOwnerLink(l.host, l.link.orgId)), LINK_DELETED)}
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
                        <a href={projectHref(v.projectId)}>Port {v.port}</a>
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
                                  {/* Their own link, while it is kept: Copy only, never Open. */}
                                  <Show when={r.sentLink}>
                                    {(link) => (
                                      <button type="button" class="button button-sm previews-recipient-copy" title={recipientCopyTip(recipientName(r))} onClick={() => void copyText(link(), recipientCopied(recipientName(r)))}>
                                        {recipientCopyLabel(recipientName(r))}
                                      </button>
                                    )}
                                  </Show>
                                  <DeleteButton
                                    label={RECIPIENT_DELETE_LABEL}
                                    name={recipientDeleteName(recipientName(r))}
                                    confirm={recipientDeleteConfirm(recipientName(r))}
                                    note={recipientDeleteNote(recipientName(r))}
                                    title={recipientDeleteTip(recipientName(r))}
                                    class="previews-recipient-off"
                                    onRun={() => void act(() => turnOffPreview(r.id), recipientDeleted(recipientName(r)))}
                                  />
                                  <Visits id={`preview:${r.id}`} visits={previewVisits(r.id)} now={props.now} />
                                </li>
                              )}
                            </For>
                          </ul>
                        </div>
                      </Show>
                      <Visits id={`preview:${v.id}`} visits={previewVisits(v.id)} now={props.now} />
                    </div>
                    <div class="shares-row-actions">
                      <Show when={v.siblingOf && v.sentLink}>
                        {(link) => (
                          <button type="button" class="button button-sm" title={recipientCopyTip(recipientName(v))} onClick={() => void copyText(link(), recipientCopied(recipientName(v)))}>
                            {recipientCopyLabel(recipientName(v))}
                          </button>
                        )}
                      </Show>
                      <Show
                        when={v.siblingOf}
                        fallback={
                          <DeleteButton
                            label={deleteLabel(g.recipients.length)}
                            confirm={DELETE_CONFIRM}
                            note={deleteNote(g.recipients.length)}
                            title={DELETE_ALL_TIP}
                            onRun={() => void act(() => turnOffPreview(v.id), PREVIEW_DELETED)}
                          />
                        }
                      >
                        <DeleteButton
                          label={recipientDeleteName(recipientName(v))}
                          confirm={recipientDeleteConfirm(recipientName(v))}
                          note={recipientDeleteNote(recipientName(v))}
                          title={recipientDeleteTip(recipientName(v))}
                          onRun={() => void act(() => turnOffPreview(v.id), recipientDeleted(recipientName(v)))}
                        />
                      </Show>
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
                <Show when={copyableLink(r)}>
                  {(link) => <CopyButton label="Copy Link" title={r.anyone ? "Copy this link" : `Copy ${r.label}'s link`} text={link} onCopy={(t) => copyText(t, "Link copied.")} />}
                </Show>
                <Visits id={`share:${props.host ?? ""}:${r.id}`} visits={r.visits ?? []} now={props.now} />
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

/** Which links' Visits are unfolded, by `Visits.id`: every 5-second read rebuilds the rows, and an
    unfolded list stays unfolded across it. */
const [openVisits, setOpenVisits] = createSignal<ReadonlySet<string>>(new Set());

/** A link's visits folded under it, newest first; nothing when there are none. */
function Visits(props: { id: string; visits: SessionShareVisit[]; now: number }) {
  const toggle = (open: boolean) =>
    setOpenVisits((s) => {
      if (s.has(props.id) === open) return s;
      const next = new Set(s);
      if (open) next.add(props.id);
      else next.delete(props.id);
      return next;
    });
  return (
    <Show when={props.visits.length > 0}>
      <details class="disclosure share-visits" open={openVisits().has(props.id)} onToggle={(e) => toggle(e.currentTarget.open)}>
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
        <Visits id={`org:${l().orgId}:${l().kind}:${l().sessionId ?? ""}:${l().n ?? ""}`} visits={l().visits} now={props.now} />
      </div>
      <div class="shares-row-actions">
        <Show when={l().link}>
          {(link) => <CopyButton label="Copy Link" title={`Copy ${l().personName}'s link`} text={link} onCopy={(t) => copyText(t, "Link copied.")} />}
        </Show>
        <DeleteButton label={DELETE_LINK} confirm={deleteLinkConfirm(l().personName)} note={linkGone(l().personName)} onRun={() => props.onRevoke()} />
      </div>
    </li>
  );
}
