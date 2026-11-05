// The sidebar's landing bar (al_1): the merge queue's landing or a release, as one step-track row in the foot. Three
// forms read one model (lib/landing-bar.ts, fed by lib/landing-bar-store.ts): the desktop row above the foot's rows,
// whose detail opens in place under it; the phone's 44px strip above the foot bar, whose detail is a bottom sheet;
// and the collapsed spine's icon with a status dot, whose detail is a popover beside it.
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { LandingAction, LandingBarModel, LandingChip, LandingProjectBar, LandingSegment } from "../lib/landing-bar";
import { refusal, resumeQueue } from "../lib/merge-queue-client";
import { noteReleaseChanged, releaseRefusal, runReleaseVerb } from "../lib/releases-client";
import { announce, toast } from "../lib/ui-state";
import { Icon, trapFocus } from "./ui";
import "./LandingBar.css";

const CHIP_TONE: Record<LandingChip["tone"], string> = { neutral: "", accent: " chip-accent", warn: " chip-warn", success: " chip-success", error: " chip-error" };

function Chip(props: { chip: LandingChip }) {
  return (
    <span class={`chip landing-chip${CHIP_TONE[props.chip.tone]}`}>
      <Show when={props.chip.tone !== "neutral"}>
        <i class="chip-dot" aria-hidden="true" />
      </Show>
      {props.chip.label}
    </span>
  );
}

/** The step track: one rounded segment per step; the review's marker beside it, never a segment. */
function Track(props: { bar: LandingProjectBar }) {
  return (
    <Show when={props.bar.segments.length > 0 || props.bar.review}>
      <span class="landing-track-row" aria-hidden="true">
        <span class="landing-track">
          <For each={props.bar.segments}>{(s: LandingSegment) => <span class={`landing-seg landing-seg-${s.state}`} style={s.progress !== undefined ? { "--landing-progress": `${Math.round(s.progress * 100)}%` } : undefined} title={s.label} />}</For>
        </span>
        <Show when={props.bar.review}>{(r) => <span class={`landing-review landing-review-${r().state}`}>{r().label}</span>}</Show>
      </span>
    </Show>
  );
}

/** The bar's face: icon, title, sub line, chips, chevron, and the track under the lines. */
function Face(props: { model: LandingBarModel; open: boolean; chevron?: false }) {
  const top = () => props.model.top;
  return (
    <>
      <span class={`landing-icon landing-tone-${top().tone}`} aria-hidden="true">
        <Icon name={top().icon} small />
      </span>
      <span class="landing-lines">
        <span class="landing-head">
          <span class="landing-title">{top().title}</span>
          <span class="landing-chips">
            <Show when={top().needsChip}>{(c) => <Chip chip={c()} />}</Show>
            <Show when={top().chip}>{(c) => <Chip chip={c()} />}</Show>
            <Show when={props.model.moreChip}>{(c) => <Chip chip={c()} />}</Show>
          </span>
        </span>
        <span class="landing-sub">{top().sub}</span>
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
  const others = () => props.model.all.slice(1);
  return (
    <div class="landing-detail" id={props.id}>
      <Show when={props.model.all.length > 1}>
        <p class="landing-detail-project">{top().name}</p>
      </Show>
      <Show when={top().lines.length > 0}>
        <ul class="landing-detail-lines">
          <For each={top().lines}>
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
        <For each={top().actions}>{(a) => <Action action={a} onDone={props.onNavigate} />}</For>
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

/** Desktop: the row above the foot's rows; a click (or Enter) opens the detail in place under it. */
export function LandingBarRow(props: { model: LandingBarModel }) {
  const [open, setOpen] = createSignal(false);
  let wrap: HTMLDivElement | undefined;
  let btn: HTMLButtonElement | undefined;
  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) btn?.focus();
  };
  useDismiss(open, () => [wrap], () => close());
  const id = `landing-detail-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div
      ref={wrap}
      class={`landing-bar landing-bar-${props.model.top.kind}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open()) {
          e.stopPropagation();
          close(true);
        }
      }}
    >
      <button ref={btn} type="button" class="landing-face" aria-expanded={open()} aria-controls={id} aria-label={props.model.name} title={props.model.name} onClick={() => setOpen(!open())}>
        <Face model={props.model} open={open()} />
      </button>
      <Show when={open()}>
        <LandingDetail model={props.model} id={id} onNavigate={() => close()} />
      </Show>
    </div>
  );
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
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
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
  return (
    <>
      <button ref={btn} type="button" class={`landing-strip landing-bar-${props.model.top.kind}`} aria-haspopup="dialog" aria-expanded={open()} aria-label={props.model.name} onClick={() => setOpen(true)}>
        <Face model={props.model} open={open()} />
      </button>
      <Show when={open()}>
        <Overlay label={props.model.top.title} class="modal landing-sheet" onClose={close} scrim>
          <div class="sheet-grip" aria-hidden="true" />
          <div class="landing-sheet-head">
            <Face model={props.model} open chevron={false} />
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
              }}
              class="popover landing-popover"
              role="dialog"
              aria-label={props.model.top.title}
              style={{ left: `${p().left}px`, bottom: `${p().bottom}px` }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  close();
                }
              }}
            >
              <div class="landing-popover-head">
                <Face model={props.model} open chevron={false} />
              </div>
              <LandingDetail model={props.model} onNavigate={() => setAt(null)} />
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}
