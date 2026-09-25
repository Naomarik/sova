import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { PlaybookCatalog, PlaybookInfo } from "../../shared/protocol";
import { fetchPlaybooks } from "../lib/api";
import {
  groupPlaybooks,
  noPlaybookDrafts,
  type PlaybookDrafts,
  playbookDraft,
  playbookDraftsEmpty,
  playbookKey,
  playbookTurnText,
  projectNote,
  sentPlaybookDraft,
  setPlaybookDraft,
} from "../lib/playbooks";
import type { ComposerReason } from "./Composer";
import { Banner, Icon, trapFocus } from "./ui";
import { hostOf } from "../lib/mesh";

/** Same rule as everywhere else: a skeleton only after the fetch has actually been slow. */
const SKELETON_MS = 300;

/** What was typed, per playbook, when the dialog closed unsent — per session, for the page's
    lifetime. Closing is sometimes forced (the Reconnect button sits under the scrim), so a close
    must not be what throws the text away: reopening puts it back. Sending clears that playbook's. */
const kept = new Map<string, PlaybookDrafts>();

/**
 * The composer flyout's Playbooks dialog: one modal, two steps. Step 1 lists the catalog in three
 * groups (Sova, Yours, This project); step 2 shows the chosen playbook, its guidance, and a
 * textarea, and `Send Playbook` hands the whole turn to the chat's ordinary send path — so it is
 * judged by the model policy, acked, queued behind a running turn, and restored on refusal like
 * any other message.
 *
 *   path      this chat's session file (what an unsent text is kept under)
 *   cwd       the session's stored cwd (project playbooks come from it), or null
 *   blocked   why this chat can't send right now (the composer's reason line), or null. The dialog
 *             stays open and keeps what was typed; only `Send Playbook` goes aria-disabled.
 *   onSend    sends the text; false = refused here (the text stays in the dialog)
 *   onClose   close; `sent` = the socket took the message (focus goes to the composer's
 *             textarea), otherwise it returns to the flyout trigger
 *   onOrphan  the dialog is being torn down by something other than Close/Escape/Send (the chat
 *             view itself went away) while holding typed text: where that text goes instead
 */
export function PlaybooksDialog(props: {
  path: string;
  cwd: string | null;
  blocked: ComposerReason | null;
  onSend(text: string): boolean;
  onClose(sent: boolean): void;
  onOrphan?(text: string): void;
}) {
  const [catalog, setCatalog] = createSignal<PlaybookCatalog | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [slow, setSlow] = createSignal(false);
  const [chosen, setChosen] = createSignal<PlaybookInfo | null>(null);
  const restored = kept.get(props.path);
  const [drafts, setDrafts] = createSignal<PlaybookDrafts>(restored ?? noPlaybookDrafts);
  const chosenKey = () => {
    const p = chosen();
    return p ? playbookKey(p) : null;
  };
  /** The textarea shows the chosen playbook's own text: a note for A never rides with B. */
  const text = () => playbookDraft(drafts(), chosenKey());
  const setText = (value: string) => {
    const key = chosenKey();
    if (key) setDrafts((d) => setPlaybookDraft(d, key, value));
  };
  /** Set by every exit the user chose; anything else unmounting us is an orphaning. */
  let leaving = false;
  let textarea: HTMLTextAreaElement | undefined;
  /** Step 1's row for the playbook step 2 is showing: Back and Escape put focus back on it. */
  let lastKey: string | null = restored?.last ?? null;
  const rows = new Map<string, HTMLButtonElement>();
  let box: HTMLDivElement | undefined;

  // Fetched once per opening and kept for the modal's lifetime: Back doesn't refetch, Retry does.
  let run = 0;
  const load = async () => {
    const mine = ++run;
    setLoading(true);
    const slowTimer = setTimeout(() => mine === run && setSlow(true), SKELETON_MS);
    try {
      const next = await fetchPlaybooks(props.cwd, hostOf(props.path));
      if (mine !== run) return;
      setCatalog(next);
      setError(null);
      // The first load only: back where the last opening left off, if that playbook still exists.
      const again = mine === 1 && restored?.last && !chosen() ? next.playbooks.find((p) => playbookKey(p) === restored.last) : undefined;
      if (again) choose(again);
      // The first row, while nothing in the dialog has a better claim (the box itself, or <body>
      // after a Retry button that just went away).
      else if (!chosen() && (!box || document.activeElement === box || !box.contains(document.activeElement))) queueMicrotask(() => focusRow(0));
    } catch (err) {
      if (mine !== run) return;
      setError((err as Error).message);
    } finally {
      clearTimeout(slowTimer);
      if (mine === run) {
        setLoading(false);
        setSlow(false);
      }
    }
  };
  void load();
  onCleanup(() => {
    run++; // an answer that lands after the close writes to nothing
    if (leaving) return;
    // Torn down under the user: the chat view is going away, so the text goes to its draft.
    const key = chosenKey() ?? lastKey;
    const orphan = playbookDraft(drafts(), key);
    const rest = key ? sentPlaybookDraft(drafts(), key) : drafts();
    if (playbookDraftsEmpty(rest)) kept.delete(props.path);
    else kept.set(props.path, rest);
    if (orphan.trim()) props.onOrphan?.(orphan);
  });

  const groups = createMemo(() => groupPlaybooks(catalog() ?? { playbooks: [] }));
  const note = createMemo(() => {
    const c = catalog();
    return c ? projectNote(c.project) : null;
  });

  /** Step 1's rows in the order they're drawn, for arrow-key movement (a roving tabindex). */
  const order = createMemo(() => groups().flatMap((g) => g.playbooks.map(playbookKey)));
  const [active, setActive] = createSignal<string | null>(null);
  const focusRow = (index: number) => {
    const key = order()[index];
    if (!key) return;
    setActive(key);
    rows.get(key)?.focus();
  };
  const onListKeyDown = (e: KeyboardEvent) => {
    const n = order().length;
    if (n === 0) return;
    const at = Math.max(0, order().indexOf(active() ?? ""));
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusRow((at + 1) % n),
      ArrowUp: () => focusRow((at - 1 + n) % n),
      Home: () => focusRow(0),
      End: () => focusRow(n - 1),
    };
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };
  const tabStop = (key: string) => (active() ?? order()[0]) === key;

  const close = () => {
    leaving = true;
    const d = lastKey && !chosen() ? { ...drafts(), last: lastKey } : drafts();
    if (playbookDraftsEmpty(d)) kept.delete(props.path);
    else kept.set(props.path, d);
    props.onClose(false);
  };
  const choose = (p: PlaybookInfo) => {
    lastKey = playbookKey(p);
    setActive(lastKey);
    setDrafts((d) => ({ ...d, last: lastKey }));
    setChosen(p);
    queueMicrotask(() => textarea?.focus());
  };
  const back = () => {
    setChosen(null);
    queueMicrotask(() => (lastKey && rows.get(lastKey)?.focus()) || undefined);
  };
  const send = () => {
    const p = chosen();
    if (!p || props.blocked) return;
    if (!props.onSend(playbookTurnText(p, text()))) return; // refused here: keep everything
    leaving = true;
    const rest = sentPlaybookDraft(drafts(), playbookKey(p));
    if (playbookDraftsEmpty(rest)) kept.delete(props.path);
    else kept.set(props.path, rest);
    props.onClose(true);
  };

  return (
    <Portal>
      <div class="scrim" onClick={close} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playbooks-title"
        tabindex="-1"
        ref={(el) => {
          box = el;
          trapFocus(el);
          queueMicrotask(() => el.focus());
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          if (chosen()) back();
          else close();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="playbooks-title">
            {chosen()?.title ?? "Playbooks"}
          </h2>
        </div>

        <Show
          when={chosen()}
          fallback={
            <div class="modal-body">
              <Show when={error()}>
                {(message) => (
                  <Banner
                    tone="error"
                    title="Couldn't load the playbooks."
                    body={message()}
                    action={
                      <button type="button" class="button button-sm" onClick={() => void load()}>
                        Retry
                      </button>
                    }
                  />
                )}
              </Show>
              <Show when={loading() && slow() && !catalog()}>
                <div aria-hidden="true">
                  <span class="skeleton skeleton-row" />
                  <span class="skeleton skeleton-row" />
                </div>
              </Show>
              <Show when={catalog()}>
                {(c) => (
                  <>
                    <Show when={c().error}>
                      {(m) => <p class="text-caption text-muted">We couldn't read your playbooks folder, so yours aren't listed. {m()}</p>}
                    </Show>
                    <Show when={groups().length > 0} fallback={<p class="text-muted">No playbooks yet.</p>}>
                      <For each={groups()}>
                        {(g) => (
                          <div role="group" aria-labelledby={`playbooks-group-${g.key}`}>
                            <h3 class="list-group-label" id={`playbooks-group-${g.key}`}>
                              {g.label}
                            </h3>
                            <div class="list" onKeyDown={onListKeyDown}>
                              <For each={g.playbooks}>
                                {(p) => (
                                  <button
                                    type="button"
                                    class="list-row list-row-interactive"
                                    ref={(el) => rows.set(playbookKey(p), el)}
                                    tabindex={tabStop(playbookKey(p)) ? 0 : -1}
                                    onFocus={() => setActive(playbookKey(p))}
                                    title={p.description || undefined}
                                    onClick={() => choose(p)}
                                  >
                                    {/* Two .list-line wrappers stack title over description
                                        inside a <button>, where <p> isn't allowed. */}
                                    <span class="list-main">
                                      <span class="list-line">
                                        <span class="list-title">{p.title}</span>
                                      </span>
                                      <Show when={p.description}>
                                        <span class="list-line list-meta-row">
                                          <span class="list-meta">{p.description}</span>
                                        </span>
                                      </Show>
                                    </span>
                                    <Icon name="chevron-right" small />
                                  </button>
                                )}
                              </For>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>
                    <Show when={note()}>{(m) => <p class="text-caption text-muted">{m()}</p>}</Show>
                  </>
                )}
              </Show>
            </div>
          }
        >
          {(p) => (
            <div class="modal-body">
              <Show when={p().description}>
                <p class="text-caption text-muted">{p().description}</p>
              </Show>
              <div class="field">
                <label class="field-label" for="playbooks-text">
                  Anything to add
                </label>
                <Show when={p().promptHint}>
                  {(hint) => (
                    <span class="field-hint" id="playbooks-hint">
                      {hint()}
                    </span>
                  )}
                </Show>
                <textarea
                  id="playbooks-text"
                  class="input textarea"
                  ref={textarea}
                  value={text()}
                  aria-describedby={p().promptHint ? "playbooks-hint" : undefined}
                  onInput={(e) => setText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    // Enter is a newline here; Ctrl/⌘+Enter sends.
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
              </div>
            </div>
          )}
        </Show>

        <div class="modal-foot">
          <Show when={chosen()}>
            <button type="button" class="button button-ghost" onClick={back}>
              Back
            </button>
          </Show>
          <Show when={chosen() && props.blocked}>
            {(r) => (
              <span class="text-caption text-muted" id="playbooks-reason">
                <Icon name={r().icon} small /> {r().text}
              </span>
            )}
          </Show>
          <span class="modal-spacer" />
          <Show
            when={chosen()}
            fallback={
              <button type="button" class="button" onClick={close}>
                Close
              </button>
            }
          >
            <button
              type="button"
              class="button button-primary"
              aria-disabled={props.blocked ? "true" : undefined}
              aria-describedby={props.blocked ? "playbooks-reason" : undefined}
              onClick={send}
            >
              Send Playbook
            </button>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
