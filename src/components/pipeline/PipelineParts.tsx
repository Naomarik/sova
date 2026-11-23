import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import type { MarkState, Stage, StageFact } from "../../lib/pipeline";
import { Icon, trapFocus } from "../ui";

/** A step's mark: a check, a cross, a pulsing dot, a dash, or an empty ring (waiting). The word goes with it. */
export function Mark(props: { state: MarkState; late?: boolean }) {
  const word = () => ({ done: "Done", failed: "Failed", running: "Running", waiting: "Waiting", skipped: "Skipped" })[props.state];
  return (
    <span class={`pl-mark is-${props.state}`} classList={{ "is-late": !!props.late }} role="img" aria-label={word()}>
      <Show when={props.state === "done"}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </Show>
      <Show when={props.state === "failed"}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </Show>
      <Show when={props.state === "skipped"}>–</Show>
    </span>
  );
}

export interface TimelineItem {
  key: string;
  state: MarkState;
  title: JSX.Element;
  meta?: JSX.Element;
  body?: JSX.Element;
  /** What the merge thread read before deciding. */
  read?: string[];
  actions?: JSX.Element;
}

/** A vertical run of steps or recorded changes, each with its mark, title, time and line. */
export function Timeline(props: { items: TimelineItem[]; label?: string }) {
  return (
    <ol class="pl-timeline" aria-label={props.label}>
      <For each={props.items}>
        {(it) => (
          <li class="pl-tl-step">
            <Mark state={it.state} />
            <div style={{ "min-width": "0" }}>
              <p class="pl-tl-title">{it.title}</p>
              <Show when={it.meta}>
                <p class="pl-tl-meta">{it.meta}</p>
              </Show>
              <Show when={it.body}>
                <div class="pl-tl-body">{it.body}</div>
              </Show>
              <Show when={it.read?.length}>
                <ul class="pl-tl-read" aria-label="What it read">
                  <For each={it.read}>{(r) => <li>{r}</li>}</For>
                </ul>
              </Show>
              <Show when={it.actions}>
                <div class="pl-tl-actions">{it.actions}</div>
              </Show>
            </div>
          </li>
        )}
      </For>
    </ol>
  );
}

export function Facts(props: { facts: StageFact[] }) {
  return (
    <dl class="pl-facts">
      <For each={props.facts}>
        {(f) => (
          <div>
            <dt>{f.label}</dt>
            <dd classList={{ "pl-mono": !!f.mono }}>{f.value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

/** A stage's or a check's detail: its rule, who acts there, its facts. */
export function StageDetail(props: { stage: Pick<Stage, "name" | "rule" | "facts" | "who">; eyebrow: string; extra?: JSX.Element; /** In a sheet whose head already names it. */ bare?: boolean }) {
  return (
    <div class="pl-detail-card">
      <Show when={!props.bare}>
        <p class="pl-eyebrow">{props.eyebrow}</p>
        <h3 class="pl-detail-card-title">{props.stage.name}</h3>
      </Show>
      <p class="pl-detail-rule">{props.stage.rule}</p>
      <Show when={props.stage.who?.length}>
        <div class="pl-who">
          <p class="pl-eyebrow">Who reviews</p>
          <For each={props.stage.who}>
            {(w) => (
              <div class="pl-who-row">
                <span class="pl-who-badge" classList={{ "is-ai": w.ai }} aria-hidden="true">
                  <Icon name={w.ai ? "worker" : "eye"} small />
                </span>
                <div>
                  <p class="pl-who-name">
                    {w.name} <span class="pl-who-scope">{w.scope}</span>
                  </p>
                  <p class="pl-who-desc">{w.desc}</p>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Facts facts={props.stage.facts} />
      {props.extra}
    </div>
  );
}

/** A sheet over the page for a folded width: the detail a wide screen shows beside the list. Escape or the scrim closes it. */
export function Sheet(props: { title: string; sub?: string; onClose(): void; children: JSX.Element }) {
  const id = `pl-sheet-${Math.random().toString(36).slice(2, 8)}`;
  let opener: Element | null = null;
  onMount(() => (opener = document.activeElement));
  onCleanup(() => (opener as HTMLElement | null)?.focus?.());
  return (
    <>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      >
        <div class="modal-head pl-sheet-head">
          <div style={{ flex: "1", "min-width": "0" }}>
            <h2 class="modal-title" id={id}>
              {props.title}
            </h2>
            <Show when={props.sub}>
              <p class="pl-detail-meta">{props.sub}</p>
            </Show>
          </div>
          <button type="button" class="button button-ghost button-icon" aria-label="Close" onClick={() => props.onClose()}>
            <Icon name="close" small />
          </button>
        </div>
        <div class="modal-body pl-sheet-body">{props.children}</div>
      </div>
    </>
  );
}

/** Whether `el`'s box is at least `px` wide, followed as it resizes (the screen asks its own box, never the window). */
export function createWide(px: number): [() => boolean, (el: HTMLElement) => void] {
  const [wide, setWide] = createSignal(true);
  let ro: ResizeObserver | undefined;
  onCleanup(() => ro?.disconnect());
  return [
    wide,
    (el) => {
      ro?.disconnect();
      ro = new ResizeObserver(() => setWide(el.clientWidth >= px));
      ro.observe(el);
      setWide(el.clientWidth >= px);
    },
  ];
}

/** A status chip: a dot and the word, never hue alone. */
export function ToneChip(props: { tone: "accent" | "success" | "warn" | "error" | "info" | "neutral"; live?: boolean; children: JSX.Element }) {
  return (
    <span class={`chip chip-solid${props.tone === "neutral" ? "" : ` chip-${props.tone}`}`} classList={{ "chip-live": !!props.live }}>
      <i class="chip-dot" />
      {props.children}
    </span>
  );
}
