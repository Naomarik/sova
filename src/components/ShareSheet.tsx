import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import {
  SESSION_SHARE_DAYS,
  SESSION_SHARE_DEFAULT_DAYS,
  SHARE_TITLE_MAX,
  RECIPIENT_LABEL_MAX,
  type SessionShare,
  type SessionShareDays,
  type SessionShareLink,
  type SessionShareMinted,
  type SessionSharePreview,
  type SessionShareRecipient,
  type SessionShareRecipientActivity,
  type SessionShareView,
} from "../../shared/session-share";
import { relativeTime } from "../lib/format";
import { absoluteTime } from "../lib/spend";
import {
  addRecipient,
  daysWord,
  expiresWord,
  extendShare,
  imagesBlocked,
  isShareChanged,
  isStalePreview,
  copyableLink,
  linkMoved,
  listSessionShares,
  modeLine,
  sliceLine,
  openedLine,
  patchShare,
  presenceWord,
  previewNew,
  previewNewImage,
  previewShare,
  previewShareImage,
  relinkRecipient,
  revokeRecipient,
  shareActivity,
  STALE_PREVIEW,
  stopShare,
  thumbsLine,
  type ThumbState,
  updateShare,
  visitLine,
} from "../lib/session-shares";
import { openSettings } from "../lib/settings-nav";
import { shareHref } from "../lib/share-slice";
import { copyText } from "../lib/ui-state";
import { DELETE_LINK, DELETE_THIS_LINK, deleteLinkConfirm, LINK_GONE } from "../lib/link-delete";
import { SessionThread } from "../share/SessionShareApp";
import { DeleteButton } from "./DeleteButton";
import { Banner, CopyButton, Icon, trapFocus } from "./ui";
import "../shares.css";

/** Activity is read again this often while a managed share is open and the page is visible. */
const ACTIVITY_MS = 5_000;

const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));

/**
 * The Share sheet (§app.session-share/sheet): a dialog, a sheet at folded width, that manages one
 * share. Shares are created on the share page (§app.session-share/share-page), whose Change Slice
 * door this sheet holds. Everything goes to `host`, the host that holds the session (null: this one).
 */
export function ShareSheet(props: {
  host: string | null;
  share: SessionShare;
  onClose(): void;
  /** The share changed: the caller's list re-reads or takes it. */
  onChanged?(share: SessionShare): void;
}) {
  const titleId = `share-sheet-${Math.random().toString(36).slice(2, 8)}`;
  const [share, setShare] = createSignal<SessionShare>(props.share);
  /** What the sheet shows in place of its form: the thread as recipients see it, or a fresh
      preview to confirm before Update to Now or before Follow live stops. */
  const [previewing, setPreviewing] = createSignal<Stage>(null);
  const changed = (s: SessionShare) => {
    setShare(s);
    props.onChanged?.(s);
  };
  const heading = () => {
    const st = previewing();
    if (st === "preview") return "As they see it";
    if (st === "update") return "Update to Now";
    if (st === "snapshot") return "Stop Following Live";
    return "Manage Share";
  };

  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal modal-wide share-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          if (previewing()) setPreviewing(null);
          else props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={titleId}>
            {heading()}
          </h2>
        </div>
        <ManageShare host={props.host} share={share()} previewing={previewing()} setPreviewing={setPreviewing} onClose={props.onClose} onChanged={changed} />
      </div>
    </Portal>
  );
}

// ---- preview ------------------------------------------------------------------------------------

/** `preview`: the thread as recipients see it. `update` / `snapshot`: a fresh preview whose cut an
    Update to Now, or Follow live turning off, will stop at. */
type Stage = null | "preview" | "update" | "snapshot";

/** The thread as the share page draws it, with Show Earlier. */
export function PreviewBody(props: { first: SessionShareView; title?: string; read(before: number): Promise<SessionShareView>; imageUrl(n: number): string }) {
  const [view, setView] = createSignal(props.first);
  const [earlier, setEarlier] = createSignal<"busy" | string | null>(null);
  const more = async () => {
    const v = view();
    if (v.before === undefined) return;
    setEarlier("busy");
    try {
      const page = await props.read(v.before);
      setView((cur) => ({ ...cur, items: [...page.items.filter((i) => i.n < (cur.items[0]?.n ?? Infinity)), ...cur.items], before: page.before }));
      setEarlier(null);
    } catch (x) {
      setEarlier(`Couldn't load earlier messages. ${errText(x)}`);
    }
  };
  return (
    <div class="share-preview">
      <p class="share-preview-line">
        <span class="share-preview-title">{props.title ?? view().title}</span>
        <span class="text-caption text-muted"> · Read only. No visit is recorded.</span>
      </p>
      <SessionThread view={view()} imageUrl={props.imageUrl} onEarlier={() => void more()} earlierState={earlier()} />
    </div>
  );
}

/** Retry shows for a thumbnail that hasn't loaded after this long, as for one that failed. */
const SLOW_THUMB_MS = 10_000;

export const NO_THUMBS: ThumbState = { total: 0, loaded: new Set(), failed: new Set() };

/**
 * Every image a preview shares, as thumbnails loaded at once (never lazily: each must be on screen
 * before anything is shared), with Retry for one that failed or is slow. `onState` reports which
 * loaded, for the gate on Create, Update to Now and Stop Following Live.
 */
export function ImagesShared(props: { count: number; url(n: number): string; onState(t: ThumbState): void }) {
  const ns = () => Array.from({ length: props.count }, (_, i) => i);
  /** Each loaded index, with the attempt it loaded on: its key, so it never mounts again. */
  const [loadedOn, setLoadedOn] = createSignal<ReadonlyMap<number, number>>(new Map());
  const loaded = createMemo<ReadonlySet<number>>(() => new Set(loadedOn().keys()));
  const markLoaded = (n: number) => setLoadedOn((m) => (m.has(n) ? m : new Map([...m, [n, attempt()]])));
  const [failed, setFailed] = createSignal<ReadonlySet<number>>(new Set());
  const [attempt, setAttempt] = createSignal(0);
  const [slow, setSlow] = createSignal(false);
  const add = (set: ReadonlySet<number>, n: number) => new Set([...set, n]);
  const drop = (set: ReadonlySet<number>, n: number) => new Set([...set].filter((x) => x !== n));
  const state = (): ThumbState => ({ total: props.count, loaded: loaded(), failed: failed() });
  createEffect(() => props.onState(state()));
  let timer = setTimeout(() => setSlow(true), SLOW_THUMB_MS);
  onCleanup(() => clearTimeout(timer));
  const retry = () => {
    setFailed(new Set<number>());
    setSlow(false);
    clearTimeout(timer);
    timer = setTimeout(() => setSlow(true), SLOW_THUMB_MS);
    setAttempt((a) => a + 1);
  };
  const line = () => thumbsLine(state());
  const showRetry = () => failed().size > 0 || (slow() && loaded().size < props.count);
  return (
    <section class="stack-2" aria-labelledby="share-images-label">
      <h3 class="text-eyebrow" id="share-images-label">
        {props.count === 1 ? "1 image" : `${props.count} images`}
      </h3>
      <p class="usage-note">Images are shared as they are: nothing in them is hidden.</p>
      <div class="share-thumbs">
        <For each={ns()}>
          {(n) => (
            // A loaded thumbnail stays put; one that isn't mounts again on each Retry.
            <Show when={`try-${loadedOn().get(n) ?? attempt()}`} keyed>
              {(_key) => (
                <a class="share-thumb" classList={{ "share-thumb-failed": failed().has(n) }} href={props.url(n)} target="_blank" rel="noopener noreferrer">
                  <img
                    src={props.url(n)}
                    alt={`Image ${n + 1}`}
                    decoding="async"
                    ref={(img) =>
                      queueMicrotask(() => {
                        if (img.complete && img.naturalWidth > 0) markLoaded(n);
                      })
                    }
                    onLoad={() => {
                      markLoaded(n);
                      setFailed((f) => drop(f, n));
                    }}
                    onError={() => setFailed((f) => add(f, n))}
                  />
                </a>
              )}
            </Show>
          )}
        </For>
      </div>
      <Show when={line() || showRetry()}>
        <div class="share-thumbs-state">
          <Show when={line()}>{(l) => <p class="usage-note text-muted" role="status">{l()}</p>}</Show>
          <Show when={showRetry()}>
            <button type="button" class="button button-sm" onClick={retry}>
              <Icon name="refresh" small />
              Retry Images
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}

/** Freshly minted links, each with Copy Link, and the warning when they may not open. A live one
    stays copyable afterwards from its recipient row. */
export function MintedLinks(props: { links: SessionShareLink[]; warning?: string }) {
  return (
    <div class="stack-2">
      <ul class="list share-links">
        <For each={props.links}>
          {(l) => (
            <li class="list-row share-link-row">
              <div class="list-main">
                <p class="list-title">{l.label}</p>
                <p class="list-meta share-link-url">{l.link}</p>
              </div>
              <CopyButton label="Copy Link" title={`Copy ${l.label}'s link`} text={() => l.link} onCopy={(t) => copyText(t, "Link copied.")} />
            </li>
          )}
        </For>
      </ul>
      <Show when={props.warning}>
        {(w) => (
          <Banner
            tone="warn"
            title={w()}
            action={
              <button type="button" class="button button-sm button-ghost" onClick={() => openSettings("public-links")}>
                Open Settings
              </button>
            }
          />
        )}
      </Show>
    </div>
  );
}

// ---- manage -------------------------------------------------------------------------------------

function ManageShare(props: {
  host: string | null;
  share: SessionShare;
  previewing: Stage;
  setPreviewing(st: Stage): void;
  onClose(): void;
  onChanged(s: SessionShare): void;
}) {
  const s = () => props.share;
  const [now, setNow] = createSignal(Date.now());
  const [activity, setActivity] = createSignal<Map<string, SessionShareRecipientActivity>>(new Map());
  const [title, setTitle] = createSignal(s().title);
  const [draft, setDraft] = createSignal("");
  const [days, setDays] = createSignal<SessionShareDays>(SESSION_SHARE_DEFAULT_DAYS);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [fresh, setFresh] = createSignal<{ links: SessionShareLink[]; warning?: string } | null>(null);
  const [stopArmed, setStopArmed] = createSignal(false);
  const [preview, setPreview] = createSignal<SessionShareView | null>(null);
  /** The fresh preview an Update to Now or Stop Following Live stops at, with its images' state. */
  const [next, setNext] = createSignal<SessionSharePreview | null>(null);
  const [nextThumbs, setNextThumbs] = createSignal<ThumbState>(NO_THUMBS);
  const [nextError, setNextError] = createSignal<string | null>(null);
  const [stale, setStale] = createSignal(false);
  const stopped = () => !!s().stoppedAt;

  /** The share as the host has it now (a recipient relinked elsewhere): the rows are replaced whole. */
  const rereadShare = async () => {
    try {
      const fresh = (await listSessionShares(props.host, s().sessionId)).find((x) => x.id === s().id);
      if (fresh) props.onChanged(fresh);
    } catch {
      // the next activity read tries again; a moved row keeps its Copy Link hidden until then
    }
  };
  const readActivity = async () => {
    try {
      const a = await shareActivity(props.host, s().id);
      setActivity(new Map(a.recipients.map((r) => [r.recipientId, r])));
      // A row whose newest link is not the one it shows (relinked, turned off or stopped elsewhere): read the share again at once.
      if (s().recipients.some((r) => linkMoved(r, a.recipients.find((x) => x.recipientId === r.id)))) void rereadShare();
    } catch {
      // the rows keep the share's own presence and counts
    }
    setNow(Date.now());
  };
  /** Focus lands on Done, not the title field: on a phone a focused field opens the keyboard. */
  let done!: HTMLButtonElement;
  onMount(() => {
    done.focus();
    void readActivity();
    const tick = setInterval(() => document.visibilityState === "visible" && void readActivity(), ACTIVITY_MS);
    onCleanup(() => clearInterval(tick));
  });

  /** A recipient action's failure, said on that recipient's row. */
  const [rowError, setRowError] = createSignal<{ id: string; message: string } | null>(null);
  /** One action at a time; the share it returns replaces ours. Its failure shows on `row`'s own row
      when it is a recipient's action, else in the sheet's banner under the actions. */
  const act = async (name: string, run: () => Promise<SessionShare | SessionShareMinted>, row?: string) => {
    if (busy()) return;
    setBusy(name);
    setError(null);
    setRowError(null);
    try {
      const r = await run();
      if ("links" in r) {
        props.onChanged(r.share);
        setFresh({ links: r.links, warning: r.linkWarning });
      } else props.onChanged(r);
      void readActivity();
    } catch (x) {
      if (row) setRowError({ id: row, message: errText(x) });
      else setError(errText(x));
    } finally {
      setBusy(null);
    }
  };
  const anyoneLive = () => s().recipients.some((r) => r.anyone && r.state === "live");
  const openPreview = async () => {
    try {
      setPreview(await previewShare(props.host, s().id));
      props.setPreviewing("preview");
    } catch (x) {
      setError(`Couldn't read the preview. ${errText(x)}`);
    }
  };
  /** Update to Now and Stop Following Live first show the conversation as it is now, images and
      all; what the recipients then keep is exactly that preview's cut. */
  const readNext = async () => {
    setNext(null);
    setNextThumbs(NO_THUMBS);
    setNextError(null);
    try {
      setNext(await previewNew(props.host, s().sessionId));
    } catch (x) {
      setNextError(errText(x));
    }
  };
  const openNext = (st: "update" | "snapshot") => {
    setStale(false);
    setError(null);
    props.setPreviewing(st);
    void readNext();
  };
  const nextBlocked = () => {
    const p = next();
    if (!p) return nextError() ? "The conversation couldn't be read." : "Reading the conversation first.";
    return imagesBlocked({ ...nextThumbs(), total: p.images });
  };
  const confirmNext = async (st: "update" | "snapshot") => {
    const p = next();
    if (!p || nextBlocked() || busy()) return;
    setBusy(st);
    setStale(false);
    try {
      const r = st === "update" ? await updateShare(props.host, s().id, p.cut) : await patchShare(props.host, s().id, { mode: "snapshot", cut: p.cut });
      props.onChanged(r);
      props.setPreviewing(null);
      void readActivity();
    } catch (x) {
      if (isStalePreview(x)) {
        setStale(true);
        void readNext();
      } else if (isShareChanged(x)) {
        // The share moved under this confirm: back to Manage, whose banner says so, to look again.
        props.setPreviewing(null);
        setError(errText(x));
      } else setNextError(errText(x));
    } finally {
      setBusy(null);
    }
  };
  const titleChanged = () => title().trim() !== s().title && title().trim().length > 0;

  return (
    <Switch>
      <Match when={(props.previewing === "update" || props.previewing === "snapshot") && props.previewing}>
        {(st) => (
          <>
            <div class="modal-body share-preview-body" tabindex="0" aria-label="Preview">
              <p class="usage-note">
                {st() === "update"
                  ? "Their pages will show the conversation as it is here, images included."
                  : "Follow live stops here: their pages keep the conversation as it is here, images included."}
              </p>
              <Show when={stale()}>
                <Banner tone="warn" title={STALE_PREVIEW} body="Nothing changed for them. We read it again: check it, then confirm." />
              </Show>
              <Switch>
                <Match when={nextError()}>
                  {(msg) => (
                    <Banner
                      tone="error"
                      title="Couldn't read the conversation."
                      body={`Nothing changed. ${msg()}`}
                      action={
                        <button type="button" class="button button-sm button-ghost" onClick={() => void readNext()}>
                          Try Again
                        </button>
                      }
                    />
                  )}
                </Match>
                <Match when={!next()}>
                  <p class="usage-note text-muted" aria-busy="true">
                    Reading the conversation…
                  </p>
                </Match>
                <Match when={next()}>
                  {(v) => (
                    <Show when={v().cut} keyed>
                      {(cut) => (
                        <>
                          <Show when={v().images > 0}>
                            <ImagesShared count={v().images} url={(n) => previewNewImage(props.host, s().sessionId, cut, n)} onState={setNextThumbs} />
                          </Show>
                          <PreviewBody
                            first={v()}
                            title={s().title}
                            read={(b) => previewNew(props.host, s().sessionId, { cut, before: b })}
                            imageUrl={(n) => previewNewImage(props.host, s().sessionId, cut, n)}
                          />
                        </>
                      )}
                    </Show>
                  )}
                </Match>
              </Switch>
            </div>
            <div class="modal-foot share-foot">
              <button type="button" class="button" onClick={() => props.setPreviewing(null)}>
                <Icon name="chevron-left" small />
                Back to Share
              </button>
              <span class="modal-spacer" />
              <button type="button" class="button button-primary" title={nextBlocked() ?? undefined} aria-disabled={nextBlocked() || busy() ? "true" : undefined} onClick={() => void confirmNext(st())}>
                {busy() === st() ? "Saving…" : st() === "update" ? "Update to This" : "Stop Following Here"}
              </button>
            </div>
          </>
        )}
      </Match>
      <Match when={props.previewing === "preview" && preview()}>
        {(v) => (
          <>
            <div class="modal-body share-preview-body" tabindex="0" aria-label="Preview">
              <PreviewBody first={v()} read={(b) => previewShare(props.host, s().id, b)} imageUrl={(n) => previewShareImage(props.host, s().id, n)} />
            </div>
            <div class="modal-foot">
              <button type="button" class="button" onClick={() => props.setPreviewing(null)}>
                <Icon name="chevron-left" small />
                Back to Share
              </button>
            </div>
          </>
        )}
      </Match>
      <Match when={true}>
        <div class="modal-body">
          <Show when={fresh()}>
            {(f) => (
              <section class="stack-2" aria-label="New links">
                <h3 class="text-eyebrow">{f().links.length === 1 ? "New link" : `${f().links.length} new links`}</h3>
                <MintedLinks links={f().links} warning={f().warning} />
              </section>
            )}
          </Show>
          <Show when={stopped()}>
            <Banner tone="info" title={`Stopped ${relativeTime(s().stoppedAt!, now())}.`} body="Every link is off. The session itself didn't change." />
          </Show>
          <Show when={s().missing}>
            <Banner tone="warn" title="The session file is gone." body="Every link answers that it's no longer active." />
          </Show>

          <div class="field">
            <label class="field-label" for="share-manage-title">
              Title they see
            </label>
            <div class="share-add-row">
              <input id="share-manage-title" class="input" maxlength={SHARE_TITLE_MAX} value={title()} disabled={stopped()} onInput={(e) => setTitle(e.currentTarget.value)} />
              <Show when={titleChanged()}>
                <button type="button" class="button" aria-disabled={busy() ? "true" : undefined} onClick={() => void act("title", () => patchShare(props.host, s().id, { title: title().trim() }))}>
                  Save Title
                </button>
              </Show>
            </div>
          </div>

          <Show when={!stopped()}>
            {/* What the share holds, and the door to the share page to pick it again. */}
            <div class="share-snapshot">
              <p class="usage-note">{sliceLine(s())}</p>
              <a class="button button-sm" href={shareHref(s().sessionId, { host: props.host, share: s().id })} onClick={() => props.onClose()}>
                Change Slice
              </a>
            </div>
            <label class="toggle toggle-switch share-switch">
              <span class="share-switch-text">
                <span>Follow live</span>
                <span class="field-hint">
                  {s().mode === "live" ? "They see new messages as the session goes on." : "Off: turning it on shows them new messages as the session goes on."}
                </span>
              </span>
              <input
                type="checkbox"
                checked={s().mode === "live"}
                disabled={!!busy()}
                onChange={(e) => {
                  if (e.currentTarget.checked) return void act("mode", () => patchShare(props.host, s().id, { mode: "live" }));
                  // Turning it off stops at a reviewed point: the switch stays on until that's confirmed.
                  e.currentTarget.checked = true;
                  openNext("snapshot");
                }}
              />
              <span class="toggle-box" />
            </label>
            <Show when={s().mode === "snapshot"}>
              <div class="share-snapshot">
                <p class="usage-note">{modeLine(s(), (iso) => absoluteTime(iso, now()))}.</p>
                <button type="button" class="button button-sm" aria-disabled={busy() ? "true" : undefined} title="Their pages show the conversation as it is now." onClick={() => !busy() && openNext("update")}>
                  <Icon name="refresh" small />
                  Update to Now
                </button>
              </div>
            </Show>
          </Show>

          <section class="stack-2" aria-labelledby="share-people-label">
            <h3 class="text-eyebrow" id="share-people-label">
              People
            </h3>
            <ul class="list share-recipients">
              <For each={s().recipients}>
                {(r) => (
                  <RecipientRow
                    recipient={r}
                    activity={activity().get(r.id)}
                    now={now()}
                    busy={!!busy()}
                    error={rowError()?.id === r.id ? rowError()!.message : undefined}
                    onRelink={() => void act(`relink:${r.id}`, () => relinkRecipient(props.host, s().id, r.id), r.id)}
                    onRevoke={() => void act(`revoke:${r.id}`, () => revokeRecipient(props.host, s().id, r.id), r.id)}
                  />
                )}
              </For>
            </ul>
            <Show when={!stopped()}>
              <div class="share-add-row">
                <label class="visually-hidden" for="share-manage-person">
                  Add a person
                </label>
                <input
                  id="share-manage-person"
                  class="input"
                  maxlength={RECIPIENT_LABEL_MAX}
                  placeholder="Add a person, like Ben"
                  value={draft()}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && draft().trim()) {
                      e.preventDefault();
                      const label = draft().trim();
                      setDraft("");
                      void act("add", () => addRecipient(props.host, s().id, { label }));
                    }
                  }}
                />
                <button
                  type="button"
                  class="button"
                  aria-disabled={!draft().trim() || busy() ? "true" : undefined}
                  onClick={() => {
                    const label = draft().trim();
                    if (!label) return;
                    setDraft("");
                    void act("add", () => addRecipient(props.host, s().id, { label }));
                  }}
                >
                  Add Person
                </button>
              </div>
              <Show when={!anyoneLive()}>
                <button type="button" class="button button-sm share-anyone-add" aria-disabled={busy() ? "true" : undefined} onClick={() => void act("anyone", () => addRecipient(props.host, s().id, { anyone: true }))}>
                  <Icon name="plus" small />
                  Add Anyone Link
                </button>
              </Show>
            </Show>
          </section>

          <Show when={!stopped()}>
            <section class="stack-2" aria-labelledby="share-extend-label">
              <h3 class="text-eyebrow" id="share-extend-label">
                Expiry
              </h3>
              <div class="share-add-row">
                <label class="visually-hidden" for="share-extend-days">
                  Extend by
                </label>
                <span class="select-wrap">
                  <select id="share-extend-days" class="select" value={days()} onChange={(e) => setDays(Number(e.currentTarget.value) as SessionShareDays)}>
                    <For each={SESSION_SHARE_DAYS}>{(d) => <option value={d}>{daysWord(d)} from now</option>}</For>
                  </select>
                  <span class="select-caret" aria-hidden="true">
                    <Icon name="chevron-down" small />
                  </span>
                </span>
                <button type="button" class="button" aria-disabled={busy() ? "true" : undefined} onClick={() => void act("extend", () => extendShare(props.host, s().id, days()))}>
                  Extend
                </button>
              </div>
              <p class="field-hint">Every live link then expires {daysWord(days())} from now.</p>
            </section>
          </Show>

          <Show when={error()}>{(msg) => <Banner tone="error" title="That didn't go through." body={`Nothing changed. ${msg()}`} />}</Show>
        </div>
        <div class="modal-foot share-foot">
          <Show when={!stopped()}>
            <button
              type="button"
              class="button button-destructive"
              aria-disabled={busy() ? "true" : undefined}
              onClick={() => {
                if (!stopArmed()) return setStopArmed(true);
                setStopArmed(false);
                void act("stop", () => stopShare(props.host, s().id));
              }}
              onBlur={() => setStopArmed(false)}
            >
              {stopArmed() ? "Stop Every Link?" : "Stop Sharing"}
            </button>
          </Show>
          <span class="modal-spacer" />
          <button type="button" class="button" onClick={() => void openPreview()}>
            Preview
          </button>
          <button type="button" class="button button-primary" ref={done} onClick={() => props.onClose()}>
            Done
          </button>
        </div>
      </Match>
    </Switch>
  );
}

function RecipientRow(props: {
  recipient: SessionShareRecipient;
  activity?: SessionShareRecipientActivity;
  now: number;
  busy: boolean;
  /** Why this row's last Get New Link or Delete Link didn't go through: the server's own sentence. */
  error?: string;
  onRelink(): void;
  onRevoke(): void;
}) {
  const r = () => props.recipient;
  const presence = () => props.activity?.presence ?? r().presence;
  const opened = () => props.activity?.opened ?? r().opened;
  const lastAt = () => props.activity?.lastAt ?? r().lastAt;
  const visits = createMemo(() => props.activity?.visits ?? []);
  /** The row's own link, while it is live, kept, and still the recipient's newest (§app.session-share/sheet). */
  const copyable = () => copyableLink(r(), props.activity);
  return (
    <li class="list-row share-recipient" classList={{ "share-recipient-off": r().state !== "live" }}>
      <div class="list-main">
        <p class="list-title share-recipient-name">
          {r().label}
          <RecipientChip state={r().state} presence={presence()} />
        </p>
        <p class="list-meta">
          {openedLine(opened(), lastAt(), (iso) => relativeTime(iso, props.now))}
          <Show when={r().state === "live"}> · {expiresWord(r().expiresAt, props.now)}</Show>
        </p>
        <Show when={visits().length > 0}>
          <details class="disclosure share-visits">
            <summary class="disclosure-summary">
              <Icon name="chevron-right" small class="icon-twist" />
              <span class="disclosure-label">Visits</span>
              <span class="disclosure-preview">· {visits().length}</span>
            </summary>
            <ul class="disclosure-body share-visit-list">
              <For each={visits()}>
                {(v) => (
                  <li class="text-caption" title={absoluteTime(v.at, props.now)}>
                    {visitLine(v, (iso) => relativeTime(iso, props.now))}
                  </li>
                )}
              </For>
            </ul>
          </details>
        </Show>
      </div>
      <Show when={r().state !== "off"}>
        <div class="share-recipient-actions">
          <Show when={copyable()}>
            {(link) => <CopyButton label="Copy Link" title={r().anyone ? "Copy this link" : `Copy ${r().label}'s link`} text={link} onCopy={(t) => copyText(t, "Link copied.")} />}
          </Show>
          <button type="button" class="button button-sm" aria-disabled={props.busy ? "true" : undefined} title="A new link for them. This one stops working." onClick={() => props.onRelink()}>
            Get New Link
          </button>
          <DeleteButton
            label={DELETE_LINK}
            confirm={r().anyone ? DELETE_THIS_LINK : deleteLinkConfirm(r().label)}
            note={LINK_GONE}
            disabled={props.busy}
            onRun={() => props.onRevoke()}
          />
        </div>
      </Show>
      <Show when={props.error}>
        {(msg) => (
          // Under the row's buttons, the width of the row, brought into view: the press was right here.
          <p class="field-error share-recipient-error" role="alert" ref={(el) => queueMicrotask(() => el.scrollIntoView({ block: "nearest" }))}>
            Nothing changed. {msg()}
          </p>
        )}
      </Show>
    </li>
  );
}

/** A recipient's standing: presence while live (dot and word), else the link's state. */
export function RecipientChip(props: { state: SessionShareRecipient["state"]; presence: SessionShareRecipient["presence"] }) {
  return (
    <Switch>
      <Match when={props.state === "off"}>
        <span class="chip">
          <span class="chip-dot" aria-hidden="true" />
          Turned off
        </span>
      </Match>
      <Match when={props.state === "expired"}>
        <span class="chip chip-warn">
          <span class="chip-dot" aria-hidden="true" />
          Expired
        </span>
      </Match>
      <Match when={presenceWord(props.presence)}>
        {(w) => (
          <span class={props.presence === "viewing" ? "chip chip-success" : "chip"}>
            <span class="chip-dot" aria-hidden="true" />
            {w()}
          </span>
        )}
      </Match>
    </Switch>
  );
}
