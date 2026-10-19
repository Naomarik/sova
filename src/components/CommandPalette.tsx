import { createEffect, createMemo, createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { buildRequest, type CommandEntry } from "../../shared/commands-catalog";
import { fetchServedCommands, runCommandRequest } from "../lib/api";
import {
  answerText,
  buildRows,
  commandHost,
  enterTarget,
  filterRows,
  formOf,
  GROUPS,
  moveActive,
  NO_ROW,
  valuesOf,
  type AnswerState,
  type FormInput,
  type PaletteContext,
  type PaletteRow,
} from "../lib/palette";
import { createPanelArm } from "../lib/palette-arm";
import { announce } from "../lib/ui-state";
import { hostOf } from "../lib/mesh";
import { commandDialogs, viewRows, type ViewHost } from "../commands/view";
import type { ComposerHandle } from "../commands/composers";
import { trapFocus } from "./ui";
import "../command-palette.css";

/** The served list this tab got last, kept while the module is: the next opening shows it at once. */
let lastServed: { list: CommandEntry[]; text: string } | null = null;

const sameRow = (a: PaletteRow, b: PaletteRow) =>
  a.label === b.label && a.detail === b.detail && a.keys === b.keys && a.disabled === b.disabled && (a.act.kind !== "command" || (b.act.kind === "command" && a.act.entry === b.act.entry));

/**
 * The command palette (§app/command-palette): a modal of rows (where to go, the open chat's slash
 * commands, the server's command list) and, for a picked command, its panel. Loaded on the first
 * Ctrl/⌘+K (App's `lazy`), so nothing here runs before.
 */
export default function CommandPalette(props: {
  host: ViewHost;
  /** The open session and composer, as of now. */
  context(): PaletteContext;
  /** The composer the "This chat" rows act on. */
  composer(): ComposerHandle | null;
  onClose(): void;
}) {
  const uid = createUniqueId();
  const listId = `palette-list-${uid}`;
  const optionId = (key: string) => `palette-${uid}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(NO_ROW);
  const [served, setServed] = createSignal<CommandEntry[] | null>(lastServed?.list ?? null);
  const [servedError, setServedError] = createSignal(false);
  const [panel, setPanel] = createSignal<CommandEntry | null>(null);
  let input!: HTMLInputElement;

  // Asked at each opening, never before (§app.command-palette/opening). The list this tab got last
  // shows meanwhile, and an unchanged answer changes nothing on screen.
  void fetchServedCommands().then(
    (r) => {
      const list = Array.isArray(r?.commands) ? r.commands : [];
      const text = JSON.stringify(list);
      if (lastServed?.text === text) return;
      lastServed = { list, text };
      setServed(list);
    },
    () => {
      if (!lastServed) setServedError(true);
    },
  );

  const views = createMemo(() => viewRows(props.host));
  const dialogs = commandDialogs(props.host);
  const dialogIds = new Set(dialogs.keys());
  // A row that reads the same as before stays the same object, so the list redraws only what changed.
  let previous = new Map<string, PaletteRow>();
  const rows = createMemo(() => {
    const next = new Map<string, PaletteRow>();
    const out = buildRows(views(), served(), props.context(), dialogIds).map((row) => {
      const old = previous.get(row.key);
      const keep = old && sameRow(old, row) ? old : row;
      next.set(row.key, keep);
      return keep;
    });
    previous = next;
    return out;
  });
  const shown = createMemo(() => filterRows(rows(), query()));
  const commandCount = () => rows().filter((r) => r.act.kind === "command").length;

  /** The shown rows by group, in `shown`'s order (the active index's space). */
  const grouped = createMemo(() => {
    const out = new Map<string, PaletteRow[]>();
    for (const row of shown()) out.set(row.group, [...(out.get(row.group) ?? []), row]);
    return GROUPS.filter((g) => out.has(g.id)).map((g) => ({ ...g, rows: out.get(g.id)! }));
  });
  const indexOf = createMemo(() => new Map(shown().map((row, i) => [row, i])));

  // The active row's marks, set on its element alone: one effect for the list, not two per row,
  // so a list of hundreds draws in one pass with nothing reactive inside a row.
  let marked: HTMLElement | null = null;
  createEffect(() => {
    const row = shown()[active()];
    const el = row ? document.getElementById(optionId(row.key)) : null;
    if (marked && marked !== el) {
      marked.removeAttribute("data-active");
      marked.setAttribute("aria-selected", "false");
    }
    if (el) {
      el.setAttribute("data-active", "");
      el.setAttribute("aria-selected", "true");
    }
    marked = el;
  });

  /** One row, drawn once: a row's fields never change (a changed row is a new row). */
  const Option = (p: { row: PaletteRow; id: string }) => {
    // Plain locals, so the compiled row holds no effect of its own.
    const { row, id } = p;
    const { label, keys } = row;
    const desc = row.disabled ?? row.detail;
    const disabled = row.disabled ? "true" : undefined;
    const labelClass = row.act.kind === "chat" ? "palette-option-label palette-option-mono" : "palette-option-label";
    const descClass = !row.disabled && row.act.kind === "command" ? "palette-option-desc palette-option-mono" : "palette-option-desc";
    return (
      <div
        class="palette-option"
        id={id}
        role="option"
        aria-selected="false"
        aria-disabled={disabled}
        onPointerMove={() => {
          const i = indexOf().get(row) ?? NO_ROW;
          if (active() !== i) setActive(i);
        }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => act(row)}
      >
        <span class="palette-option-text">
          <span class={labelClass}>{label}</span>
          {desc ? <span class={descClass}>{desc}</span> : null}
        </span>
        {keys ? <kbd class="palette-option-keys">{keys}</kbd> : null}
      </div>
    );
  };

  const setActiveShown = (i: number) => {
    setActive(i);
    const row = shown()[i];
    if (row) document.getElementById(optionId(row.key))?.scrollIntoView({ block: "nearest" });
  };

  const act = (row: PaletteRow) => {
    if (row.disabled) return;
    const a = row.act;
    if (a.kind === "view") {
      const view = views().find((v) => v.id === a.id);
      props.onClose();
      view?.run();
    } else if (a.kind === "chat") {
      const composer = props.composer();
      props.onClose();
      composer?.insert(a.name);
    } else {
      const own = dialogs.get(a.entry.id);
      if (own) {
        props.onClose();
        own();
      } else setPanel(a.entry);
    }
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActiveShown(moveActive(active(), shown().length, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = enterTarget(shown(), active());
      if (row) act(row);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    if (panel()) {
      setPanel(null);
      queueMicrotask(() => input?.focus());
    } else props.onClose();
  };

  onMount(() => input.focus());

  const activeRow = () => shown()[active()];

  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div class="modal palette" role="dialog" aria-modal="true" aria-labelledby={`palette-title-${uid}`} ref={(el) => trapFocus(el)} onKeyDown={onKeyDown}>
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={`palette-title-${uid}`}>
            Commands
          </h2>
        </div>
        <Show
          when={panel()}
          fallback={
            <>
              <div class="palette-search">
                <input
                  ref={input}
                  class="input"
                  type="text"
                  role="combobox"
                  aria-label="Type a command"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeRow() ? optionId(activeRow()!.key) : undefined}
                  placeholder="Type a command"
                  autocomplete="off"
                  spellcheck={false}
                  value={query()}
                  onInput={(e) => {
                    setQuery(e.currentTarget.value);
                    setActive(NO_ROW); // a new query never leaves a row chosen
                  }}
                  onKeyDown={onListKey}
                />
              </div>
              <div class="palette-list" id={listId} role="listbox" aria-label="Commands">
                <For each={grouped()}>
                  {(g) => (
                    <div role="group" aria-labelledby={`palette-${uid}-g-${g.id}`}>
                      <p class="popover-label" id={`palette-${uid}-g-${g.id}`} role="presentation">
                        {g.label}
                      </p>
                      <For each={g.rows}>{(row) => <Option row={row} id={optionId(row.key)} />}</For>
                    </div>
                  )}
                </For>
                <Show when={!served() && !servedError()}>
                  <p class="palette-note">Loading commands…</p>
                </Show>
                <Show when={servedError()}>
                  <p class="palette-note">Couldn't load the server's commands. Go to and chat rows still work.</p>
                </Show>
                <Show when={query().trim() && shown().length === 0}>
                  <p class="palette-note" role="status">
                    {commandCount()} commands. None match “{query().trim()}”.
                  </p>
                </Show>
              </div>
              <p class="palette-foot">Choose with ↑ ↓, then Enter. Esc closes.</p>
            </>
          }
        >
          {(entry) => (
            <CommandPanel
              entry={entry()}
              context={props.context}
              onBack={() => {
                setPanel(null);
                queueMicrotask(() => input?.focus());
              }}
            />
          )}
        </Show>
      </div>
    </Portal>
  );
}

/** A command's panel (§app.command-palette/command-panel): its form, its button, its answer. */
function CommandPanel(props: { entry: CommandEntry; context(): PaletteContext; onBack(): void }) {
  const uid = createUniqueId();
  const form = formOf(props.entry);
  const [input, setInput] = createSignal<FormInput>({});
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [answer, setAnswer] = createSignal<{ state: AnswerState; text: string } | null>(null);
  const noteId = `palette-arm-${uid}`;
  const session = () => props.context().session;

  const run = async (target: PaletteContext["session"]) => {
    setProblem(null);
    const got = valuesOf(form, input(), target, props.entry.sessionKey);
    if ("error" in got) {
      setProblem(got.error);
      return;
    }
    let req;
    try {
      req = buildRequest(props.entry, got.values);
    } catch (err) {
      setProblem((err as Error).message);
      return;
    }
    setBusy(true);
    setAnswer(null);
    try {
      const res = await runCommandRequest(req.method, req.url, req.body, commandHost(props.entry, target, hostOf));
      const a = answerText(res.status, res.body);
      setAnswer(a);
      announce(a.state === "done" ? "Done." : a.text);
    } finally {
      setBusy(false);
    }
  };

  // The arming holds its session: a run goes there, and the open session changing disarms it.
  const button = createPanelArm({ changes: props.entry.effect === "changes", session, run: (s) => void run(s) });
  const armed = button.armed;
  // Any edit disarms: a run only ever uses the values the armed button stood over.
  const set = (name: string, v: string | boolean) => {
    button.edit();
    setInput((cur) => ({ ...cur, [name]: v }));
  };

  const press = () => {
    if (busy()) return;
    if (button.press() === "armed") announce("Press again to run it.");
  };

  return (
    <div class="modal-body palette-panel">
      <div class="palette-panel-head">
        <h3 class="palette-panel-title">{props.entry.label}</h3>
        <p class="palette-panel-id">{props.entry.id}</p>
        <p>{props.entry.summary}</p>
      </div>
      <form
        class="palette-form"
        onSubmit={(e) => {
          e.preventDefault();
          press();
        }}
      >
        <For each={form.fields}>
          {(f) => {
            const id = `palette-${uid}-${f.name}`;
            const label = (
              <span class="field-label">
                <span class="palette-param">{f.name}</span>
                {f.required ? " (required)" : ""}
              </span>
            );
            if (f.kind === "session")
              return (
                <div class="field">
                  {label}
                  <p class="palette-session">{session()?.title ?? "No session open"}</p>
                </div>
              );
            if (f.kind === "checkbox")
              return (
                <label class="toggle palette-toggle">
                  <input type="checkbox" checked={input()[f.name] === true} onChange={(e) => set(f.name, e.currentTarget.checked)} />
                  <span class="toggle-box" />
                  <span>
                    <span class="palette-param">{f.name}</span> {f.param.description}
                  </span>
                </label>
              );
            return (
              <label class="field" for={id}>
                {label}
                <Show
                  when={f.kind === "select"}
                  fallback={
                    <input
                      id={id}
                      class="input"
                      type={f.kind === "number" ? "number" : "text"}
                      step={f.param.type === "integer" ? "1" : "any"}
                      required={f.required}
                      placeholder={f.param.default}
                      value={(input()[f.name] as string | undefined) ?? ""}
                      onInput={(e) => set(f.name, e.currentTarget.value)}
                    />
                  }
                >
                  <span class="select-wrap">
                    <select id={id} class="select" onChange={(e) => set(f.name, e.currentTarget.value)}>
                      <For each={f.options}>{(o) => <option value={o}>{o || "Leave unset"}</option>}</For>
                    </select>
                  </span>
                </Show>
                <span class="field-hint">
                  {f.param.description}
                  {f.hint ? `. ${f.hint}.` : ""}
                </span>
              </label>
            );
          }}
        </For>
        <Show when={form.leftOut.length}>
          <p class="field-hint">
            The command line takes more: <code>sova run {props.entry.id}</code>
          </p>
        </Show>
        <Show when={problem()}>{(p) => <p class="field-error" role="alert">{p()}</p>}</Show>
        <div class="palette-actions">
          <button type="button" class="button" onClick={() => props.onBack()}>
            Back
          </button>
          <button
            type="submit"
            class="button button-primary"
            aria-describedby={armed() ? noteId : undefined}
            aria-busy={busy() ? "true" : undefined}
            onBlur={() => button.blur()}
          >
            {busy() ? "Running…" : armed() ? `${props.entry.label}?` : props.entry.label}
          </button>
        </div>
        <Show when={armed()}>
          <p class="field-hint" id={noteId}>
            Press again to run it.
          </p>
        </Show>
      </form>
      <Show when={answer()}>
        {(a) => (
          <div class="palette-answer" data-state={a().state}>
            <p class="palette-answer-title">{a().state === "done" ? "Done." : a().text}</p>
            <Show when={a().state === "done" && a().text}>
              <pre class="palette-answer-body" tabindex="0" aria-label="The answer">
                {a().text}
              </pre>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
