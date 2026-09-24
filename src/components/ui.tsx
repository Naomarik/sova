import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { pauseCountdown, remaining, resumeCountdown, startCountdown, type Toast } from "../lib/toast";
import { announcement, dismissToast, toasts } from "../lib/ui-state";
import { Lightbox } from "./Lightbox";

export type IconName =
  | "alert-circle" | "archive" | "arrow-right" | "attach" | "branch" | "command" | "image" | "attention" | "chat" | "check" | "chevron-down" | "chevron-left"
  | "chevron-right" | "bell" | "clock" | "close" | "copy" | "external" | "file" | "folder" | "info" | "more" | "stop"
  | "panel-collapse" | "panel-expand" | "pencil" | "plus" | "refresh" | "search" | "shield" | "star" | "undo" | "settings" | "sliders" | "terminal" | "gauge" | "worker";

/** A shipped SVG as a mask over currentColor (base.css `span.icon`). Decorative unless labelled. */
export function Icon(props: { name: IconName; small?: boolean; class?: string }) {
  return (
    <span
      class={`icon${props.small ? " icon-sm" : ""}${props.class ? ` ${props.class}` : ""}`}
      style={{ "--icon": `url(/icons/${props.name}.svg)` }}
      aria-hidden="true"
    />
  );
}

export type Tone = "info" | "warn" | "error" | "success";

const TONE_ICON: Record<Tone, IconName> = {
  info: "info",
  warn: "alert-circle",
  error: "alert-circle",
  success: "info",
};

export function Banner(props: {
  tone: Tone;
  title: JSX.Element;
  body?: JSX.Element;
  action?: JSX.Element;
  icon?: IconName;
}) {
  return (
    <div class={`banner banner-${props.tone}`} role={props.tone === "error" ? "alert" : "status"}>
      <Icon name={props.icon ?? TONE_ICON[props.tone]} class="banner-icon" />
      <div class="banner-main">
        <p class="banner-title">{props.title}</p>
        <Show when={props.body}>
          <p class="banner-body">{props.body}</p>
        </Show>
      </div>
      <Show when={props.action}>
        <div class="banner-action">{props.action}</div>
      </Show>
    </div>
  );
}

export function Chip(props: {
  tone?: Tone | "accent";
  live?: boolean;
  count?: boolean;
  children: JSX.Element;
  title?: string;
}) {
  return (
    <span
      class={`chip${props.tone ? ` chip-${props.tone}` : ""}${props.live ? " chip-live" : ""}${props.count ? " chip-count" : ""}`}
      title={props.title}
    >
      <i class="chip-dot" />
      {props.children}
    </span>
  );
}

/** A neutral aggregate ("3 working"): no dot, no pulse. A link when `href` is set. */
export function CountChip(props: { href?: string; title?: string; children: JSX.Element }) {
  return (
    <Show
      when={props.href}
      fallback={
        <span class="chip chip-count" title={props.title}>
          {props.children}
        </span>
      }
    >
      <a class="chip chip-count" href={props.href} title={props.title}>
        {props.children}
      </a>
    </Show>
  );
}

/** Copy button whose icon turns into a check for 1.5s after a successful copy. */
export function CopyButton(props: {
  label: string;
  text: () => string;
  onCopy(text: string): Promise<boolean>;
  iconOnly?: boolean;
  /** What the copy is for, on hover. Default: none on the labelled button, the label when icon-only. */
  title?: string;
}) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const click = async (e: MouseEvent) => {
    e.preventDefault(); // inside a <summary>-less card section; never toggles anything
    if (await props.onCopy(props.text())) {
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <Show
      when={props.iconOnly}
      fallback={
        <button type="button" class="button button-sm button-ghost" title={props.title} onClick={click}>
          <Icon name={copied() ? "check" : "copy"} small />
          {props.label}
        </button>
      }
    >
      <button type="button" class="button button-icon button-ghost" aria-label={props.label} title={props.title ?? props.label} onClick={click}>
        <Icon name={copied() ? "check" : "copy"} />
      </button>
    </Show>
  );
}

/**
 * One toast, and its own clock. It goes by itself after `timeout` (lib/toast), except that the
 * countdown — and the bar along its foot that shows it — pauses while the pointer is over it or
 * focus is inside it, and resumes with the time that was left.
 */
function ToastItem(props: { toast: Toast }) {
  const t = props.toast;
  let clock = startCountdown(t.timeout, performance.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [hovered, setHovered] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const paused = () => hovered() || focused();
  const arm = () => {
    clearTimeout(timer);
    if (paused()) clock = pauseCountdown(clock, performance.now());
    else {
      clock = resumeCountdown(clock, performance.now());
      timer = setTimeout(() => dismissToast(t.id), remaining(clock, performance.now()));
    }
  };
  arm();
  onCleanup(() => clearTimeout(timer));
  const hover = (on: boolean) => {
    setHovered(on);
    arm();
  };
  return (
    <div
      class="toast"
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
      onFocusIn={() => {
        setFocused(true);
        arm();
      }}
      onFocusOut={(e) => {
        // Moving between Undo and Dismiss is still inside.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setFocused(false);
        arm();
      }}
    >
      <span class="toast-body">{t.text}</span>
      {/* The toast goes first, so a second press can't run the action twice. */}
      <Show when={t.action}>
        {(action) => (
          <>
            <button
              type="button"
              class="button button-sm button-ghost toast-action"
              onClick={() => {
                dismissToast(t.id);
                void action().run();
              }}
            >
              {action().label}
            </button>
            <button type="button" class="button button-icon button-ghost" aria-label="Dismiss" title="Dismiss" onClick={() => dismissToast(t.id)}>
              <Icon name="close" small />
            </button>
          </>
        )}
      </Show>
      <span class="toast-timer" aria-hidden="true" data-paused={paused() ? "" : undefined} style={{ "--toast-ms": `${t.timeout}ms` }} />
    </div>
  );
}

/** The single toast stack and the single polite status region, portalled to <body>. */
export function GlobalRegions() {
  return (
    <>
    <Portal>
      <div class="toast-stack">
        <For each={toasts()}>{(t) => <ToastItem toast={t} />}</For>
      </div>
      <div class="visually-hidden" role="status" aria-live="polite">
        {announcement()}
      </div>
    </Portal>
    <Lightbox />
    </>
  );
}

/** Keeps Tab inside `root` and returns focus to whatever was focused before, on cleanup. */
export function trapFocus(root: HTMLElement) {
  const opener = document.activeElement as HTMLElement | null;
  const focusables = () => [...root.querySelectorAll<HTMLElement>("button, input, textarea, select, [href], [tabindex]:not([tabindex='-1'])")].filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && el.offsetParent !== null,
  );
  const previousTabIndex = root.getAttribute("tabindex");
  if (previousTabIndex === null) root.tabIndex = -1;
  queueMicrotask(() => {
    if (root.isConnected && !root.contains(document.activeElement)) (focusables()[0] ?? root).focus();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = focusables();
    if (focusable.length === 0) {
      e.preventDefault();
      root.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (!focusable.includes(document.activeElement as HTMLElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  root.addEventListener("keydown", onKey);
  onCleanup(() => {
    root.removeEventListener("keydown", onKey);
    if (previousTabIndex === null) root.removeAttribute("tabindex");
    // Give focus back only if nothing else claimed it (e.g. a composer that just mounted).
    const active = document.activeElement;
    if (opener?.isConnected && (!active || active === document.body || root.contains(active))) opener.focus();
  });
}
