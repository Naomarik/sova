// The sidebar's landing bar (al_1): the merge queue's landing or a release, as one step-track row in the foot. Three
// forms read one model (lib/landing-bar.ts, fed by lib/landing-bar-store.ts): the desktop row above the foot's rows
// and the phone's strip above the foot bar, both one 44px row (a hover or a press-and-hold shows a small card with a
// little more; a click opens the detail, floating above the row on the desktop, a bottom sheet on the phone); and
// the collapsed spine's icon with a status dot, whose detail is a popover beside it.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { FLOAT_GAP_MOUSE, FLOAT_GAP_TOUCH, floatAbove } from "../lib/float-card";
import { createHoldGesture } from "../lib/hold-select";
import type { LandingAction, LandingBarModel, LandingProjectBar, LandingSegment } from "../lib/landing-bar";
import { refusal, resumeQueue } from "../lib/merge-queue-client";
import { noteReleaseChanged, releaseRefusal, runReleaseVerb } from "../lib/releases-client";
import { announce, toast } from "../lib/ui-state";
import { Icon, trapFocus } from "./ui";
import "./LandingBar.css";

/** The list with each item that is unchanged since the last read kept as the same object, so <For> keeps its DOM:
    the model is rebuilt every second, and a rebuilt link loses focus and a rebuilt running segment restarts its pulse. */
function stable<T>(list: () => readonly T[]): () => T[] {
  let prev = new Map<string, T>();
  return createMemo(() => {
    const next = new Map<string, T>();
    const out = list().map((x, i) => {
      const k = `${i}:${JSON.stringify(x)}`;
      const kept = prev.get(k) ?? x;
      next.set(k, kept);
      return kept;
    });
    prev = next;
    return out;
  });
}

/** The step track: one rounded segment per step. The review is never on it (the detail and the hover card say it). */
function Track(props: { bar: LandingProjectBar }) {
  const segments = stable(() => props.bar.segments);
  return (
    <Show when={props.bar.segments.length > 0}>
      <span class="landing-track-row" aria-hidden="true">
        <span class="landing-track">
          <For each={segments()}>{(s: LandingSegment) => <span class={`landing-seg landing-seg-${s.state}`} style={s.progress !== undefined ? { "--landing-progress": `${Math.round(s.progress * 100)}%` } : undefined} title={s.label} />}</For>
        </span>
      </span>
    </Show>
  );
}

/** The bar's face: icon, then one line (title · sub line · the count), the track under it; chevron at the end. The
    row's form cuts every part to that one line; `full` (the sheet's and the popover's head) lets the words wrap whole
    and says the count in words. */
function Face(props: { model: LandingBarModel; open: boolean; chevron?: false; full?: true }) {
  const top = () => props.model.top;
  return (
    <>
      <span class={`landing-icon landing-tone-${top().tone}`} aria-hidden="true">
        <Icon name={top().icon} small />
      </span>
      <span class="landing-lines">
        <span class="landing-line1">
          <span class="landing-title">{top().title}</span>
          <span class="landing-sub">{top().sub}</span>
          <Show when={top().count}>
            {(c) => (
              <span class="chip landing-count" aria-hidden="true">
                {props.full ? c().label : c().text}
              </span>
            )}
          </Show>
        </span>
        <Track bar={top()} />
      </span>
      <Show when={props.chevron !== false}>
        <span class={`landing-chevron${props.open ? " landing-chevron-open" : ""}`} aria-hidden="true">
          <Icon name="chevron-down" small />
        </span>
      </Show>
    </>
  );
}

/** The hover card: the whole title and sub line, the step and its time, the next in line, the note (two lines at
    most), the other busy projects. The drag ghost's floating card with a neutral edge (lib/float-card.ts), above the
    row. `aria-hidden`: the row's own name and its detail carry every fact. */
function PeekCard(props: { model: LandingBarModel; x: number; y: number; touch: boolean }) {
  let el: HTMLDivElement | undefined;
  const top = () => props.model.top;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  createEffect(() => {
    void JSON.stringify(props.model);
    if (el) setSize({ width: el.offsetWidth, height: el.offsetHeight });
  });
  const at = createMemo(() => floatAbove({ x: props.x, y: props.y }, size(), { width: innerWidth, height: innerHeight }, props.touch ? FLOAT_GAP_TOUCH : FLOAT_GAP_MOUSE));
  return (
    <Portal>
      <div ref={el} class="landing-peek" classList={{ "landing-peek-below": at().y > props.y }} style={{ transform: `translate3d(${at().x}px, ${at().y}px, 0)` }} aria-hidden="true">
        <div class="float-card float-card-neutral landing-peek-card">
          <span class="landing-peek-title">{top().title}</span>
          <span class="landing-peek-sub landing-peek-line">{top().sub}</span>
          <For each={top().peek}>{(l) => <span class={`landing-peek-line${l.mono ? " landing-line-mono" : ""}${l.tone ? ` landing-line-${l.tone}` : ""}`}>{l.text}</span>}</For>
          <Show when={top().count}>{(c) => <span class="landing-peek-line">{c().label[0]!.toUpperCase() + c().label.slice(1)}</span>}</Show>
          <Show when={props.model.more > 0}>
            <span class="landing-peek-line">
              {props.model.more} more project{props.model.more === 1 ? "" : "s"} busy
            </span>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

/** How long a mouse rests on the row before its card shows. */
const PEEK_DELAY_MS = 350;

/** The row's hover card: a mouse resting on it, or a thumb or pen held on it 500ms (the session rows' hold, whose click
    and context menu are swallowed). Gone on leaving, letting go, a click, Escape, or while `suppress()`. */
function usePeek(suppress: () => boolean) {
  const [peek, setPeek] = createSignal<{ x: number; y: number; touch: boolean } | null>(null);
  let el: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = { x: 0, y: 0 };
  const stopTimer = () => timer !== undefined && (clearTimeout(timer), (timer = undefined));
  const hide = () => {
    stopTimer();
    setPeek(null);
  };
  const hold = createHoldGesture({
    onHold: () => {
      if (suppress() || !el) return;
      navigator.vibrate?.(10);
      const r = el.getBoundingClientRect();
      setPeek({ x: r.left + r.width / 2, y: last.y, touch: true });
    },
  });
  createEffect(() => suppress() && hide());
  createEffect(() => {
    if (!peek()) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", key);
    onCleanup(() => document.removeEventListener("keydown", key));
  });
  onCleanup(hide);
  const bind = {
    ref: (e: HTMLElement) => (el = e),
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || suppress()) return;
      stopTimer();
      timer = setTimeout(() => {
        timer = undefined;
        if (!el || suppress()) return;
        const r = el.getBoundingClientRect();
        setPeek({ x: r.left + r.width / 2, y: r.top, touch: false });
      }, PEEK_DELAY_MS);
    },
    onPointerLeave: (e: PointerEvent) => e.pointerType === "mouse" && hide(),
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === "mouse") return hide();
      last = { x: e.clientX, y: e.clientY };
      hold.start(last);
    },
    onPointerMove: (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      last = { x: e.clientX, y: e.clientY };
      hold.move(last);
    },
    onPointerUp: (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      hold.finish();
      if (peek()?.touch) setPeek(null);
    },
    onPointerCancel: () => {
      hold.cancel();
      if (peek()?.touch) setPeek(null);
    },
    onContextMenu: (e: MouseEvent) => hold.suppressed() && e.preventDefault(),
  };
  /** A click the hold left behind: swallowed. */
  const echo = () => hold.suppressed();
  return { peek, hide, bind, echo };
}

/** One action: in place (Resume Queue, Continue, Retry Step) or a link to the tab that takes it. */
function Action(props: { action: LandingAction; onDone?: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const run = async (a: Exclude<LandingAction, { kind: "link" }>) => {
    if (busy()) return;
    setBusy(true);
    try {
      if (a.kind === "resume") {
        const r = await resumeQueue(a.root);
        const no = refusal(r);
        if (no) toast(no);
        else announce("Resumed the merge queue.");
      } else {
        const verb = a.kind === "continue" ? "release.continue" : "release.retry";
        const r = await runReleaseVerb(a.root, verb, { release: a.release, step: a.step });
        noteReleaseChanged();
        const no = releaseRefusal(r);
        if (no) toast(no);
        else announce(a.kind === "continue" ? `Continued after ${a.stepLabel}.` : `Retrying ${a.stepLabel}.`);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const a = props.action;
  if (a.kind === "link")
    return (
      <a class={`button button-sm${a.primary ? " button-primary" : ""}`} href={a.href} onClick={() => props.onDone?.()} {...(a.href.startsWith("http") ? { target: "_blank", rel: "noopener" } : {})}>
        {a.label}
      </a>
    );
  const name = a.kind === "resume" ? a.label : a.kind === "continue" ? `Continue after ${a.stepLabel}` : `Retry ${a.stepLabel}`;
  return (
    <button type="button" class="button button-sm button-primary" aria-label={name} aria-busy={busy() ? "true" : undefined} aria-disabled={busy() ? "true" : undefined} onClick={() => void run(a)}>
      {a.label}
    </button>
  );
}

/** The detail: the top project's lines and actions, then every other busy project, one line each. */
export function LandingDetail(props: { model: LandingBarModel; onNavigate?: () => void; id?: string }) {
  const top = () => props.model.top;
  const others = stable(() => props.model.all.slice(1));
  const lines = stable(() => props.model.top.lines);
  const actions = stable(() => props.model.top.actions);
  return (
    <div class="landing-detail" id={props.id}>
      <Show when={props.model.all.length > 1}>
        <p class="landing-detail-project">{top().name}</p>
      </Show>
      <Show when={top().lines.length > 0}>
        <ul class="landing-detail-lines">
          <For each={lines()}>
            {(l) => (
              <li class={`landing-line${l.mono ? " landing-line-mono" : ""}${l.tone ? ` landing-line-${l.tone}` : ""}`}>
                <Show when={l.href} fallback={l.text}>
                  {(h) => (
                    <a href={h()} onClick={() => props.onNavigate?.()}>
                      {l.text}
                    </a>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="landing-actions">
        <For each={actions()}>{(a) => <Action action={a} onDone={props.onNavigate} />}</For>
      </div>
      <Show when={others().length > 0}>
        <ul class="landing-detail-others" aria-label="Other busy projects">
          <For each={others()}>
            {(b) => (
              <li class="landing-other">
                <span class={`landing-other-dot landing-tone-${b.tone}`} aria-hidden="true" />
                <span class="landing-other-text">{b.oneLine}</span>
                <Show when={b.actions.find((a) => a.kind === "link")}>
                  {(a) => (
                    <a class="landing-other-link" href={(a() as Extract<LandingAction, { kind: "link" }>).href} onClick={() => props.onNavigate?.()}>
                      {a().label}
                    </a>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** Closes on Escape, or a pointer down outside `within`, while `open`. */
function useDismiss(open: () => boolean, within: () => (HTMLElement | undefined)[], close: () => void) {
  onMount(() => {
    const down = (e: PointerEvent) => {
      if (!open()) return;
      const t = e.target as Node | null;
      if (t && within().some((el) => el?.contains(t))) return;
      close();
    };
    document.addEventListener("pointerdown", down, true);
    onCleanup(() => document.removeEventListener("pointerdown", down, true));
  });
}

/** Desktop: one 44px row above the foot's rows; a click (or Enter) opens the detail floating above it, over the
    session list, so nothing in the sidebar moves. Escape or a click away closes it and focus goes back to the row. */
export function LandingBarRow(props: { model: LandingBarModel }) {
  const [open, setOpen] = createSignal<{ left: number; width: number; bottom: number; maxHeight: number } | null>(null);
  let wrap: HTMLDivElement | undefined;
  let btn: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  const { peek, hide, bind, echo } = usePeek(() => !!open());
  const place = () => {
    const r = wrap!.getBoundingClientRect();
    return { left: r.left + 4, width: r.width - 8, bottom: Math.max(8, innerHeight - r.top + 4), maxHeight: Math.max(120, r.top - 12) };
  };
  const close = (refocus = false) => {
    setOpen(null);
    if (refocus) btn?.focus();
  };
  useDismiss(() => !!open(), () => [wrap, panel], () => close());
  onMount(() => {
    const moved = () => open() && setOpen(place());
    addEventListener("resize", moved);
    onCleanup(() => removeEventListener("resize", moved));
  });
  const id = `landing-detail-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div ref={wrap} class={`landing-bar landing-bar-${props.model.top.kind}`}>
      <button
        ref={(e) => {
          btn = e;
          bind.ref(e);
        }}
        type="button"
        class="landing-face landing-row"
        aria-expanded={!!open()}
        aria-controls={id}
        aria-haspopup="dialog"
        aria-label={props.model.name}
        onPointerEnter={bind.onPointerEnter}
        onPointerLeave={bind.onPointerLeave}
        onPointerDown={bind.onPointerDown}
        onPointerMove={bind.onPointerMove}
        onPointerUp={bind.onPointerUp}
        onPointerCancel={bind.onPointerCancel}
        onContextMenu={bind.onContextMenu}
        onClick={(e) => {
          if (echo()) return e.preventDefault();
          hide();
          setOpen(open() ? null : place());
        }}
      >
        <Face model={props.model} open={!!open()} />
      </button>
      <Show when={peek()}>{(p) => <PeekCard model={props.model} x={p().x} y={p().y} touch={p().touch} />}</Show>
      <Show when={open()}>
        {(o) => (
          <Portal>
            <div
              ref={(el) => {
                panel = el;
                trapFocus(el);
                holdFocus(el, () => close(true));
              }}
              id={id}
              class="popover landing-float"
              role="dialog"
              aria-label={props.model.top.title}
              style={{ left: `${o().left}px`, width: `${o().width}px`, bottom: `${o().bottom}px`, "max-height": `${o().maxHeight}px` }}
            >
              <div class="landing-popover-head">
                <Face model={props.model} open chevron={false} full />
              </div>
              <LandingDetail model={props.model} onNavigate={() => close()} />
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}

/** While `el` is open: focus goes into it on every open (once its portal has put it in the page), and Escape closes
    it wherever focus is (a tap may leave focus on the page, not inside). Call from its ref. */
function holdFocus(el: HTMLElement, close: () => void): void {
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  document.addEventListener("keydown", key, true);
  onCleanup(() => document.removeEventListener("keydown", key, true));
  requestAnimationFrame(() => {
    if (!el.isConnected || el.contains(document.activeElement)) return;
    (el.querySelector<HTMLElement>("a[href], button:not([disabled])") ?? el).focus();
  });
}

/** A bottom sheet or a popover, trapped, closing on the scrim, Escape or a link; focus goes back to its opener. */
function Overlay(props: { label: string; class: string; onClose: () => void; children: JSX.Element; style?: JSX.CSSProperties; scrim: boolean }) {
  return (
    <Portal>
      <Show when={props.scrim}>
        <div class="scrim" onClick={() => props.onClose()} />
      </Show>
      <div
        class={props.class}
        role="dialog"
        aria-modal={props.scrim ? "true" : undefined}
        aria-label={props.label}
        style={props.style}
        ref={(el) => {
          trapFocus(el);
          holdFocus(el, () => props.onClose());
        }}
      >
        {props.children}
      </div>
    </Portal>
  );
}

/** Phone (<768px): a 44px strip directly above the foot bar; a tap opens the detail as a bottom sheet. */
export function LandingStrip(props: { model: LandingBarModel }) {
  const [open, setOpen] = createSignal(false);
  let btn: HTMLButtonElement | undefined;
  const close = () => {
    setOpen(false);
    btn?.focus();
  };
  const { peek, hide, bind, echo } = usePeek(open);
  return (
    <>
      <button
        ref={(e) => {
          btn = e;
          bind.ref(e);
        }}
        type="button"
        class={`landing-strip landing-row landing-bar-${props.model.top.kind}`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-label={props.model.name}
        onPointerEnter={bind.onPointerEnter}
        onPointerLeave={bind.onPointerLeave}
        onPointerDown={bind.onPointerDown}
        onPointerMove={bind.onPointerMove}
        onPointerUp={bind.onPointerUp}
        onPointerCancel={bind.onPointerCancel}
        onContextMenu={bind.onContextMenu}
        onClick={(e) => {
          if (echo()) return e.preventDefault();
          hide();
          setOpen(true);
        }}
      >
        <Face model={props.model} open={open()} />
      </button>
      <Show when={peek()}>{(p) => <PeekCard model={props.model} x={p().x} y={p().y} touch={p().touch} />}</Show>
      <Show when={open()}>
        <Overlay label={props.model.top.title} class="modal landing-sheet" onClose={close} scrim>
          <div class="sheet-grip" aria-hidden="true" />
          <div class="landing-sheet-head">
            <Face model={props.model} open chevron={false} full />
          </div>
          <LandingDetail model={props.model} onNavigate={() => setOpen(false)} />
        </Overlay>
      </Show>
    </>
  );
}

/** Collapsed (the spine): one icon with a status dot; it opens the same detail as a popover beside the spine. */
export function LandingSpineButton(props: { model: LandingBarModel; class?: string }) {
  const [at, setAt] = createSignal<{ left: number; bottom: number } | null>(null);
  let btn: HTMLButtonElement | undefined;
  const toggle = () => {
    if (at()) return close();
    const r = btn!.getBoundingClientRect();
    setAt({ left: r.right + 8, bottom: Math.max(8, innerHeight - r.bottom) });
  };
  const close = () => {
    setAt(null);
    btn?.focus();
  };
  const dot = () => (props.model.top.tone === "accent" ? "live" : props.model.top.tone);
  let pop: HTMLDivElement | undefined;
  useDismiss(() => !!at(), () => [btn, pop], () => setAt(null));
  return (
    <>
      <button ref={btn} type="button" class={`button button-icon ${props.class ?? ""} landing-spine`} aria-haspopup="dialog" aria-expanded={!!at()} title={props.model.name} aria-label={props.model.name} onClick={toggle}>
        <Icon name={props.model.top.icon} />
        <span class={`landing-spine-dot landing-spine-dot-${dot()}`} aria-hidden="true" />
      </button>
      <Show when={at()}>
        {(p) => (
          <Portal>
            <div
              ref={(el) => {
                pop = el;
                trapFocus(el);
                holdFocus(el, close);
              }}
              class="popover landing-popover"
              role="dialog"
              aria-label={props.model.top.title}
              style={{ left: `${p().left}px`, bottom: `${p().bottom}px` }}
            >
              <div class="landing-popover-head">
                <Face model={props.model} open chevron={false} full />
              </div>
              <LandingDetail model={props.model} onNavigate={() => setAt(null)} />
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}
