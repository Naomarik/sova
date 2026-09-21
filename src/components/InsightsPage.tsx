import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Banner, Icon } from "./ui";

/** ms epoch → ISO, for `relativeTime`/`clockTime` and `title` attributes. */
export const iso = (t: number) => new Date(t).toISOString();

/** Placeholder blocks, shown only once a region has been loading for 300ms. */
export function Skeletons(props: { count: number }) {
  const [show, setShow] = createSignal(false);
  const t = setTimeout(() => setShow(true), 300);
  onCleanup(() => clearTimeout(t));
  return (
    <Show when={show()}>
      <For each={Array.from({ length: props.count })}>{() => <div class="skeleton skeleton-card" />}</For>
    </Show>
  );
}

/**
 * Shell shared by the insights pages (#/usage, #/agents): a `.session-head` with back link,
 * title, meta and a refresh button, then the `.insights` pane with the page's request error on top.
 */
export function InsightsPage(props: {
  title: string;
  /** Head meta line; left out entirely when empty (e.g. nothing loaded yet). */
  meta?: JSX.Element;
  refreshLabel: string;
  onRefresh(): void;
  /** A refresh the button started is in flight: it's disabled and says so until it settles. */
  refreshing?: boolean;
  /** Latest request failure; loaded data stays visible below the banner. */
  error: string | null;
  errorTitle: string;
  /** First load in flight: marks the page body busy for assistive tech. */
  busy: boolean;
  titleRef(el: HTMLHeadingElement): void;
  children: JSX.Element;
}) {
  return (
    <>
      <header class="session-head">
        <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">
          <Icon name="chevron-left" />
        </a>
        <div class="session-head-main">
          <h1 class="session-head-title" tabindex="-1" ref={props.titleRef}>
            {props.title}
          </h1>
          <Show when={props.meta}>
            <p class="session-head-meta">{props.meta}</p>
          </Show>
        </div>
        <button
          type="button"
          class="button button-icon button-ghost"
          aria-label={props.refreshLabel}
          title={props.refreshing ? "Refreshing…" : props.refreshLabel}
          aria-disabled={props.refreshing ? "true" : undefined}
          aria-busy={props.refreshing ? "true" : undefined}
          onClick={() => !props.refreshing && props.onRefresh()}
        >
          <Icon name="refresh" />
        </button>
      </header>
      <section class="insights pane" aria-label={props.title}>
        <div class="insights-inner" aria-busy={props.busy ? "true" : undefined}>
          <Show when={props.error}>
            <Banner
              tone="error"
              title={props.errorTitle}
              body={`Nothing was changed. ${props.error}`}
              action={
                <button type="button" class="button button-sm" aria-disabled={props.refreshing ? "true" : undefined} onClick={() => !props.refreshing && props.onRefresh()}>
                  Retry
                </button>
              }
            />
          </Show>
          {props.children}
        </div>
      </section>
    </>
  );
}
