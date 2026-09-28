import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Banner, Icon } from "./ui";

/** ms epoch → ISO, for `relativeTime`/`clockTime` and `title` attributes. */
export const iso = (t: number) => new Date(t).toISOString();

/**
 * First-load placeholder, shown only once a region has been loading for 300ms: the
 * `.insights-list` it stands in for, a group head over `rows` rows per group.
 */
export function ListSkeleton(props: { groups: number; rows: number }) {
  const [show, setShow] = createSignal(false);
  const t = setTimeout(() => setShow(true), 300);
  onCleanup(() => clearTimeout(t));
  return (
    <Show when={show()}>
      <div class="card insights-list" aria-hidden="true">
        <For each={Array.from({ length: props.groups })}>
          {() => (
            <div class="insights-group">
              <div class="list-group-label insights-group-head">
                <span class="skeleton skeleton-line insights-skeleton-head" />
              </div>
              <div class="list">
                <For each={Array.from({ length: props.rows })}>
                  {() => (
                    <div class="list-row">
                      <span class="skeleton skeleton-line insights-skeleton-row" />
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

/**
 * Shell shared by the insights pages (#/usage, #/agents): a `.session-head` with back link,
 * title, meta and a refresh button, then the `.insights` pane with the page's request error on top.
 */
export function InsightsPage(props: {
  title: string;
  /** The title's tooltip, for a title that may be cut with an ellipsis (a long project name). */
  titleTip?: boolean;
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
  /** Beside the title (a status chip), wrapping under it when narrow; not part of the h1's name. */
  titleAfter?: JSX.Element;
  /** Where the back arrow goes, and its name; default the session list. */
  back?: { href: string; label: string };
  /** Page-specific class on the head and the pane, for a page that lays out its own width. */
  class?: string;
  /** The page's own action in its head, before the refresh button (the project page's Archive Project). */
  actions?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <>
      <header class={props.class ? `session-head ${props.class}` : "session-head"}>
        <a class="button button-icon button-ghost app-back" href={props.back?.href ?? "#/"} aria-label={props.back?.label ?? "Back to Sessions"} title={props.back?.label}>
          <Icon name="chevron-left" />
        </a>
        <div class="session-head-main">
          <Show
            when={props.titleAfter}
            fallback={
              <h1 class="session-head-title" tabindex="-1" ref={props.titleRef} title={props.titleTip ? props.title : undefined}>
                {props.title}
              </h1>
            }
          >
            <div class="session-head-titleline">
              <h1 class="session-head-title" tabindex="-1" ref={props.titleRef} title={props.titleTip ? props.title : undefined}>
                {props.title}
              </h1>
              {props.titleAfter}
            </div>
          </Show>
          <Show when={props.meta}>
            <p class="session-head-meta">{props.meta}</p>
          </Show>
        </div>
        {props.actions}
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
      <section class={props.class ? `insights pane ${props.class}` : "insights pane"} aria-label={props.title}>
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
