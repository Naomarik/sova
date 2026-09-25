import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { TODO_TEXT_MAX, type OverseerTodosInfo, type TodoConflict, type TodoRecord } from "../../shared/protocol";
import { addOverseerTodo, ApiError, clearDoneOverseerTodos, deleteOverseerTodo, getOverseerTodos, patchOverseerTodo, reorderOverseerTodos } from "../lib/api";
import { tildePath } from "../lib/format";
import { OVERSEER_POLL_MS } from "../lib/overseer";
import { createPoll } from "../lib/poll";
import { resolveAppLink, sessionIndex, sessionIndexVersion } from "../lib/session-links";
import { moveId, splitTodos, todoName, todosCount, todosMeta } from "../lib/todos";
import { announce, home } from "../lib/ui-state";
import { Banner, Icon } from "./ui";
import "../overseer-todos.css";

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");

/**
 * The Overseer page's Todos panel: the user's checklist, which the Overseer keeps from chat
 * (`sova_todo`) and the user edits here. Open todos first, in the user's order; done ones under a
 * collapsed "Done" until cleared. While open it reads the list every OVERSEER_POLL_MS (and when an
 * Overseer turn ends), so a todo the Overseer added mid-turn shows within one poll. Every write
 * answers with the whole list, which the panel adopts as it is.
 */
export function OverseerTodos(props: {
  /** Bumps when an Overseer turn ended: the list may have changed. */
  version: number;
  /** The open count, for the head's button, after every read or write. */
  onCount(open: number): void;
  onClose(): void;
}) {
  const poll = createPoll(getOverseerTodos, OVERSEER_POLL_MS);
  createEffect(on(() => props.version, () => poll.refetch(), { defer: true }));
  createEffect(() => {
    const open = poll.data()?.open;
    if (open !== undefined) props.onCount(open);
  });
  const lists = createMemo(() => splitTodos(poll.data()));
  const [showDone, setShowDone] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [addError, setAddError] = createSignal<string | null>(null);
  const [rowError, setRowError] = createSignal<string | null>(null);
  let titleEl!: HTMLHeadingElement;
  let addInput!: HTMLInputElement;
  onMount(() => titleEl.focus());

  const adopt = (info: OverseerTodosInfo) => poll.set(info);
  /** After a row moved or went: focus the same control on `id`'s row, else the add field. */
  const focusRow = (id: string | undefined, part: string) =>
    queueMicrotask(() => {
      const el = id ? document.querySelector<HTMLElement>(`[data-todo="${CSS.escape(id)}"] .${part}`) : null;
      (el ?? addInput)?.focus();
    });

  /** One row write: adopt the list, or say what failed with nothing changed. */
  const write = async (run: () => Promise<OverseerTodosInfo>, done: string, what: string): Promise<boolean> => {
    setRowError(null);
    try {
      adopt(await run());
      announce(done);
      return true;
    } catch (err) {
      setRowError(`Couldn't ${what}. ${reason(err)}.`);
      announce(`Couldn't ${what}.`);
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) poll.refetch();
      return false;
    }
  };

  const add = async (e: SubmitEvent) => {
    e.preventDefault();
    const text = draft().replace(/\s+/g, " ").trim();
    if (!text || adding()) return;
    setAdding(true);
    setAddError(null);
    try {
      adopt(await addOverseerTodo(text));
      setDraft("");
      announce(`Added: ${todoName(text)}`);
    } catch (err) {
      setAddError(`${reason(err)}. Nothing was added.`);
    } finally {
      setAdding(false);
    }
  };

  const tick = async (t: TodoRecord, done: boolean) => {
    const siblings = done ? lists().open : lists().done;
    const next = siblings[siblings.findIndex((x) => x.id === t.id) + 1]?.id ?? siblings[siblings.findIndex((x) => x.id === t.id) - 1]?.id;
    if (await write(() => patchOverseerTodo(t.id, { done }), `${done ? "Done" : "Open again"}: ${todoName(t.text)}`, `${done ? "tick" : "untick"} the todo`))
      focusRow(next, "todos-check-input");
  };

  const move = async (t: TodoRecord, dir: -1 | 1) => {
    const all = poll.data()?.todos ?? [];
    const ids = moveId(all, t.id, dir);
    if (!ids) return;
    if (await write(() => reorderOverseerTodos(ids), `Moved ${dir < 0 ? "up" : "down"}: ${todoName(t.text)}`, "move the todo"))
      focusRow(t.id, dir < 0 ? "todos-up" : "todos-down");
  };

  const remove = async (t: TodoRecord) => {
    const list = t.done ? lists().done : lists().open;
    const at = list.findIndex((x) => x.id === t.id);
    const next = list[at + 1]?.id ?? list[at - 1]?.id;
    if (await write(() => deleteOverseerTodo(t.id), `Removed: ${todoName(t.text)}`, "remove the todo")) focusRow(next, "todos-remove");
  };

  const clear = async () => {
    const n = lists().done.length;
    if (await write(clearDoneOverseerTodos, `Cleared ${todosCount(n)}.`, "clear the done todos")) {
      setShowDone(false);
      addInput.focus();
    }
  };

  return (
    <aside
      class="todos-panel"
      id="overseer-todos"
      aria-labelledby="todos-title"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        props.onClose();
      }}
    >
      <header class="todos-head">
        <div class="todos-head-main">
          <h2 class="todos-title" id="todos-title" tabindex="-1" ref={titleEl}>
            Todos
          </h2>
          <p class="todos-meta">{todosMeta(poll.data())}</p>
        </div>
        <button type="button" class="button button-icon button-ghost" aria-label="Close Todos" onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </header>

      <form class="todos-add" onSubmit={(e) => void add(e)}>
        <input
          ref={addInput}
          class="input todos-add-input"
          type="text"
          placeholder="Add a todo"
          aria-label="New todo"
          aria-invalid={addError() ? "true" : undefined}
          aria-describedby={addError() ? "todos-add-error" : undefined}
          maxlength={TODO_TEXT_MAX}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit" class="button" aria-disabled={adding() || !draft().trim() ? "true" : undefined}>
          <Icon name="plus" small />
          Add
        </button>
        <Show when={addError()}>
          {(e) => (
            <p class="field-error todos-add-error" id="todos-add-error">
              {e()}
            </p>
          )}
        </Show>
      </form>

      <div class="todos-body">
        <Show when={rowError()}>{(e) => <Banner tone="error" title="Nothing was changed." body={e()} />}</Show>
        <Show when={poll.data()} fallback={<Loading error={poll.error()} retry={poll.refetch} />}>
          {(info) => (
            <Show
              when={info().todos.length > 0}
              fallback={
                <div class="empty todos-empty">
                  <p class="empty-title">No todos yet.</p>
                  <p class="empty-body">Tell the Overseer "remind me to…", or add one here.</p>
                </div>
              }
            >
              <Show when={lists().open.length > 0} fallback={<p class="todos-note">Nothing open. {todosCount(info().done)} done.</p>}>
                <ul class="list todos-list" aria-label="Open todos">
                  <For each={lists().open}>
                    {(t, i) => (
                      <TodoRow
                        todo={t}
                        first={i() === 0}
                        last={i() === lists().open.length - 1}
                        onTick={(done) => void tick(t, done)}
                        onMove={(dir) => void move(t, dir)}
                        onRemove={() => void remove(t)}
                        onAdopt={adopt}
                        onError={setRowError}
                      />
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={lists().done.length > 0}>
                <div class="todos-done-head">
                  <button
                    type="button"
                    class="button button-sm button-ghost todos-done-toggle"
                    aria-expanded={showDone()}
                    aria-controls="todos-done"
                    onClick={() => setShowDone((v) => !v)}
                  >
                    <Icon name="chevron-down" small class={showDone() ? "" : "todos-closed"} />
                    Done ({lists().done.length})
                  </button>
                  <button type="button" class="button button-sm todos-clear" onClick={() => void clear()}>
                    Clear Done
                  </button>
                </div>
                <Show when={showDone()}>
                  <ul class="list todos-list" id="todos-done" aria-label="Done todos">
                    <For each={lists().done}>
                      {(t) => (
                        <TodoRow todo={t} onTick={(done) => void tick(t, done)} onRemove={() => void remove(t)} onAdopt={adopt} onError={setRowError} />
                      )}
                    </For>
                  </ul>
                </Show>
              </Show>
            </Show>
          )}
        </Show>
      </div>
      <Show when={poll.data()}>
        {(info) => (
          <p class="todos-file">
            Stored in <code>{tildePath(info().file, home())}</code>.
          </p>
        )}
      </Show>
    </aside>
  );
}

function Loading(props: { error: string | null; retry(): void }) {
  return (
    <Show when={props.error} fallback={<p class="todos-note">Loading the todos…</p>}>
      {(e) => (
        <Banner
          tone="error"
          title="Couldn't load the todos."
          body={`${e().replace(/\.$/, "")}. Nothing was changed.`}
          action={
            <button type="button" class="button button-sm" onClick={() => props.retry()}>
              Try Again
            </button>
          }
        />
      )}
    </Show>
  );
}

/**
 * One todo: its checkbox, its text (a button that becomes an input in place: Enter or leaving the
 * field saves, Escape cancels), what it links, ↑/↓ while open, and ×. A text edit carries the
 * todo's updatedAt as `base`, so it never overwrites a change the Overseer made meanwhile.
 */
function TodoRow(props: {
  todo: TodoRecord;
  /** Open rows only: the ends disable their move. Done rows have no ↑/↓. */
  first?: boolean;
  last?: boolean;
  onTick(done: boolean): void;
  onMove?(dir: -1 | 1): void;
  onRemove(): void;
  onAdopt(info: OverseerTodosInfo): void;
  onError(message: string | null): void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal("");
  const [base, setBase] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  let input: HTMLInputElement | undefined;
  const name = () => todoName(props.todo.text);

  const session = createMemo(() => {
    const id = props.todo.sessionId;
    if (!id) return null;
    sessionIndexVersion();
    const view = resolveAppLink(`sova://s/${id}`, sessionIndex());
    return view?.kind === "route" ? { href: view.href, title: view.title ?? "Session" } : null;
  });

  const start = () => {
    setText(props.todo.text);
    setBase(props.todo.updatedAt);
    setNotice(null);
    setEditing(true);
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  };
  const stop = () => {
    setEditing(false);
    setNotice(null);
    queueMicrotask(() => document.querySelector<HTMLElement>(`[data-todo="${CSS.escape(props.todo.id)}"] .todos-text`)?.focus());
  };
  const save = async () => {
    if (!editing() || saving()) return;
    const next = text().replace(/\s+/g, " ").trim();
    if (!next || next === props.todo.text) return stop();
    setSaving(true);
    props.onError(null);
    try {
      props.onAdopt(await patchOverseerTodo(props.todo.id, { text: next, base: base() }));
      announce(`Saved: ${todoName(next)}`);
      stop();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.body as TodoConflict | undefined)?.current;
        if (current) props.onAdopt(current);
        const now = current?.todos.find((x) => x.id === props.todo.id);
        if (now) setBase(now.updatedAt);
        setNotice(`This todo changed meanwhile, so nothing was saved. It now reads “${now?.text ?? props.todo.text}”. Save again to replace it with yours.`);
        announce("This todo changed meanwhile. Nothing was saved.");
        queueMicrotask(() => input?.focus());
      } else {
        props.onError(`Couldn't save the todo. ${reason(err)}.`);
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <li class="todos-row" classList={{ "todos-row-done": props.todo.done }} data-todo={props.todo.id}>
      <label class="toggle todos-check">
        <input class="todos-check-input" type="checkbox" checked={props.todo.done} aria-label={`Done: ${name()}`} onChange={(e) => props.onTick(e.currentTarget.checked)} />
        <span class="toggle-box" aria-hidden="true" />
      </label>
      <div class="todos-main">
        <Show
          when={editing()}
          fallback={
            <Show when={!props.todo.done} fallback={<span class="todos-text todos-text-static">{props.todo.text}</span>}>
              <button type="button" class="todos-text" title="Edit" aria-label={`${props.todo.text}. Edit`} onClick={start}>
                {props.todo.text}
              </button>
            </Show>
          }
        >
          <input
            ref={input}
            class="input todos-edit"
            type="text"
            aria-label={`Edit todo: ${name()}`}
            maxlength={TODO_TEXT_MAX}
            value={text()}
            aria-busy={saving() ? "true" : undefined}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                stop();
              }
            }}
            onBlur={() => void save()}
          />
          <Show when={notice()}>{(n) => <p class="field-hint todos-notice">{n()}</p>}</Show>
        </Show>
        <Show when={props.todo.ideaId || session()}>
          <p class="todos-links">
            <Show when={props.todo.ideaId}>{(id) => <span class="text-mono">{id()}</span>}</Show>
            <Show when={props.todo.ideaId && session()}>{" · "}</Show>
            <Show when={session()}>{(s) => <a href={s().href}>{s().title}</a>}</Show>
          </p>
        </Show>
      </div>
      <Show when={props.onMove}>
        {(onMove) => (
          <>
            <button
              type="button"
              class="button button-icon button-ghost todos-up"
              aria-label={`Move up: ${name()}`}
              title="Move up"
              aria-disabled={props.first ? "true" : undefined}
              onClick={() => !props.first && onMove()(-1)}
            >
              <Icon name="chevron-down" small class="todos-flip" />
            </button>
            <button
              type="button"
              class="button button-icon button-ghost todos-down"
              aria-label={`Move down: ${name()}`}
              title="Move down"
              aria-disabled={props.last ? "true" : undefined}
              onClick={() => !props.last && onMove()(1)}
            >
              <Icon name="chevron-down" small />
            </button>
          </>
        )}
      </Show>
      <button type="button" class="button button-icon button-ghost todos-remove" aria-label={`Remove: ${name()}`} title="Remove" onClick={() => props.onRemove()}>
        <Icon name="close" small />
      </button>
    </li>
  );
}
