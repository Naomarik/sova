import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import {
  ANYONE_LABEL,
  RECIPIENT_LABEL_MAX,
  RECIPIENTS_MAX,
  SESSION_SHARE_DAYS,
  SESSION_SHARE_DEFAULT_DAYS,
  SHARE_TITLE_MAX,
  type SessionShare,
  type SessionShareDays,
  type SessionShareMinted,
  type SessionShareOutline,
  type SessionSharePatch,
  type SessionSharePreview,
} from "../../shared/session-share";
import { relativeTime } from "../lib/format";
import {
  cleanLabels,
  createBlocked,
  createShare,
  daysWord,
  imagesBlocked,
  isShareChanged,
  isStalePreview,
  listSessionShares,
  patchShare,
  previewNew,
  previewNewImage,
  previewOutline,
  STALE_PREVIEW,
  type ThumbState,
} from "../lib/session-shares";
import { applyHint, bounds, canFollowLive, endsLine, HINT_WORDS, hints, inSlice, normalize, rangeLabel, sliceOfShare, spanOf, tap, WHOLE, type ShareRoute, type Slice } from "../lib/share-slice";
import { toast } from "../lib/ui-state";
import { InsightsPage } from "./InsightsPage";
import { ImagesShared, MintedLinks, NO_THUMBS, PreviewBody } from "./ShareSheet";
import { Banner, Icon } from "./ui";
import "../shares.css";
import "../share-page.css";

const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));
const rowId = (i: number) => `slice-row-${i}`;

/** `pick`: the list and its bar. `preview`: the slice as recipients will see it. `review`: the
    create form (or, changing a share, its images) over the sliced preview. `done`: the new links. */
type Step = "pick" | "preview" | "review" | "done";

/**
 * The share page (§app.session-share/share-page): pick a start and an end over the session's
 * outline in two taps, then create a share of that slice, or, with `route.share`, save a new slice
 * for that share. Everything goes to `route.host`, the host that holds the session (null: this one).
 */
export function SharePage(props: { route: ShareRoute; titleRef(el: HTMLHeadingElement): void }) {
  const host = props.route.host;
  const sid = props.route.sessionId;
  const back = `#/sid/${encodeURIComponent(sid)}`;

  const [outline, setOutline] = createSignal<SessionShareOutline | null>(null);
  /** `old`: the host answered without an outline, so it can't slice and nothing is minted here. */
  const [phase, setPhase] = createSignal<"loading" | "ready" | "old">("loading");
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [share, setShare] = createSignal<SessionShare | null>(null);
  const [slice, setSlice] = createSignal<Slice>(WHOLE);
  const [live, setLive] = createSignal(false);
  /** Picking an end turned Follow live off: the bar says why, until the next change. */
  const [liveOff, setLiveOff] = createSignal(false);
  const [step, setStep] = createSignal<Step>("pick");
  /** The sliced preview Preview and Next show, fixed at its cut: what is minted or saved. */
  const [preview, setPreview] = createSignal<SessionSharePreview | null>(null);
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  const [thumbs, setThumbs] = createSignal<ThumbState>(NO_THUMBS);
  const [stale, setStale] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [minted, setMinted] = createSignal<SessionShareMinted | null>(null);

  const [title, setTitle] = createSignal("");
  let titleEdited = false;
  const [labels, setLabels] = createSignal<string[]>([]);
  const [draft, setDraft] = createSignal("");
  const [anyone, setAnyone] = createSignal(false);
  const [days, setDays] = createSignal<SessionShareDays>(SESSION_SHARE_DEFAULT_DAYS);
  let labelInput!: HTMLInputElement;

  const rows = createMemo(() => outline()?.items ?? []);
  const changing = () => props.route.share !== null;

  let first = true;
  const readOutline = async () => {
    setLoadError(null);
    try {
      const [o, shares] = await Promise.all([previewOutline(host, sid), changing() && first ? listSessionShares(host, sid) : null]);
      // An older host answers the plain preview: no entry ids, so nothing here can name a start.
      if (!Array.isArray(o?.items) || o.items.some((i) => typeof i?.id !== "string")) return void setPhase("old");
      setOutline(o);
      if (first) {
        first = false;
        const s = shares?.find((x) => x.id === props.route.share) ?? null;
        if (changing() && !s) return void setLoadError("This share isn't on this session anymore.");
        setShare(s);
        if (s) {
          setSlice(sliceOfShare(o.items, s));
          setLive(s.mode === "live");
          setTitle(s.title);
        } else setSlice(normalize(o.items, { start: props.route.from, end: null }));
      } else setSlice((s) => normalize(o.items, s));
      setPhase("ready");
    } catch (x) {
      setLoadError(errText(x));
    }
  };
  onMount(() => void readOutline());

  const pick = (id: string) => {
    const next = tap(rows(), slice(), id);
    setSlice(next);
    setStale(false);
    if (live() && !canFollowLive(next)) {
      setLive(false);
      setLiveOff(true);
    } else setLiveOff(false);
  };
  const span = () => spanOf(rows(), slice(), live());
  /** Until a boundary is picked the whole session is the range, and no row is marked. */
  const picked = () => slice().start !== null || slice().end !== null;
  const sliceHints = () => hints(rows(), slice());

  /** Reads the slice as recipients will see it, at the end picked (else the outline's cut). */
  const readSliced = async () => {
    const o = outline();
    if (!o) return;
    const s = slice();
    setPreview(null);
    setPreviewError(null);
    setThumbs(NO_THUMBS);
    try {
      const p = await previewNew(host, sid, { cut: s.end ?? o.cut, ...(s.start ? { from: s.start } : {}) });
      if (!titleEdited && !title()) setTitle(p.title.slice(0, SHARE_TITLE_MAX));
      setPreview(p);
    } catch (x) {
      if (isStalePreview(x)) return onStale();
      setPreviewError(errText(x));
    }
  };
  /** Another write changed the share's mode, end or start while Save Slice ran: nothing was
      written. The share is read again, so the next Save Slice is built on it; the picks stay. */
  const [changedMeanwhile, setChangedMeanwhile] = createSignal(false);
  const onShareChanged = async () => {
    try {
      const s = (await listSessionShares(host, sid)).find((x) => x.id === props.route.share);
      if (!s) return setError("This share isn't on this session anymore.");
      setShare(s);
      setChangedMeanwhile(true);
    } catch (x) {
      setError(errText(x));
    }
  };
  /** A start or cut no longer on the branch: nothing went out; the list is read again to pick again. */
  const onStale = () => {
    readFor = null;
    setStale(true);
    setStep("pick");
    void readOutline();
  };
  /** The slice the preview on hand was read for: Preview and Next read again only when it moved. */
  const sliceKey = () => `${slice().start ?? ""}\u0000${slice().end ?? outline()?.cut ?? ""}`;
  let readFor: string | null = null;
  /** Back from Preview returns to the step it was opened from. */
  let previewFrom: "pick" | "review" = "pick";
  const go = (st: "preview" | "review") => {
    if (phase() !== "ready" || rows().length === 0) return;
    setError(null);
    if (st === "preview") previewFrom = step() === "review" ? "review" : "pick";
    setStep(st);
    if (readFor === sliceKey() && (preview() || previewError() === null)) return;
    readFor = sliceKey();
    void readSliced();
  };

  const total = () => labels().length + (anyone() ? 1 : 0);
  const addLabel = () => {
    const next = cleanLabels([...labels(), draft()]);
    if (next.length === labels().length) return;
    setLabels(next.slice(0, RECIPIENTS_MAX - (anyone() ? 1 : 0)));
    setDraft("");
    labelInput.focus();
  };
  const previewState = () => (preview() ? "ready" : previewError() ? "failed" : "loading");
  const reviewThumbs = () => (preview() ? { ...thumbs(), total: preview()!.images } : NO_THUMBS);
  const blocked = (): string | null => {
    if (!changing()) return createBlocked({ title: title(), recipients: total(), max: RECIPIENTS_MAX, preview: previewState(), thumbs: reviewThumbs() });
    if (previewState() === "failed") return "The conversation couldn't be read, so nothing can be saved yet.";
    if (previewState() === "loading") return "Reading the conversation first.";
    return imagesBlocked(reviewThumbs());
  };

  const submit = async () => {
    const p = preview();
    const s = slice();
    if (busy() || blocked() || !p) return;
    setBusy(true);
    setError(null);
    setChangedMeanwhile(false);
    try {
      const cur = share();
      if (cur) {
        const patch: SessionSharePatch = { from: s.start };
        if (live()) {
          if (cur.mode !== "live") patch.mode = "live";
        } else {
          patch.cut = p.cut;
          if (cur.mode === "live") patch.mode = "snapshot";
        }
        await patchShare(host, cur.id, patch);
        toast("Slice saved.");
        location.hash = back;
      } else {
        const m = await createShare(host, {
          sessionId: sid,
          title: title().trim(),
          mode: live() ? "live" : "snapshot",
          // A snapshot is exactly the preview on screen; Follow live has no cut by design.
          ...(live() ? {} : { cut: p.cut }),
          ...(s.start ? { from: s.start } : {}),
          expiresInDays: days(),
          recipients: labels(),
          anyone: anyone(),
        });
        setMinted(m);
        setStep("done");
      }
    } catch (x) {
      if (isStalePreview(x)) onStale();
      else if (isShareChanged(x)) void onShareChanged();
      else setError(errText(x));
    } finally {
      setBusy(false);
    }
  };

  /** The list opens on the picked start (else the end): a deep link's start, or where Back left it. */
  const toPicked = () =>
    queueMicrotask(() => {
      // A stale banner sits above the list: it stays in view.
      if (stale()) return;
      const id = slice().start ?? slice().end;
      const at = id === null ? -1 : rows().findIndex((i) => i.id === id);
      if (at >= 0) document.getElementById(rowId(at))?.scrollIntoView({ block: "center" });
    });
  /** Each step opens at its top: the pane keeps the list's scroll otherwise. */
  const top = (el: HTMLElement) => queueMicrotask(() => el.closest(".pane")?.scrollTo(0, 0));
  const heading = () => (changing() ? "Change Slice" : "Share Session");

  return (
    <InsightsPage
      title={heading()}
      class="share-page"
      meta={share()?.title}
      back={{ href: back, label: "Back to Session" }}
      refreshLabel="Read Messages Again"
      onRefresh={() => {
        if (step() === "pick") void readOutline();
        else void readSliced();
      }}
      error={loadError()}
      errorTitle="Couldn't read the conversation."
      busy={phase() === "loading" && !loadError()}
      titleRef={props.titleRef}
    >
      <Switch>
        <Match when={phase() === "old"}>
          <div class="empty">
            <p class="empty-title">This host needs an update to share part of a session.</p>
            <p class="empty-body">Nothing was shared. Once it runs the current Sova, open this page again.</p>
          </div>
        </Match>

        <Match when={step() === "done" && minted()}>
          {(m) => (
            <div ref={top} class="share-page-col stack-2">
              <p class="usage-note">
                <strong>{rangeLabel(span())}.</strong> {m().links.length === 1 ? "The link shows only once, here." : "Each link shows only once, here."}
              </p>
              <MintedLinks links={m().links} warning={m().linkWarning} />
              <div class="share-page-done">
                <a class="button button-primary" href={back}>
                  Done
                </a>
              </div>
            </div>
          )}
        </Match>

        <Match when={step() === "preview"}>
          <div ref={top} class="share-page-col">
            <Show when={preview()} fallback={<SlicedPreviewState error={previewError()} retry={() => void readSliced()} />}>
              {(p) => (
                <PreviewBody
                  first={p()}
                  title={title().trim() || undefined}
                  read={(b) => previewNew(host, sid, { cut: p().cut, before: b, ...(p().from ? { from: p().from } : {}) })}
                  imageUrl={(n) => previewNewImage(host, sid, p().cut, n, p().from)}
                />
              )}
            </Show>
          </div>
        </Match>

        <Match when={step() === "review"}>
          <div ref={top} class="share-page-col stack">
            <p class="usage-note">
              <strong>{rangeLabel(span())}.</strong>{" "}
              {changing() ? "Open pages start over with the new slice." : "People you send a link to can read these messages and the replies, with their drawings and images. Never tool steps, thinking, paths or costs."}
            </p>
            <Show when={!changing()}>
              <CreateFields
                title={title()}
                setTitle={(t) => {
                  titleEdited = true;
                  setTitle(t);
                }}
                labels={labels()}
                setLabels={setLabels}
                draft={draft()}
                setDraft={setDraft}
                addLabel={addLabel}
                labelRef={(el) => (labelInput = el)}
                anyone={anyone()}
                setAnyone={setAnyone}
                live={live()}
                canLive={canFollowLive(slice())}
                setLive={setLive}
                days={days()}
                setDays={setDays}
              />
            </Show>
            <Show when={preview()} fallback={<SlicedPreviewState error={previewError()} retry={() => void readSliced()} />}>
              {(p) => (
                <Show when={p().images > 0}>
                  {/* Keyed on the cut and start: a new preview reviews its images from scratch. */}
                  <Show when={`${p().cut}\u0000${p().from ?? ""}`} keyed>
                    {(_key) => <ImagesShared count={p().images} url={(n) => previewNewImage(host, sid, p().cut, n, p().from)} onState={setThumbs} />}
                  </Show>
                </Show>
              )}
            </Show>
            <Show when={changedMeanwhile()}>
              <Banner tone="warn" title="This share changed meanwhile." body="Nothing was changed. We read it again: save again to apply this slice." />
            </Show>
            <Show when={error()}>
              {(msg) => (
                <div ref={(el) => queueMicrotask(() => el.scrollIntoView({ block: "nearest" }))}>
                  <Banner tone="error" title={changing() ? "Couldn't save the slice." : "Couldn't create the links."} body={`Nothing was ${changing() ? "changed" : "shared"}. ${msg()}`} />
                </div>
              )}
            </Show>
          </div>
        </Match>

        <Match when={phase() === "ready"}>
          <div class="share-page-col stack-2">
            <Show when={stale()}>
              <Banner tone="warn" title={STALE_PREVIEW} body={`Nothing was ${changing() ? "changed" : "shared"}. We read it again: check the slice, then go on.`} />
            </Show>
            <Show when={rows().length > 0} fallback={<div class="empty"><p class="empty-title">No messages yet.</p><p class="empty-body">There's nothing to share until the session has a message.</p></div>}>
              <p class="usage-note text-muted">Tap where the share starts, then where it ends.</p>
              <ol class="slice-list" aria-label="Messages" ref={toPicked}>
                <For each={rows()}>
                  {(it, i) => {
                    const isStart = () => slice().start === it.id;
                    const isEnd = () => slice().end === it.id;
                    const mark = () => (isStart() && isEnd() ? "Start and end" : isStart() ? "Start" : isEnd() ? "End" : null);
                    return (
                      <li>
                        <button
                          type="button"
                          id={rowId(i())}
                          class="slice-row"
                          classList={{ "slice-row-in": picked() && inSlice(rows(), slice(), i()), "slice-row-edge": !!mark(), "slice-row-user": it.kind === "user" }}
                          onClick={() => pick(it.id)}
                        >
                          <span class="slice-row-head">
                            <span class="slice-row-n">{i() + 1}</span>
                            <span class="slice-row-role">{it.kind === "user" ? "You" : "Reply"}</span>
                            <Show when={it.at}>{(t) => <span class="slice-row-time">{relativeTime(t())}</span>}</Show>
                            <Show when={it.images > 0}>
                              <span class="slice-row-images" aria-label={it.images === 1 ? "1 image" : `${it.images} images`}>
                                <Icon name="image" small />
                                {it.images}
                              </span>
                            </Show>
                            <Show when={mark()}>{(m) => <span class="chip chip-accent slice-row-mark">{m()}</span>}</Show>
                          </span>
                          <span class="slice-row-text">{it.excerpt || (it.images > 0 ? "Image only." : "")}</span>
                        </button>
                      </li>
                    );
                  }}
                </For>
              </ol>
            </Show>
          </div>
        </Match>
      </Switch>

      <Show when={phase() === "ready" && step() !== "done" && rows().length > 0}>
        <div class="slice-bar" role="region" aria-label="Slice">
          <div class="slice-bar-range">
            <p class="slice-bar-label" role="status">
              {rangeLabel(span())}
            </p>
            {/* Following live, the label already says both ends. */}
            <Show when={!live()}>
              <p class="slice-bar-ends">{endsLine(rows(), slice(), false)}</p>
            </Show>
          </div>
          <Show when={step() === "pick"}>
            <For each={sliceHints()}>
              {(h) => (
                <p class="slice-hint">
                  <span>{HINT_WORDS[h.kind].line}</span>
                  <button type="button" class="button button-sm" onClick={() => setSlice(applyHint(slice(), h))}>
                    {HINT_WORDS[h.kind].action}
                  </button>
                </p>
              )}
            </For>
            <Show when={liveOff()}>
              <p class="slice-hint text-muted">Follow live is off: a share with an end stays as it is at that message.</p>
            </Show>
          </Show>
          <div class="slice-bar-actions">
            <Show when={step() !== "pick"}>
              <button type="button" class="button button-ghost" onClick={() => setStep(step() === "preview" ? previewFrom : "pick")}>
                <Icon name="chevron-left" small />
                Back
              </button>
            </Show>
            <span class="modal-spacer" />
            <Show when={step() !== "preview"}>
              <button type="button" class="button" onClick={() => go("preview")}>
                Preview
              </button>
            </Show>
            <Switch>
              <Match when={step() === "review"}>
                <button type="button" class="button button-primary" title={blocked() ?? undefined} aria-disabled={blocked() || busy() ? "true" : undefined} onClick={() => void submit()}>
                  {changing() ? (busy() ? "Saving…" : "Save Slice") : busy() ? "Creating…" : total() === 1 ? "Create Link" : "Create Links"}
                </button>
              </Match>
              <Match when={true}>
                <button type="button" class="button button-primary" onClick={() => go("review")}>
                  {changing() ? "Save Slice" : "Next"}
                </button>
              </Match>
            </Switch>
          </div>
        </div>
      </Show>
    </InsightsPage>
  );
}

/** The sliced preview while it loads, or why it couldn't be read. */
function SlicedPreviewState(props: { error: string | null; retry(): void }) {
  return (
    <Show
      when={props.error}
      fallback={
        <p class="usage-note text-muted" aria-busy="true">
          Reading the conversation…
        </p>
      }
    >
      {(msg) => (
        <Banner
          tone="error"
          title="Couldn't read the conversation to preview it."
          body={`Nothing was shared. ${msg()}`}
          action={
            <button type="button" class="button button-sm button-ghost" onClick={() => props.retry()}>
              Try Again
            </button>
          }
        />
      )}
    </Show>
  );
}

/** The create form (§app.session-share/sheet's fields): the public title, the people, Anyone with
    the link, Follow live (only while the end is the latest) and the expiry. */
function CreateFields(props: {
  title: string;
  setTitle(t: string): void;
  labels: string[];
  setLabels(f: (ls: string[]) => string[]): void;
  draft: string;
  setDraft(d: string): void;
  addLabel(): void;
  labelRef(el: HTMLInputElement): void;
  anyone: boolean;
  setAnyone(on: boolean): void;
  live: boolean;
  canLive: boolean;
  setLive(on: boolean): void;
  days: SessionShareDays;
  setDays(d: SessionShareDays): void;
}) {
  return (
    <div class="stack">
      <div class="field">
        <label class="field-label" for="share-title">
          Title they see
        </label>
        <input id="share-title" class="input" maxlength={SHARE_TITLE_MAX} value={props.title} onInput={(e) => props.setTitle(e.currentTarget.value)} />
        <p class="field-hint">The session's own title may say more than you mean to.</p>
      </div>

      <div class="field">
        <label class="field-label" for="share-person">
          People
        </label>
        <div class="share-add-row">
          <input
            id="share-person"
            ref={props.labelRef}
            class="input"
            maxlength={RECIPIENT_LABEL_MAX}
            placeholder="A name only you see, like Ana"
            value={props.draft}
            onInput={(e) => props.setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                props.addLabel();
              }
            }}
          />
          <button type="button" class="button" aria-disabled={!props.draft.trim() ? "true" : undefined} onClick={() => props.addLabel()}>
            <Icon name="plus" small />
            Add
          </button>
        </div>
        <p class="field-hint">Each person gets their own link, so you see who opened it and can delete one alone.</p>
        <Show when={props.labels.length > 0}>
          <ul class="share-people" aria-label="Added people">
            <For each={props.labels}>
              {(l) => (
                <li class="chip share-person">
                  {l}
                  <button type="button" class="share-person-remove" aria-label={`Remove ${l}`} title={`Remove ${l}`} onClick={() => props.setLabels((ls) => ls.filter((x) => x !== l))}>
                    <Icon name="close" small />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      <label class="toggle toggle-switch share-switch">
        <span class="share-switch-text">
          <span>{ANYONE_LABEL}</span>
          <span class="field-hint">One more link anyone can open. Its visits show the device type only.</span>
        </span>
        <input type="checkbox" checked={props.anyone} onChange={(e) => props.setAnyone(e.currentTarget.checked)} />
        <span class="toggle-box" />
      </label>

      <Show when={props.canLive}>
        <label class="toggle toggle-switch share-switch">
          <span class="share-switch-text">
            <span>Follow live</span>
            <span class="field-hint">
              {props.live ? "They see new messages as the session goes on, including ones you haven't read yet." : "Off: they see these messages as they are now. You can update it to now later."}
            </span>
          </span>
          <input type="checkbox" checked={props.live} onChange={(e) => props.setLive(e.currentTarget.checked)} />
          <span class="toggle-box" />
        </label>
      </Show>

      <div class="field">
        <label class="field-label" for="share-days">
          Links expire after
        </label>
        <span class="select-wrap">
          <select id="share-days" class="select" value={props.days} onChange={(e) => props.setDays(Number(e.currentTarget.value) as SessionShareDays)}>
            <For each={SESSION_SHARE_DAYS}>{(d) => <option value={d}>{daysWord(d)}</option>}</For>
          </select>
          <span class="select-caret" aria-hidden="true">
            <Icon name="chevron-down" small />
          </span>
        </span>
      </div>
    </div>
  );
}
