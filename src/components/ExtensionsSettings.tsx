import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { ExtensionInspect, ExtensionReview, ExtensionRow, ExtensionsInstalled } from "../../shared/extension-loader";
import { ApiError, approveExtension, chooseExtensionFolder, extensionProgram, getExtensionLog, getExtensionsInstalled, getUpdates, inspectExtension, installExtension, removeExtension, turnExtensionOff, turnExtensionOn } from "../lib/api";
import {
  asksCards,
  EXT_APPROVE_CHANGED,
  EXT_CARDS_NOTE,
  EXT_CHANGED_LEAD,
  EXT_INTRO,
  EXT_KEY_LINE,
  EXT_LOAD_FAILED,
  EXT_NO_MANAGER,
  EXT_NONE,
  EXT_PAGE_LINE,
  EXT_PICK_HINT,
  EXT_PICK_TITLE,
  EXT_TRUST,
  extensionListChanged,
  found,
  onToast,
  removeQuestion,
  rowActions,
  rulesLine,
  runsLine,
  STATE_WORD,
  stateTone,
  throughWords,
} from "../lib/extensions-settings";
import { tildePath } from "../lib/format";
import { createPoll } from "../lib/poll";
import { home, setHome, toast } from "../lib/ui-state";
import { FolderPicker } from "./FolderPicker";
import { Toggle } from "./form";
import { Banner, Chip, trapFocus } from "./ui";
import { sentence } from "./WorkerSlotRow";
import "./McpServers.css";

const EXT_POLL_MS = 3_000;
const errText = (err: unknown) => sentence(err instanceof Error ? err.message : String(err));

/** What Review shows and what its button does. `to`: a new folder (Install, or Choose Folder), or the entry as it stands. */
type Reviewing = { review: ExtensionReview; mode: "install" | "approve" | "folder"; changed?: boolean; folder?: string; forId?: string };

/** The review, before anything is on: a part it doesn't have is left out. */
function ReviewDialog(props: { at: Reviewing; onClose: () => void; onDone: (r: ExtensionReview) => Promise<void>; reread: () => Promise<ExtensionInspect> }) {
  const [at, setAt] = createSignal(props.at);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const r = () => at().review;
  const a = () => r().asks;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const { mode, folder, forId } = at();
      if (mode === "install") await installExtension(folder!, r().version);
      else if (mode === "folder") await chooseExtensionFolder(forId!, folder!, r().version);
      else await approveExtension(r().id, r().version);
      await props.onDone(r());
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === "changed") {
        setError(EXT_APPROVE_CHANGED);
        const again = await props.reread().catch(() => null);
        if (again?.ok) setAt({ ...at(), review: again.review });
      } else setError(errText(err));
    }
  };
  return (
    <Portal>
      <div class="scrim mcp-scrim" onClick={() => props.onClose()} />
      <div
        class="modal mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ext-review-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="ext-review-title">
            {at().mode === "approve" ? `Approve ${r().title}?` : `Add ${r().title}?`}
          </h2>
        </div>
        <div class="modal-body stack">
          <Show when={at().changed}>
            <p class="mcp-line">{EXT_CHANGED_LEAD}</p>
          </Show>
          <Show when={r().description}>
            <p class="mcp-line">{r().description}</p>
          </Show>
          <dl class="mcp-runs ext-review">
            <Show when={r().folder}>
              {(f) => (
                <div>
                  <dt>Folder</dt>
                  <dd class="text-mono">{tildePath(f(), home())}</dd>
                </div>
              )}
            </Show>
            <Show when={a().program}>
              {(p) => (
                <div>
                  <dt>It runs</dt>
                  <dd class="text-mono">{runsLine(p())}</dd>
                </div>
              )}
            </Show>
            <Show when={a().page}>
              <div>
                <dt>Its page</dt>
                <dd>{EXT_PAGE_LINE}</dd>
              </div>
            </Show>
            <Show when={a().key}>
              <div>
                <dt>Its key</dt>
                <dd>{EXT_KEY_LINE}</dd>
              </div>
            </Show>
            <Show when={a().cards}>
              {(c) => (
                <div>
                  <dt>Cards</dt>
                  <dd>{c().join(", ")}</dd>
                </div>
              )}
            </Show>
            <Show when={a().drawings}>
              {(c) => (
                <div>
                  <dt>Drawings</dt>
                  <dd>{c().join(", ")}</dd>
                </div>
              )}
            </Show>
            <Show when={a().commands}>
              {(c) => (
                <div>
                  <dt>Commands</dt>
                  <dd>{c().join(", ")}</dd>
                </div>
              )}
            </Show>
            <Show when={a().overseer}>
              {(c) => (
                <div>
                  <dt>Overseer</dt>
                  <dd>{c().join(", ")}</dd>
                </div>
              )}
            </Show>
            <Show when={r().needs}>
              {(n) => (
                <div>
                  <dt>Rules</dt>
                  <dd>{rulesLine(n(), r().has)}</dd>
                </div>
              )}
            </Show>
            <Show when={r().leftOut.length}>
              <div>
                <dt>Left out</dt>
                <dd>
                  <For each={r().leftOut}>{(l) => <span class="ext-left-out">{l}</span>}</For>
                </dd>
              </div>
            </Show>
          </dl>
          <Show when={r().noServiceManager}>
            <p class="field-hint">{EXT_NO_MANAGER}</p>
          </Show>
          <p class="mcp-line">{EXT_TRUST}</p>
          <Show when={error()}>
            <p class="field-error">{error()}</p>
          </Show>
        </div>
        <div class="modal-foot">
          <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
            Cancel
          </button>
          <button type="button" class="button button-primary" disabled={busy()} onClick={() => void go()}>
            {at().mode === "install" ? "Install and Turn On" : "Approve"}
          </button>
        </div>
      </div>
    </Portal>
  );
}

/** Choosing a folder: the folder being browsed is the choice, so each pick is read at once. */
function ChooseDialog(props: { start?: string; forId?: string; onClose: () => void; onReview: (r: ExtensionReview, folder: string) => void }) {
  const [folder, setFolder] = createSignal(props.start ?? "");
  const [answer, setAnswer] = createSignal<ExtensionInspect | null>(null);
  const [picking, setPicking] = createSignal(true);
  let seq = 0;
  const pick = (path: string) => {
    setFolder(path);
    const mine = ++seq;
    setAnswer(null);
    void inspectExtension({ folder: path, ...(props.forId ? { id: props.forId } : {}) }).then(
      (a) => mine === seq && setAnswer(a),
      (err) => mine === seq && setAnswer({ ok: false, reason: errText(err) }),
    );
  };
  const ready = () => {
    const a = answer();
    return a?.ok ? a : null;
  };
  return (
    <Portal>
      <div class="scrim mcp-scrim" onClick={() => props.onClose()} />
      <div
        class="modal mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ext-pick-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="ext-pick-title">
            {EXT_PICK_TITLE}
          </h2>
        </div>
        <div class="modal-body stack">
          <p class="field-hint">{EXT_PICK_HINT}</p>
          <Show
            when={picking()}
            fallback={
              <>
                <p class="text-mono ext-folder-now">{tildePath(folder(), home())}</p>
                <button type="button" class="button button-sm ext-choose-again" onClick={() => setPicking(true)}>
                  Choose Another Folder
                </button>
              </>
            }
          >
            <FolderPicker start={folder()} recents={[]} onPick={pick} onClose={() => setPicking(false)} />
          </Show>
          <div aria-live="polite">
            <Show when={answer()}>{(a) => (a().ok ? <p class="mcp-line ext-found">{found((a() as { ok: true; review: ExtensionReview }).review.title)}</p> : <p class="field-error">{(a() as { ok: false; reason: string }).reason}</p>)}</Show>
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
            Cancel
          </button>
          <button
            type="button"
            class="button button-primary"
            disabled={!ready()}
            onClick={() => {
              const a = ready();
              if (a) props.onReview(a.review, folder());
            }}
          >
            Review
          </button>
        </div>
      </div>
    </Portal>
  );
}

function Row(props: { row: ExtensionRow; through?: string; onChange: () => void; onReview: (r: ExtensionRow) => void; onChoose: (r: ExtensionRow) => void; onOpenServer: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [confirm, setConfirm] = createSignal(false);
  const [deleteData, setDeleteData] = createSignal(false);
  const [log, setLog] = createSignal<string[] | null>(null);
  const r = () => props.row;
  const [updates] = createResource(
    () => r().state === "needs-newer",
    (need) => (need ? getUpdates().catch(() => null) : null),
  );
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      extensionListChanged();
      props.onChange();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const toggleLog = async () => {
    if (log()) return setLog(null);
    try {
      const { lines } = await getExtensionLog(r().key);
      setLog(lines.map((l) => l.text));
    } catch (err) {
      setError(errText(err));
    }
  };
  const restartable = () => {
    const u = updates();
    return !!u?.running?.diskAhead && !!u?.running?.canRestart;
  };
  return (
    <li class="mcp-row" data-ext-row={r().id}>
      <div class="mcp-row-head">
        <span class="mcp-row-title ext-row-title">
          <span class="mcp-row-name">{r().title}</span>
          <Show when={r().folder}>{(f) => <span class="mcp-row-facts text-mono truncate">{tildePath(f(), home())}</span>}</Show>
        </span>
        <Chip tone={stateTone(r().state)}>{STATE_WORD[r().state]}</Chip>
        <Show when={r().on !== undefined && !props.through}>
          <Toggle
            switch
            class="mcp-switch"
            label={<span class="visually-hidden">Turn on {r().title}</span>}
            checked={!!r().on}
            disabled={busy()}
            onChange={(on) =>
              void act(
                () => (on ? turnExtensionOn(r().key) : turnExtensionOff(r().key)),
                () => on && toast(onToast(r().title, !!r().hasCards)),
              )
            }
          />
        </Show>
      </div>
      <Show when={r().line}>
        <p class={r().state === "not-usable" || r().state === "stopped" || r().state === "folder-not-found" ? "field-error mcp-note" : "field-hint mcp-note"}>{r().line}</p>
      </Show>
      <Show when={!props.through}>
        <div class="button-row ext-row-actions">
          <For each={rowActions(r().state, r())}>
            {(a) => (
              <>
                <Show when={a === "review"}>
                  <button type="button" class="button button-sm" aria-label={`Review ${r().title}`} disabled={busy()} onClick={() => props.onReview(r())}>
                    Review
                  </button>
                </Show>
                <Show when={a === "start"}>
                  <button type="button" class="button button-sm" disabled={busy()} onClick={() => void act(() => extensionProgram(r().key, "start"))}>
                    Start
                  </button>
                </Show>
                <Show when={a === "restart"}>
                  <button type="button" class="button button-sm" disabled={busy()} onClick={() => void act(() => extensionProgram(r().key, "restart"))}>
                    Restart Program
                  </button>
                </Show>
                <Show when={a === "log"}>
                  <button type="button" class="button button-sm" aria-expanded={!!log()} onClick={() => void toggleLog()}>
                    View Log
                  </button>
                </Show>
                <Show when={a === "choose-folder"}>
                  <button type="button" class="button button-sm" disabled={busy()} onClick={() => props.onChoose(r())}>
                    Choose Folder
                  </button>
                </Show>
                <Show when={a === "updates"}>
                  <button type="button" class="button button-sm" onClick={() => props.onOpenServer()}>
                    {restartable() ? "Restart Sova" : "Open Updates"}
                  </button>
                </Show>
                <Show when={a === "remove"}>
                  <button type="button" class="button button-sm button-destructive" aria-expanded={confirm()} aria-label={`Remove ${r().title}`} disabled={busy()} onClick={() => setConfirm(true)}>
                    Remove
                  </button>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
      <Show when={log()}>
        {(lines) => (
          <ul class="mcp-errors ext-log">
            <Show when={lines().length} fallback={<li class="text-mono">Nothing in its log yet.</li>}>
              <For each={lines()}>{(l) => <li class="text-mono">{l}</li>}</For>
            </Show>
          </ul>
        )}
      </Show>
      <Show when={error()}>
        <p class="field-error mcp-note">{error()}</p>
      </Show>
      <Show when={confirm()}>
        <div class="mcp-confirm ext-confirm" role="group" aria-label={`Remove ${r().title}`}>
          <p class="mcp-line">{removeQuestion(r().title)}</p>
          <Toggle label="Also delete its data" checked={deleteData()} onChange={setDeleteData} />
          <span class="button-row">
            <button type="button" class="button button-sm button-destructive" disabled={busy()} onClick={() => void act(() => removeExtension(r().key, deleteData()))}>
              Remove
            </button>
            <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </span>
        </div>
      </Show>
    </li>
  );
}

/** Settings → Extensions: this computer's extensions. Every action on it saves at once. */
export function ExtensionsSettingsSection(props: { onOpenServer: () => void }) {
  const poll = createPoll<ExtensionsInstalled>(getExtensionsInstalled, EXT_POLL_MS, { cacheKey: "extensions:installed" });
  // Only the folder picker sets this otherwise, so a row drawn before it opens would show the whole path.
  createEffect(() => {
    const h = poll.data()?.home;
    if (h && !home()) setHome(h);
  });
  const [choosing, setChoosing] = createSignal<{ forId?: string } | null>(null);
  const [reviewing, setReviewing] = createSignal<Reviewing | null>(null);
  const [rowError, setRowError] = createSignal<string | null>(null);
  const reviewRow = async (row: ExtensionRow) => {
    setRowError(null);
    try {
      const a = await inspectExtension({ id: row.id });
      if (a.ok) setReviewing({ review: a.review, mode: "approve", changed: row.state === "changed" });
      else setRowError(a.reason);
    } catch (err) {
      setRowError(errText(err));
    }
  };
  const done = async (r: ExtensionReview) => {
    // The list first: closing on the old one would flash "No extensions yet" under a first install.
    await getExtensionsInstalled().then(poll.set, poll.refetch);
    setReviewing(null);
    toast(onToast(r.title, asksCards(r.asks)));
    extensionListChanged();
  };
  const reread = (): Promise<ExtensionInspect> => {
    const at = reviewing()!;
    return inspectExtension(at.folder ? { folder: at.folder, ...(at.forId ? { id: at.forId } : {}) } : { id: at.review.id });
  };
  return (
    <section class="settings-delegate mcp-settings" aria-labelledby="settings-ext-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-ext-title">
          Extensions
        </h3>
        <Show when={!poll.data()?.through}>
          <button type="button" class="button button-sm button-primary" onClick={() => setChoosing({})}>
            Add Extension
          </button>
        </Show>
      </div>
      <p class="settings-intro">{EXT_INTRO}</p>
      <Show when={poll.data()?.through}>{(c) => <Banner tone="info" title={throughWords(c())} />}</Show>
      <Show when={poll.data()?.rows.some((r) => r.hasCards)}>
        <p class="field-hint">{EXT_CARDS_NOTE}</p>
      </Show>
      <Show when={poll.error() && !poll.data()}>
        <Banner tone="error" title={EXT_LOAD_FAILED} body={`Nothing was changed. ${poll.error()}`} />
      </Show>
      <Show when={rowError()}>
        <p class="field-error">{rowError()}</p>
      </Show>
      <Show when={poll.data()}>
        {(d) => (
          <>
            <Show when={d().rows.length} fallback={<p class="mcp-line">{EXT_NONE}</p>}>
              <ul class="mcp-rows" data-testid="extensions">
                <For each={d().rows}>{(r) => <Row row={r} through={d().through} onChange={poll.refetch} onReview={(x) => void reviewRow(x)} onChoose={(x) => setChoosing({ forId: x.id })} onOpenServer={props.onOpenServer} />}</For>
              </ul>
            </Show>
            <Show when={d().others.length}>
              <h4 class="mcp-heading">On Other Computers</h4>
              <ul class="mcp-rows" data-testid="extensions-others">
                <For each={d().others}>
                  {(o) => (
                    <li class="mcp-row">
                      <div class="mcp-row-head">
                        <span class="mcp-row-title ext-row-title">
                          <span class="mcp-row-name">{o.title}</span>
                          <Show when={o.from}>
                            <span class="mcp-row-facts">From {o.from}</span>
                          </Show>
                        </span>
                        <Chip>Not Installed Here</Chip>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
      <Show when={choosing()}>
        {(c) => (
          <ChooseDialog
            forId={c().forId}
            onClose={() => setChoosing(null)}
            onReview={(review, folder) => {
              const forId = c().forId;
              setChoosing(null);
              setReviewing(forId ? { review, mode: "folder", folder, forId } : { review, mode: "install", folder });
            }}
          />
        )}
      </Show>
      <Show when={reviewing()}>{(at) => <ReviewDialog at={at()} onClose={() => setReviewing(null)} onDone={done} reread={reread} />}</Show>
    </section>
  );
}
