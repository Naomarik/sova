import { createEffect, createMemo, createSignal, For, Match, on, onMount, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import { SAVED_SESSIONS_BRANCH, type SavedBy, type SavePrepareResponse, type SaveReviewItem, type SaveScope } from "../../shared/session-bundle";
import { prepareSave, savePreparedImageUrl, saveSession } from "../lib/api";
import { relativeTime } from "../lib/format";
import { bytes } from "../lib/mesh-details";
import {
  cleaningLine,
  type Decision,
  decisionsToSend,
  excerptParts,
  reviewLine,
  revWord,
  saveBlocked,
  savedByName,
  sizeFor,
  sizeLine,
  sizeNote,
  sizeState,
  undecided,
  withoutImages,
} from "../lib/saved-sessions";
import { announce, toast } from "../lib/ui-state";
import { Banner, Icon, trapFocus } from "./ui";
import "../saved-sessions.css";

/** Bumped after every save, wherever it was opened from: the Sharing tab's Saved list reads again. */
const [savedTick, setSavedTick] = createSignal(0);
export { savedTick };
export const bumpSaved = () => setSavedTick((n) => n + 1);

const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));

type Stage = "form" | "review" | "public" | { conflict: { rev: number; savedBy: SavedBy; savedAt: string } };

/**
 * Save Session (§chat.saved-sessions/save-dialog): opens on the cleaned copy `prepare` built, asks
 * for a title, a note, the branches, how much history, images, the review of possible secrets and
 * images, and push, then saves to the saved-sessions branch. Save stays disabled, saying why, until
 * everything in the review has a decision. A conflict with someone else's newer version asks
 * Save as New Copy or Replace Theirs (§chat.saved-sessions/resave).
 */
export function SaveSessionDialog(props: {
  path: string;
  onClose(): void;
  /** A save landed: the caller's Saved list reads again. */
  onSaved?(): void;
}) {
  const titleId = `save-session-${Math.random().toString(36).slice(2, 8)}`;
  const [prep, setPrep] = createSignal<SavePrepareResponse | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [stage, setStage] = createSignal<Stage>("form");

  const [title, setTitle] = createSignal("");
  const [note, setNote] = createSignal("");
  const [branches, setBranches] = createSignal<string[]>([]);
  const [scope, setScope] = createSignal<SaveScope>("whole");
  const [trim, setTrim] = createSignal(false);
  const [images, setImages] = createSignal(true);
  const [decisions, setDecisions] = createSignal<Record<string, Decision>>({});
  const [push, setPush] = createSignal(false);
  /** The may-be-public warning was answered Push in this dialog (the server remembers it on save). */
  const [acceptPublic, setAcceptPublic] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  const load = async () => {
    setLoadError(null);
    setPrep(null);
    try {
      const p = await prepareSave(props.path);
      setPrep(p);
      setTitle(p.lineage?.title ?? p.title);
      // Save Again keeps what the last version said: its note, and its branches beside this session's.
      setNote(p.lineage?.note ?? "");
      setBranches([...new Set([...(p.lineage?.branches ?? []), ...p.branches])]);
      // Every choice starts at its default, whatever the size: over the limit, the smaller choice is
      // the user's to make (§chat.saved-sessions/size), and Save waits for it.
      setScope("whole");
      setTrim(false);
      setPush(p.push.remote ? p.push.remembered : false);
      setAcceptPublic(p.push.publicWarningAccepted);
    } catch (err) {
      setLoadError(errText(err));
    }
  };
  onMount(() => void load());

  const size = () => {
    const p = prep();
    return p ? withoutImages(sizeFor(p.sizes, scope(), trim()), p.review, images()) : null;
  };
  const review = () => prep()?.review ?? [];
  const left = () => undecided(review(), decisions(), images());
  const needsPublicOk = () => push() && !!prep()?.push.remote && !prep()!.push.publicWarningAccepted && !acceptPublic();
  const blocked = () =>
    saveBlocked({ title: title(), branches: branches(), size: size(), review: review(), decisions: decisions(), includeImages: images(), busy: busy() });

  const decide = (id: string, d: Decision) => setDecisions((m) => ({ ...m, [id]: d }));
  const decideAll = (d: Decision) =>
    setDecisions((m) => {
      const next = { ...m };
      for (const r of review()) if (r.kind === "possible-secret" || images()) next[r.id] = d;
      return next;
    });

  const save = async (onConflict?: "new-copy" | "replace") => {
    const p = prep();
    if (!p || (blocked() && !onConflict)) return;
    // The first push to a remote asks once (§chat.saved-sessions/save-dialog): Push or Not Now.
    if (needsPublicOk()) {
      setStage("public");
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      const res = await saveSession({
        path: props.path,
        prepareId: p.prepareId,
        title: title().trim(),
        ...(note().trim() ? { note: note().trim() } : {}),
        branches: branches(),
        scope: scope(),
        trimToolOutput: trim(),
        includeImages: images(),
        decisions: decisionsToSend(review(), decisions(), images()),
        push: push(),
        ...(push() && !p.push.publicWarningAccepted && acceptPublic() ? { acceptPublicWarning: true } : {}),
        ...(onConflict ? { onConflict } : {}),
      });
      if (!res.ok) {
        if (res.reason === "conflict" && res.theirs) {
          setStage({ conflict: res.theirs });
          return;
        }
        setStage("form");
        setSaveError(`Couldn't save this session. Nothing was written. ${res.message}`);
        if (res.reason === "expired") {
          // The cleaned copy is gone: clean again, and the review starts over.
          setDecisions({});
          await load();
        }
        return;
      }
      const named = `${res.card.title} (${revWord(res.card.rev)})`;
      const line = res.pushed
        ? `Saved ${named} and pushed it to ${p.push.remote?.name ?? "the remote"}.`
        : res.pushError
          ? `Saved ${named} here. The push failed: ${res.pushError}`
          : `Saved ${named}.`;
      toast(line);
      announce(line);
      props.onSaved?.();
      props.onClose();
    } catch (err) {
      setStage("form");
      setSaveError(`Couldn't save this session. Nothing was written. ${errText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    if (stage() !== "form") setStage("form");
    else props.onClose();
  };

  // Each stage replaces the dialog's content, and focus inside the old content falls to the page
  // (Escape and the focus trap then miss the dialog). After every change of what shows, focus that
  // went missing comes back to the stage's first field or button.
  let root: HTMLDivElement | undefined;
  createEffect(
    on([prep, stage, loadError], () =>
      queueMicrotask(() => {
        if (!root?.isConnected || root.contains(document.activeElement)) return;
        const first = root.querySelector<HTMLElement>(".modal-body input:not([disabled]), .modal-body textarea, .modal-body button:not([disabled]), .modal-foot button:not([disabled])");
        (first ?? root).focus();
      }),
    ),
  );

  const conflict = () => {
    const st = stage();
    return typeof st === "object" ? st.conflict : null;
  };

  const heading = () => {
    const st = stage();
    if (st === "review") return "Check before saving";
    if (st === "public") return `Push to ${prep()?.push.remote?.name ?? "the remote"}?`;
    if (typeof st === "object") return `${savedByName(st.conflict.savedBy)} saved a newer version`;
    return "Save Session";
  };

  return (
    <Portal>
      <div class="scrim" onClick={() => !busy() && props.onClose()} />
      <div class="modal modal-wide save-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={(el) => {
          root = el;
          trapFocus(el);
        }}
        onKeyDown={onKeyDown}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={titleId}>
            {heading()}
          </h2>
        </div>
        <Switch>
          <Match when={loadError()}>
            {(msg) => (
              <>
                <div class="modal-body">
                  <Banner tone="error" title="Couldn't save this session. Nothing was written." body={msg()} />
                </div>
                <div class="modal-foot">
                  <span class="modal-spacer" />
                  <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
                    Cancel
                  </button>
                  <button type="button" class="button" onClick={() => void load()}>
                    Try Again
                  </button>
                </div>
              </>
            )}
          </Match>
          <Match when={!prep()}>
            <div class="modal-body">
              <p class="usage-note" role="status">
                Cleaning a copy of this conversation…
              </p>
            </div>
            <div class="modal-foot">
              <span class="modal-spacer" />
              <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
                Cancel
              </button>
            </div>
          </Match>
          <Match when={conflict()}>
            {(theirs) => (
              <>
                <div class="modal-body">
                  <p>
                    {savedByName(theirs().savedBy)} saved {revWord(theirs().rev)} {relativeTime(theirs().savedAt, Date.now())}. Save yours as a new copy, or
                    replace theirs?
                  </p>
                  <Show when={saveError()}>{(m) => <p class="field-error">{m()}</p>}</Show>
                </div>
                <div class="modal-foot save-foot save-foot-choice">
                  <button type="button" class="button button-ghost" disabled={busy()} onClick={() => setStage("form")}>
                    Cancel
                  </button>
                  <span class="modal-spacer" />
                  <button type="button" class="button button-destructive" disabled={busy()} onClick={() => void save("replace")}>
                    Replace Theirs
                  </button>
                  <button type="button" class="button button-primary" disabled={busy()} onClick={() => void save("new-copy")}>
                    Save as New Copy
                  </button>
                </div>
              </>
            )}
          </Match>
          <Match when={stage() === "public" && prep()?.push.remote}>
            {(remote) => (
              <>
                <div class="modal-body">
                  <p>
                    If this repository is public, anyone can read this conversation, including what it read from files. Sova removed the secrets it knows;
                    it can't judge the rest.
                  </p>
                  <p class="text-caption">
                    <code>{remote().url}</code>
                  </p>
                </div>
                <div class="modal-foot save-foot">
                  <span class="modal-spacer" />
                  <button
                    type="button"
                    class="button button-ghost"
                    onClick={() => {
                      setPush(false);
                      setStage("form");
                    }}
                  >
                    Not Now
                  </button>
                  <button
                    type="button"
                    class="button button-primary"
                    onClick={() => {
                      setAcceptPublic(true);
                      setStage("form");
                    }}
                  >
                    Push
                  </button>
                </div>
              </>
            )}
          </Match>
          <Match when={stage() === "review"}>
            <ReviewStage
              path={props.path}
              prepareId={prep()!.prepareId}
              review={review()}
              includeImages={images()}
              decisions={decisions()}
              onDecide={decide}
              onDecideAll={decideAll}
              onDone={() => setStage("form")}
            />
          </Match>
          <Match when={prep()}>
            {(p) => (
              <>
                <form
                  class="modal-body save-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                  id={`${titleId}-form`}
                >
                  <p class="text-caption">
                    Saved to this repository's <code>{SAVED_SESSIONS_BRANCH}</code> branch, which is never merged into main.
                  </p>
                  <label class="field">
                    <span class="field-label">Title</span>
                    <input class="input" value={title()} maxLength={200} onInput={(e) => setTitle(e.currentTarget.value)} />
                  </label>
                  <label class="field">
                    <span class="field-label">Note for whoever opens it</span>
                    <textarea class="input textarea" rows={3} value={note()} aria-describedby={`${titleId}-note-hint`} onInput={(e) => setNote(e.currentTarget.value)} />
                    <span class="field-hint" id={`${titleId}-note-hint`}>
                      Optional. Shown before they continue.
                    </span>
                  </label>
                  <BranchesField branches={branches()} known={p().knownBranches} onChange={setBranches} />
                  <fieldset class="save-group">
                    <legend class="field-label">How much history</legend>
                    <label class="toggle saved-choice">
                      <input type="radio" name={`${titleId}-scope`} checked={scope() === "whole"} onChange={() => setScope("whole")} />
                      <span class="toggle-box" aria-hidden="true" />
                      <span class="saved-choice-main">
                        <span class="saved-choice-name">Whole conversation</span>
                        <span class="saved-choice-meta">{bytes(withoutImages(sizeFor(p().sizes, "whole", trim()), p().review, images())!)}</span>
                      </span>
                    </label>
                    <Show when={p().sizes.sinceSummary !== null}>
                      <label class="toggle saved-choice">
                        <input type="radio" name={`${titleId}-scope`} checked={scope() === "since-summary"} onChange={() => setScope("since-summary")} />
                        <span class="toggle-box" aria-hidden="true" />
                        <span class="saved-choice-main">
                          <span class="saved-choice-name">Only what the agent sees now (since its last summary)</span>
                          <span class="saved-choice-meta">{bytes(withoutImages(sizeFor(p().sizes, "since-summary", trim()), p().review, images())!)}</span>
                        </span>
                      </label>
                    </Show>
                    <label class="toggle saved-choice">
                      <input type="checkbox" checked={trim()} onChange={(e) => setTrim(e.currentTarget.checked)} />
                      <span class="toggle-box" aria-hidden="true" />
                      <span class="saved-choice-main">
                        <span class="saved-choice-name">Trim long tool output</span>
                      </span>
                    </label>
                  </fieldset>
                  <label class="toggle saved-choice">
                    <input type="checkbox" checked={images()} onChange={(e) => setImages(e.currentTarget.checked)} />
                    <span class="toggle-box" aria-hidden="true" />
                    <span class="saved-choice-main">
                      <span class="saved-choice-name">Include images</span>
                    </span>
                  </label>
                  <section class="save-group" aria-labelledby={`${titleId}-clean`}>
                    <h3 class="field-label" id={`${titleId}-clean`}>
                      Cleaning
                    </h3>
                    <Show when={cleaningLine(p().cleaning)}>{(line) => <p class="text-caption">{line()}</p>}</Show>
                    <div class="save-review-line">
                      <span class={left().length ? "save-review-state save-review-state-open" : "save-review-state"}>
                        <span class="chip-dot" aria-hidden="true" />
                        {reviewLine(review(), decisions(), images())}
                      </span>
                      <Show when={review().some((r) => r.kind === "possible-secret" || images())}>
                        <button type="button" class="button button-sm" onClick={() => setStage("review")}>
                          Review
                        </button>
                      </Show>
                    </div>
                  </section>
                  <Show when={size()}>
                    {(n) => (
                      <Show when={sizeNote(n())} fallback={<p class="text-caption">{sizeLine(n())}</p>}>
                        {(warn) => <Banner tone={sizeState(n()) === "over" ? "error" : "warn"} title={sizeLine(n())} body={warn()} />}
                      </Show>
                    )}
                  </Show>
                  <label class="toggle saved-choice">
                    <input
                      type="checkbox"
                      checked={push()}
                      disabled={!p().push.remote}
                      onChange={(e) => {
                        setPush(e.currentTarget.checked);
                        // The first time Push is turned on for a remote, it asks (§chat.saved-sessions/save-dialog).
                        if (needsPublicOk()) setStage("public");
                      }}
                    />
                    <span class="toggle-box" aria-hidden="true" />
                    <span class="saved-choice-main">
                      <span class="saved-choice-name">Push so colleagues get it</span>
                      <span class="saved-choice-meta">
                        <Show when={p().push.remote} fallback="This repository has no remote.">
                          {(r) => (
                            <>
                              Sends it to <code>{r().name}</code>.
                            </>
                          )}
                        </Show>
                      </span>
                    </span>
                  </label>
                  <Show when={saveError()}>{(m) => <p class="field-error" role="alert">{m()}</p>}</Show>
                </form>
                <div class="modal-foot save-foot">
                  <Show when={!busy() && blocked()}>
                    {(why) => <p class="text-caption save-why">{why()}</p>}
                  </Show>
                  <span class="modal-spacer" />
                  <button type="button" class="button button-ghost" disabled={busy()} onClick={() => props.onClose()}>
                    Cancel
                  </button>
                  <button type="submit" form={`${titleId}-form`} class="button button-primary" disabled={!!blocked()} title={blocked() ?? undefined} aria-busy={busy()}>
                    {busy() ? (push() ? "Saving and Pushing…" : "Saving…") : "Save"}
                  </button>
                </div>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </Portal>
  );
}

/** The branches it belongs to: removable chips and a picker of the repository's local branches. */
function BranchesField(props: { branches: string[]; known: string[]; onChange(next: string[]): void }) {
  const id = `save-branches-${Math.random().toString(36).slice(2, 8)}`;
  const addable = createMemo(() => props.known.filter((b) => !props.branches.includes(b)));
  return (
    <div class="field">
      <span class="field-label" id={id}>
        Branches it belongs to
      </span>
      <ul class="save-branches" aria-labelledby={id}>
        <For each={props.branches}>
          {(b) => (
            <li class="save-branch">
              <code>{b}</code>
              <button type="button" class="button button-icon button-ghost button-sm" aria-label={`Remove ${b}`} onClick={() => props.onChange(props.branches.filter((x) => x !== b))}>
                <Icon name="close" small />
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={addable().length > 0}>
        <span class="select-wrap">
        <select
          class="select"
          aria-label="Add a branch"
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v) props.onChange([...props.branches, v]);
            e.currentTarget.value = "";
          }}
        >
          <option value="">Add a branch…</option>
          <For each={addable()}>{(b) => <option value={b}>{b}</option>}</For>
        </select>
          <span class="select-caret" aria-hidden="true">
            <Icon name="chevron-down" small />
          </span>
        </span>
      </Show>
      <Show when={props.branches.length === 0}>
        <p class="field-error">Pick at least 1 branch.</p>
      </Show>
    </div>
  );
}

/** The review step: each possible secret and each image, Keep or Remove. */
function ReviewStage(props: {
  path: string;
  prepareId: string;
  review: SaveReviewItem[];
  includeImages: boolean;
  decisions: Record<string, Decision>;
  onDecide(id: string, d: Decision): void;
  onDecideAll(d: Decision): void;
  onDone(): void;
}) {
  const shown = () => props.review.filter((r) => r.kind === "possible-secret" || props.includeImages);
  return (
    <>
      <div class="modal-body">
        <p class="text-caption">
          Sova removed every secret it knows. These might be secrets too, and it can't read text in images. Keep or remove each one.
        </p>
        <ul class="list save-review">
          <For each={shown()}>
            {(r) => (
              <li class="list-row save-review-row">
                <div class="list-main">
                  <Show
                    when={r.kind === "image"}
                    fallback={
                      <p class="save-excerpt">
                        <For each={excerptParts(r.excerpt)}>{(part) => (part.match ? <mark>{part.text}</mark> : <>{part.text}</>)}</For>
                      </p>
                    }
                  >
                    <img class="save-thumb" src={savePreparedImageUrl(props.prepareId, r.id, props.path)} alt={`Image from ${r.where}`} loading="lazy" />
                  </Show>
                  <p class="list-meta">{r.kind === "image" ? `${r.where} · ${bytes(r.bytes)}` : [r.where, r.why].filter(Boolean).join(" · ")}</p>
                </div>
                <div class="save-decide" role="group" aria-label={`${r.kind === "image" ? "Image" : "Possible secret"} from ${r.where}`}>
                  <button type="button" class="button button-sm" aria-pressed={props.decisions[r.id] === "keep"} onClick={() => props.onDecide(r.id, "keep")}>
                    <Show when={props.decisions[r.id] === "keep"}>
                      <Icon name="check" small />
                    </Show>
                    Keep
                  </button>
                  <button type="button" class="button button-sm" aria-pressed={props.decisions[r.id] === "remove"} onClick={() => props.onDecide(r.id, "remove")}>
                    <Show when={props.decisions[r.id] === "remove"}>
                      <Icon name="check" small />
                    </Show>
                    Remove
                  </button>
                </div>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="modal-foot save-foot">
        <button type="button" class="button button-ghost" onClick={() => props.onDecideAll("remove")}>
          Remove All
        </button>
        <button type="button" class="button button-ghost" onClick={() => props.onDecideAll("keep")}>
          Keep All
        </button>
        <span class="modal-spacer" />
        <button type="button" class="button button-primary" onClick={() => props.onDone()}>
          Done
        </button>
      </div>
    </>
  );
}
