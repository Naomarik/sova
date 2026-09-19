import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { announcement, toasts } from "../lib/ui-state";
import { Lightbox } from "./Lightbox";

export type IconName =
  | "alert-circle" | "archive" | "arrow-right" | "attach" | "command" | "image" | "attention" | "chat" | "check" | "chevron-down" | "chevron-left"
  | "chevron-right" | "clock" | "close" | "copy" | "file" | "folder" | "info" | "more" | "stop"
  | "plus" | "refresh" | "search" | "terminal" | "gauge" | "worker";

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
export function CopyButton(props: { label: string; text: () => string; onCopy(text: string): Promise<boolean>; iconOnly?: boolean }) {
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
        <button type="button" class="button button-sm button-ghost" onClick={click}>
          <Icon name={copied() ? "check" : "copy"} small />
          {props.label}
        </button>
      }
    >
      <button type="button" class="button button-icon button-ghost" aria-label={props.label} title={props.label} onClick={click}>
        <Icon name={copied() ? "check" : "copy"} />
      </button>
    </Show>
  );
}

/** The single toast stack and the single polite status region, portalled to <body>. */
export function GlobalRegions() {
  return (
    <>
    <Portal>
      <div class="toast-stack">
        <For each={toasts()}>{(t) => <div class="toast"><span class="toast-body">{t.text}</span></div>}</For>
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
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = [...root.querySelectorAll<HTMLElement>("button, input, textarea, select, [href], [tabindex]:not([tabindex='-1'])")].filter(
      (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
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
    // Give focus back only if nothing else claimed it (e.g. a composer that just mounted).
    const active = document.activeElement;
    if (opener?.isConnected && (!active || active === document.body || root.contains(active))) opener.focus();
  });
}
