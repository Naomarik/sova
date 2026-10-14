import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type {
  ContinuationDetails,
  ContinueModel,
  SavedListResponse,
  SavedOnMainResponse,
  SavedPreviewResponse,
  SavedSessionRow,
  WorktreeOfferItem,
} from "../../shared/session-bundle";
import {
  continueSavedSession,
  fetchSavedSessions,
  listSavedSessions,
  previewSavedSession,
  pruneSavedSessions,
  purgeSavedFromMain,
  removeSavedFromMain,
  savedOnMain,
  setUpSavedWorktrees,
} from "../lib/api";
import { relativeTime, tildePath } from "../lib/format";
import { badgeWord, cardLine, filterRows, modelLine, revWord, savedByName, savedMetaLine, shortDate, wontFitLine, workerLine } from "../lib/saved-sessions";
import { absoluteTime } from "../lib/spend";
import { announce, home, toast } from "../lib/ui-state";
import { Banner, Icon, trapFocus } from "./ui";
import "../saved-sessions.css";

const errText = (x: unknown) => (x instanceof Error ? x.message : String(x));
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** What a Continue leaves to do once the blank screen is gone: the worktree offer and the model notice.
    Module state, because the section unmounts the moment the continued conversation lands. */
interface ContinueOffer {
  path: string;
  title: string;
  folderBranch: string | null;
  remote: string | null;
  items: WorktreeOfferItem[];
  model: ContinueModel;
  savedModel?: { provider: string; id: string };
}
const [offer, setOffer] = createSignal<ContinueOffer | null>(null);

/** The Keep answers to the prune offer, per repository folder and branch, kept in this browser. */
const KEPT_KEY = "sova.saved-sessions.kept";
const keptSet = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEPT_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};
const keep = (key: string) => {
  const s = keptSet();
  s.add(key);
  try {
    localStorage.setItem(KEPT_KEY, JSON.stringify([...s]));
  } catch {
    // A private window: the offer comes back next time.
  }
};

/**
 * The new-session screen's Saved sessions card (§chat.saved-sessions/discovery): one quiet row under the
 * setup card with a count line, opening the Saved sessions window: every saved session of the folder's
 * repository, newest first, with a branch filter, Preview and Continue, and Get Saved Sessions. The
 * window also hosts the on-main alert (§chat.saved-sessions/on-main, flagged on the card by an "In main"
 * chip) and the prune offer (§chat.saved-sessions/prune, counted on the card). It reads on its own and
 * never holds the setup card back; with nothing to say, it draws nothing.
 */
export function SavedSessionsSection(props: { path: string; cwd: string }) {
  const [list, setList] = createSignal<SavedListResponse | null>(null);
  const [listError, setListError] = createSignal<string | null>(null);
  const [onMain, setOnMain] = createSignal<SavedOnMainResponse | null>(null);
  const [branch, setBranch] = createSignal<string | null>(null);
  const [getting, setGetting] = createSignal(false);
  const [getLine, setGetLine] = createSignal<{ text: string; error: boolean } | null>(null);
  const [previewing, setPreviewing] = createSignal<SavedSessionRow | null>(null);
  const [continuing, setContinuing] = createSignal<string | null>(null);
  const [kept, setKept] = createSignal(keptSet());
  /** Versions previewed here since the list was read: their badge goes. Kept beside the rows, not
      written into them, so the rows (and the focus on a row's Preview) survive a preview. */
  const [seen, setSeen] = createSignal<ReadonlySet<string>>(new Set());
  const seenKey = (r: SavedSessionRow) => `${r.bundleId}@${r.rev}`;
  const badgeOf = (r: SavedSessionRow) => (seen().has(seenKey(r)) ? null : r.badge);
  /** The prune offer waiting on its confirm: the branch and the saved sessions that would go. */
  const [pruning, setPruning] = createSignal<{ branch: string; rows: SavedSessionRow[] } | null>(null);
  const [pruneBusy, setPruneBusy] = createSignal(false);
  /** The Saved sessions window, opened from the card. */
  const [open, setOpen] = createSignal(false);

  const remote = () => list()?.remote ?? "the remote";

  const read = (cwd: string) => {
    listSavedSessions(cwd, props.path).then(
      (res) => {
        if (props.cwd !== cwd) return;
        setList(res);
        setListError(null);
        if (res.repo) savedOnMain(cwd, props.path).then((m) => props.cwd === cwd && setOnMain(m), () => undefined);
      },
      (err) => props.cwd === cwd && setListError(errText(err)),
    );
  };
  createEffect(
    on(
      () => props.cwd,
      (cwd) => {
        setList(null);
        setOnMain(null);
        setOpen(false);
        setBranch(null);
        setGetLine(null);
        read(cwd);
      },
    ),
  );

  const rows = createMemo(() => filterRows(list()?.sessions ?? [], branch()));

  const get = async () => {
    if (getting()) return;
    const cwd = props.cwd;
    const before = new Map((list()?.sessions ?? []).map((r) => [r.bundleId, r.rev]));
    setGetting(true);
    setGetLine(null);
    try {
      const res = await fetchSavedSessions(cwd, props.path);
      if (props.cwd !== cwd) return;
      if (!res.ok) {
        const r = remote();
        const text =
          res.reason === "offline"
            ? `Couldn't reach ${r}. Check the connection and try again.`
            : res.reason === "auth"
              ? `${r} refused the fetch. Check your git credentials.`
              : res.reason === "no-saved-branch"
                ? `${r} has no saved sessions yet.`
                : `Couldn't get saved sessions. ${res.message}`;
        setGetLine({ text, error: res.reason !== "no-saved-branch" });
        announce(text);
        return;
      }
      const { ok: _ok, ...next } = res;
      setList(next);
      const fresh = next.sessions.filter((s) => before.get(s.bundleId) !== s.rev).length;
      if (!fresh) {
        const text = `No new saved sessions on ${next.remote ?? "the remote"}.`;
        setGetLine({ text, error: false });
        announce(text);
      } else announce(`${plural(fresh, "new or updated saved session")}.`);
    } catch (err) {
      const text = `Couldn't get saved sessions. ${errText(err)}`;
      setGetLine({ text, error: true });
      announce(text);
    } finally {
      setGetting(false);
    }
  };

  const doContinue = async (row: SavedSessionRow, savedModel?: { provider: string; id: string }) => {
    if (continuing()) return;
    setContinuing(row.bundleId);
    try {
      const res = await continueSavedSession({ path: props.path, cwd: props.cwd, bundleId: row.bundleId, rev: row.rev });
      if (!res.ok) {
        toast(res.reason === "not-blank" ? "This session already has messages. Start a new session to continue a saved one." : `Couldn't continue this saved session. Nothing changed. ${res.message}`);
        return;
      }
      setPreviewing(null);
      setOpen(false);
      announce(`Continued ${row.title}.`);
      const items = res.worktreeOffer.filter((i) => i.where === "local" || i.where === "remote");
      if (items.length) {
        setOffer({ path: props.path, title: row.title, folderBranch: list()?.folderBranch ?? null, remote: remote(), items: res.worktreeOffer, model: res.model, savedModel });
      } else if (!res.model.saved) toast(modelLine(res.model, savedModel));
    } catch (err) {
      toast(`Couldn't continue this saved session. Nothing changed. ${errText(err)}`);
    } finally {
      setContinuing(null);
    }
  };

  const pruneOffers = createMemo(() => {
    const l = list();
    if (!l) return [];
    return l.mergedBranches
      .map((b) => {
        const rows = l.sessions.filter((s) => s.branches.includes(b));
        return { branch: b, n: rows.length, rows };
      })
      .filter((o) => o.n > 0 && !kept().has(`${props.cwd}\n${o.branch}`));
  });

  const prune = async (b: string, n: number) => {
    setPruneBusy(true);
    try {
      const res = await pruneSavedSessions(props.cwd, b, props.path);
      if (!res.ok) {
        toast(`Couldn't delete the saved sessions of ${b}. Nothing changed. ${res.message}`);
        return;
      }
      const text = `Deleted ${plural(res.removed || n, "saved session")} of ${b}.`;
      toast(text);
      announce(text);
      read(props.cwd);
    } catch (err) {
      toast(`Couldn't delete the saved sessions of ${b}. Nothing changed. ${errText(err)}`);
    } finally {
      setPruneBusy(false);
      setPruning(null);
    }
  };

  const hasRows = () => (list()?.sessions.length ?? 0) > 0;
  const onMainCount = () => onMain()?.found.length ?? 0;
  const mainName = () => onMain()?.mainBranch ?? "main";
  const line = () => (listError() ? cardLine(null) : cardLine((list()?.sessions ?? []).map((r) => ({ ...r, badge: badgeOf(r) })), pruneOffers().length));
  const windowId = `saved-window-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <Show when={listError() || (list()?.repo && (hasRows() || list()?.hasRemote || onMainCount() > 0 || pruneOffers().length > 0))}>
      <button
        type="button"
        class="saved-card"
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-label={`Saved sessions, ${line()}${onMainCount() ? `, in ${mainName()}` : ""}`}
        onClick={() => setOpen(true)}
      >
        <span class="saved-card-text">
          <span class="saved-card-title">Saved sessions</span>
          <span class={listError() ? "saved-card-line saved-status-error" : "saved-card-line"}>{line()}</span>
        </span>
        <Show when={onMainCount() > 0}>
          <span class="chip chip-error">
            <span class="chip-dot" aria-hidden="true" />
            In {mainName()}
          </span>
        </Show>
        <Icon name="chevron-right" small class="saved-card-chevron" />
      </button>
      <Show when={open()}>
        <Portal>
          <div class="scrim" onClick={() => setOpen(false)} />
          <div
            class="modal modal-wide saved-window"
            role="dialog"
            aria-modal="true"
            aria-labelledby={windowId}
            ref={(el) => trapFocus(el)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || e.defaultPrevented) return;
              e.preventDefault();
              setOpen(false);
            }}
          >
            <div class="sheet-grip" aria-hidden="true" />
            <div class="modal-head">
              <h2 class="modal-title" id={windowId}>
                Saved sessions
              </h2>
            </div>
            <div class="modal-body saved-window-body">
              <Show when={onMainCount() > 0 && onMain()}>{(m) => <OnMainAlert cwd={props.cwd} path={props.path} info={m()} onChanged={() => read(props.cwd)} />}</Show>
              <For each={pruneOffers()}>
                {(o) => (
                  <Banner
                    tone="info"
                    title={`${o.branch} is merged. Its ${plural(o.n, "saved session")} ${o.n === 1 ? "is" : "are"} still kept.`}
                    action={
                      <div class="cluster">
                        <button type="button" class="button button-sm button-destructive" onClick={() => setPruning({ branch: o.branch, rows: o.rows })}>
                          Delete Them
                        </button>
                        <button
                          type="button"
                          class="button button-sm"
                          onClick={() => {
                            keep(`${props.cwd}\n${o.branch}`);
                            setKept(keptSet());
                          }}
                        >
                          Keep
                        </button>
                      </div>
                    }
                  />
                )}
              </For>
              <Show when={listError()}>{(msg) => <p class="saved-status saved-status-error">Couldn't read saved sessions. {msg()}</p>}</Show>
              <Show
                when={hasRows()}
                fallback={
                  <Show when={list()}>
                    <div class="saved-window-empty">
                      <p class="saved-status">
                        {list()!.hasRemote ? `Nothing saved on this computer yet. Get Saved Sessions checks ${remote()}.` : "Nothing saved on this computer yet."}
                      </p>
                      <Show when={list()!.hasRemote}>
                        <GetButton getting={getting()} remote={remote()} onGet={() => void get()} />
                      </Show>
                    </div>
                    <Show when={getLine()}>{(l) => <p class={l().error ? "saved-status saved-status-error" : "saved-status"}>{l().text}</p>}</Show>
                  </Show>
                }
              >
                <div class="saved-section-head">
                  <p class="saved-status saved-lede">Continue one with its whole conversation, or start fresh in this session.</p>
                  <div class="saved-section-tools">
                    <Show when={list()!.branches.length > 1}>
                      <label class="saved-filter">
                        <span class="text-caption">Branch</span>
                        <span class="select-wrap">
                          <select class="select" value={branch() ?? ""} onChange={(e) => setBranch(e.currentTarget.value || null)}>
                            <option value="">All branches</option>
                            <For each={list()!.branches}>{(b) => <option value={b}>{b}</option>}</For>
                          </select>
                          <span class="select-caret" aria-hidden="true">
                            <Icon name="chevron-down" small />
                          </span>
                        </span>
                      </label>
                    </Show>
                    <Show when={list()!.hasRemote}>
                      <GetButton getting={getting()} remote={remote()} onGet={() => void get()} />
                    </Show>
                  </div>
                </div>
                <Show when={getLine()}>{(l) => <p class={l().error ? "saved-status saved-status-error" : "saved-status"}>{l().text}</p>}</Show>
                <Show when={rows().length} fallback={<p class="saved-status">No saved sessions on {branch()}.</p>}>
                  <ul class="list saved-rows">
                    <For each={rows()}>
                      {(r) => (
                        <li class="list-row saved-srow">
                          <div class="list-main">
                            <p class="list-title">
                              <span>{r.title || r.bundleId}</span>
                              <Show when={badgeWord(badgeOf(r))}>
                                {(w) => (
                                  <span class={badgeOf(r) === "new" ? "chip chip-accent" : "chip chip-info"}>
                                    <span class="chip-dot" aria-hidden="true" />
                                    {w()}
                                  </span>
                                )}
                              </Show>
                            </p>
                            <Show when={savedMetaLine(r, r.savedAt ? relativeTime(r.savedAt, Date.now()) : "")}>
                              {(ml) => (
                                <p class="list-meta" title={r.savedAt ? absoluteTime(r.savedAt, Date.now()) : undefined}>
                                  {ml()}
                                </p>
                              )}
                            </Show>
                            <Show when={r.unreadable}>{(why) => <p class="list-meta saved-status-error">Can't be read: {why()}</p>}</Show>
                          </div>
                          <Show when={!r.unreadable}>
                            <div class="saved-srow-actions">
                              <button type="button" class="button button-sm" aria-label={`Preview ${r.title}`} onClick={() => setPreviewing(r)}>
                                Preview
                              </button>
                              <button
                                type="button"
                                class="button button-sm button-primary"
                                aria-label={`Continue ${r.title}`}
                                disabled={!!continuing()}
                                aria-busy={continuing() === r.bundleId}
                                onClick={() => void doContinue(r)}
                              >
                                {continuing() === r.bundleId ? "Continuing…" : "Continue"}
                              </button>
                            </div>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Show>
            </div>
            <div class="modal-foot">
              <span class="modal-spacer" />
              <button type="button" class="button button-ghost" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </Portal>
      </Show>
      <Show when={pruning()}>
        {(pr) => (
          <PruneConfirm
            branch={pr().branch}
            rows={pr().rows}
            remote={list()?.pushOnSave ? (list()?.remote ?? null) : null}
            busy={pruneBusy()}
            onCancel={() => setPruning(null)}
            onConfirm={() => void prune(pr().branch, pr().rows.length)}
          />
        )}
      </Show>
      <Show when={previewing()}>
        {(row) => (
          <PreviewDialog
            cwd={props.cwd}
            path={props.path}
            row={row()}
            continuing={continuing() === row().bundleId}
            onClose={() => setPreviewing(null)}
            onContinue={(savedModel) => void doContinue(row(), savedModel)}
            onSeen={() => setSeen((prev) => new Set(prev).add(seenKey(row())))}
          />
        )}
      </Show>
    </Show>
  );
}

function GetButton(props: { getting: boolean; remote: string; onGet(): void }) {
  return (
    <button
      type="button"
      class="button button-sm"
      aria-busy={props.getting}
      disabled={props.getting}
      title={`Fetches only the saved-sessions branch from ${props.remote}. Nothing else changes.`}
      onClick={() => props.onGet()}
    >
      <Icon name="refresh" small />
      {props.getting ? "Getting…" : "Get Saved Sessions"}
    </button>
  );
}

/** Preview (§chat.saved-sessions/preview): read only; it marks the version seen. */
function PreviewDialog(props: {
  cwd: string;
  path: string;
  row: SavedSessionRow;
  continuing: boolean;
  onClose(): void;
  onContinue(savedModel?: { provider: string; id: string }): void;
  onSeen(): void;
}) {
  const titleId = `saved-preview-${Math.random().toString(36).slice(2, 8)}`;
  const [data, setData] = createSignal<SavedPreviewResponse | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  previewSavedSession(props.cwd, props.row.bundleId, props.path).then(
    (d) => {
      setData(d);
      props.onSeen();
    },
    (err) => setError(errText(err)),
  );
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal modal-wide saved-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={titleId}>
            {props.row.title}
          </h2>
        </div>
        <div class="modal-body" tabindex="0">
          <Show when={error()}>{(m) => <Banner tone="error" title="Couldn't read this saved session." body={m()} />}</Show>
          <Show when={!data() && !error()}>
            <p class="saved-status" role="status">
              Reading the saved session…
            </p>
          </Show>
          <Show when={data()}>
            {(d) => (
              <>
                <div class="saved-preview-facts">
                  <p>
                    Saved by {savedByName(d().card.savedBy)} {shortDate(d().card.savedAt)} · {revWord(d().card.rev)} · {d().card.branches.join(", ")}
                  </p>
                  <Show when={d().card.model}>{(m) => <p>Model: {m().id}</p>}</Show>
                  <p>{modelLine(d().model, d().card.model)}</p>
                </div>
                <Show when={d().wontFit}>
                  <Banner tone="warn" title={wontFitLine(d().model.id)} />
                </Show>
                <Show when={d().card.note}>
                  {(n) => (
                    <section class="stack-2" aria-labelledby={`${titleId}-note`}>
                      <h3 class="field-label" id={`${titleId}-note`}>
                        Note
                      </h3>
                      <p class="saved-preview-note">{n()}</p>
                    </section>
                  )}
                </Show>
                <Show when={d().lastMessages.length}>
                  <section class="stack-2" aria-labelledby={`${titleId}-last`}>
                    <h3 class="field-label" id={`${titleId}-last`}>
                      Last messages
                    </h3>
                    <ol class="saved-messages">
                      <For each={d().lastMessages}>
                        {(m) => (
                          <li class={m.role === "user" ? "saved-message saved-message-user" : "saved-message"}>
                            <p class="saved-message-who">{m.role === "user" ? "You" : "Agent"}</p>
                            <p class="saved-message-text">{m.text}</p>
                          </li>
                        )}
                      </For>
                    </ol>
                  </section>
                </Show>
                <Show when={d().card.workers.length}>
                  <section class="stack-2" aria-labelledby={`${titleId}-workers`}>
                    <h3 class="field-label" id={`${titleId}-workers`}>
                      Teams and subagents
                    </h3>
                    <ul class="saved-workers">
                      <For each={d().card.workers}>
                        {(w) => (
                          <li class="saved-worker">
                            <p class="saved-worker-head">{workerLine(w)}</p>
                            <p class="saved-worker-body">{w.task}</p>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </Show>
                <Banner tone="info" icon="shield" title="Continue only sessions from people you trust. The agent takes what this conversation says as true." />
              </>
            )}
          </Show>
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
            Close
          </button>
          <button
            type="button"
            class="button button-primary"
            disabled={!data() || props.continuing}
            aria-busy={props.continuing}
            onClick={() => props.onContinue(data()?.card.model)}
          >
            {props.continuing ? "Continuing…" : "Continue"}
          </button>
        </div>
      </div>
    </Portal>
  );
}

/**
 * The worktree offer after a Continue (§chat.saved-sessions/continue): mounted by the chat view
 * outside its blank screen, which is gone by the time this shows.
 */
export function ContinueOfferHost(props: { path: string }) {
  return (
    <Show when={offer()?.path === props.path && offer()}>
      {(o) => <WorktreeOffer offer={o()} onClose={() => setOffer(null)} />}
    </Show>
  );
}

function WorktreeOffer(props: { offer: ContinueOffer; onClose(): void }) {
  const titleId = `saved-offer-${Math.random().toString(36).slice(2, 8)}`;
  const actionable = (i: WorktreeOfferItem) => (i.where === "local" || i.where === "remote") && !i.existingPath;
  const [picked, setPicked] = createSignal(new Set(props.offer.items.filter(actionable).map((i) => i.branch)));
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal<{ branch: string; message: string }[]>([]);
  const where = (i: WorktreeOfferItem) =>
    i.existingPath
      ? `already at ${tildePath(i.existingPath, home())}`
      : i.where === "local"
        ? "a local branch"
        : i.where === "remote"
          ? `from ${props.offer.remote ?? i.remoteRef ?? "the remote"}`
          : "not here";
  const setUp = async () => {
    const branches = [...picked()];
    if (!branches.length || busy()) return;
    setBusy(true);
    try {
      const res = await setUpSavedWorktrees({ path: props.offer.path, branches });
      setFailed(res.failed);
      if (res.created.length) {
        const text = `Set up ${plural(res.created.length, "worktree")}. The agent knows where they are.`;
        toast(text);
        announce(text);
      }
      if (!res.failed.length) props.onClose();
    } catch (err) {
      setFailed(branches.map((b) => ({ branch: b, message: errText(err) })));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Portal>
      <div class="scrim" onClick={() => !busy() && props.onClose()} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={titleId}>
            Set up its branches?
          </h2>
        </div>
        <div class="modal-body">
          <Show when={!props.offer.model.saved}>
            <p class="text-caption">{modelLine(props.offer.model, props.offer.savedModel)}</p>
          </Show>
          <p>
            It worked on these branches. Set up a worktree for each one you want; your folder stays on{" "}
            {props.offer.folderBranch ? <code>{props.offer.folderBranch}</code> : "its branch"}.
          </p>
          <div class="save-group" role="group" aria-label="Branches">
            <For each={props.offer.items.filter((i) => i.where !== "here")}>
              {(i) => (
                <label class="toggle saved-choice">
                  <input
                    type="checkbox"
                    checked={picked().has(i.branch)}
                    disabled={!actionable(i) || busy()}
                    onChange={(e) => {
                      const next = new Set(picked());
                      if (e.currentTarget.checked) next.add(i.branch);
                      else next.delete(i.branch);
                      setPicked(next);
                    }}
                  />
                  <span class="toggle-box" aria-hidden="true" />
                  <span class="saved-choice-main">
                    <code class="saved-choice-name">{i.branch}</code>
                    <span class="saved-choice-meta">{where(i)}</span>
                  </span>
                </label>
              )}
            </For>
          </div>
          <For each={failed()}>
            {(f) => (
              <p class="field-error">
                {f.branch}: {f.message}
              </p>
            )}
          </For>
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" disabled={busy()} onClick={() => props.onClose()}>
            Skip
          </button>
          <button type="button" class="button button-primary" disabled={busy() || picked().size === 0} aria-busy={busy()} onClick={() => void setUp()}>
            {busy() ? "Setting Up…" : "Set Up Worktrees"}
          </button>
        </div>
      </div>
    </Portal>
  );
}

/** Saved sessions found on main (§chat.saved-sessions/on-main): Remove from Main, Purge from History
    while main is unpushed, else the checklist. */
function OnMainAlert(props: { cwd: string; path: string; info: SavedOnMainResponse; onChanged(): void }) {
  const main = () => props.info.mainBranch ?? "main";
  const [busy, setBusy] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [checklist, setChecklist] = createSignal(false);
  const dirs = () => props.info.found.map((f) => f.dir);
  /** In main's tree now (Remove from Main applies), and only in its unpushed history (Purge only). */
  const inTree = () => props.info.found.filter((f) => !f.historyOnly);
  const inHistory = () => props.info.found.filter((f) => f.historyOnly);
  const titles = () => inTree().map((f) => f.title ?? f.dir).join(", ");
  const purge = () => props.info.purge;

  const remove = async () => {
    setBusy(true);
    try {
      const res = await removeSavedFromMain({ cwd: props.cwd, dirs: inTree().map((f) => f.dir) }, props.path);
      const text = res.ok ? `Removed them from ${main()} in one commit. They're still in its history: change any secret they held.` : res.message;
      toast(text);
      announce(text);
      if (res.ok) props.onChanged();
    } catch (err) {
      toast(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const doPurge = async () => {
    setBusy(true);
    try {
      const res = await purgeSavedFromMain({ cwd: props.cwd, dirs: dirs() }, props.path);
      const text = res.ok ? `Purged. The old head is kept as ${res.backupBranch}.` : res.message;
      toast(text);
      announce(text);
      setConfirming(false);
      if (res.ok) props.onChanged();
    } catch (err) {
      toast(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="banner banner-error saved-main" role="alert">
      <Icon name="alert-circle" class="banner-icon" />
      <div class="banner-main">
        <p class="banner-title">Saved sessions are in {main()}</p>
        <Show when={inTree().length}>
          <p class="banner-body">
            <Show
              when={props.info.purgeable}
              fallback={
                <>
                  {plural(inTree().length, "saved session")} {inTree().length === 1 ? "was" : "were"} committed to {main()}: {titles()}. Anyone who can read{" "}
                  {main()} can read them.
                </>
              }
            >
              {plural(inTree().length, "saved session")} {inTree().length === 1 ? "was" : "were"} committed to {main()}, not pushed yet: {titles()}.
            </Show>
          </p>
        </Show>
        <Show when={inHistory().length}>
          <ul class="saved-main-list banner-body">
            <For each={inHistory()}>
              {(f) => (
                <li>
                  {f.title ?? f.dir}: in {main()}'s unpushed history
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={checklist()}>
          <p class="banner-body">{main()} was pushed with them, so Sova won't rewrite it.</p>
          <ol class="saved-checklist">
            <li>Change every secret they held.</li>
            <li>Tell colleagues.</li>
            <li>If the team agrees, rewrite {main()} and force-push it by hand.</li>
            <li>Ask your code host to clear cached copies.</li>
          </ol>
        </Show>
        <div class="cluster">
          <Show when={inTree().length}>
            <button type="button" class="button button-sm button-destructive" disabled={busy()} onClick={() => void remove()}>
              Remove from Main
            </button>
          </Show>
          <Show
            when={props.info.purgeable}
            fallback={
              <button type="button" class="button button-sm" aria-expanded={checklist()} onClick={() => setChecklist(!checklist())}>
                Show Checklist
              </button>
            }
          >
            <button type="button" class="button button-sm button-destructive" disabled={busy()} onClick={() => setConfirming(true)}>
              Purge from History
            </button>
          </Show>
        </div>
      </div>
      <Show when={confirming()}>
        <Portal>
          <div class="scrim" onClick={() => !busy() && setConfirming(false)} />
          <div
            class="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="saved-purge-title"
            ref={(el) => trapFocus(el)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || e.defaultPrevented) return;
              e.preventDefault();
              setConfirming(false);
            }}
          >
            <div class="sheet-grip" aria-hidden="true" />
            <div class="modal-head">
              <h2 class="modal-title" id="saved-purge-title">
                Purge from History
              </h2>
            </div>
            <div class="modal-body">
              <p>
                Rewrite {purge() ? plural(purge()!.commits, "unpushed commit") : "the unpushed commits"} on {main()} without these folders? The old head stays as{" "}
                <code>{purge()?.backupBranch ?? "a backstop/saved-sessions branch"}</code>.
              </p>
              <ul class="saved-main-list">
                <For each={dirs()}>
                  {(d) => (
                    <li>
                      <code>{d}</code>
                    </li>
                  )}
                </For>
              </ul>
            </div>
            <div class="modal-foot">
              <span class="modal-spacer" />
              <button type="button" class="button button-ghost" disabled={busy()} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" class="button button-destructive" disabled={busy()} aria-busy={busy()} onClick={() => void doPurge()}>
                Purge
              </button>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

/** The note at the top of a continued conversation (§chat.saved-sessions/continuation-note). */
export function ContinuationCard(props: { details: ContinuationDetails }) {
  const d = () => props.details;
  const name = () => savedByName(d().savedBy);
  return (
    <section class="continued-card" aria-label="Continued from a saved session">
      <h3 class="text-heading-s">Continued from a saved session</h3>
      <p>
        {name()} saved this {shortDate(d().savedAt)} ({revWord(d().rev)}).{d().note ? ` ${d().note}` : ""}
      </p>
      <Show when={d().fromSummary}>
        <p class="text-caption">It was too big for {d().model.id}, so it starts from its last summary.</p>
      </Show>
      <Show when={!d().model.saved}>
        <p class="text-caption">{modelLine(d().model)}</p>
      </Show>
      <Show when={d().workers.length}>
        <p class="text-caption">
          Teams and subagents it mentions ran on {name()}'s computer and aren't here. You can't message or wait on them; start new ones if needed.
        </p>
        <details>
          <summary>Teams and subagents · {d().workers.length}</summary>
          <ul class="saved-workers">
            <For each={d().workers}>
              {(w) => (
                <li class="saved-worker">
                  <p class="saved-worker-head">{workerLine(w)}</p>
                  <p class="saved-worker-body">{w.task}</p>
                  <Show when={w.report}>{(r) => <p class="saved-worker-body">{r()}</p>}</Show>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </section>
  );
}

/** The prune offer's confirm (§chat.saved-sessions/prune): whose saved sessions go, and whether the
    deletion is pushed. */
function PruneConfirm(props: { branch: string; rows: SavedSessionRow[]; remote: string | null; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const titleId = `saved-prune-${Math.random().toString(36).slice(2, 8)}`;
  const n = () => props.rows.length;
  return (
    <Portal>
      <div class="scrim" onClick={() => !props.busy && props.onCancel()} />
      <div
        class="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          props.onCancel();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={titleId}>
            Delete {plural(n(), "saved session")} of {props.branch}?
          </h2>
        </div>
        <div class="modal-body">
          <p>
            {props.rows.map((r) => `${r.title} by ${savedByName(r.savedBy)}`).join(", ")}.{" "}
            {props.remote ? `They leave the saved-sessions branch in a new commit, pushed to ${props.remote}.` : "They leave the saved-sessions branch in a new commit, on this computer only."}
          </p>
          <p>Git history keeps them.</p>
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" disabled={props.busy} onClick={() => props.onCancel()}>
            Cancel
          </button>
          <button type="button" class="button button-destructive" disabled={props.busy} aria-busy={props.busy} onClick={() => props.onConfirm()}>
            Delete
          </button>
        </div>
      </div>
    </Portal>
  );
}
