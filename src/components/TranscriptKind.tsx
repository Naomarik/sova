import { createMemo, ErrorBoundary, For, lazy, Show, Suspense, untrack, type Component, type JSX } from "solid-js";
import type { RowFacts } from "../../shared/harness-wire";
import { isObj } from "../lib/message";
import { thousands, tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { isErroredTurnStop } from "../lib/turn";
import { rowProvider } from "../lib/subagent-limit";
import type { KindHit, KindView, KindViewProps, LiveInput, LiveKindViewProps, PageView } from "../lib/transcript-kinds";
import type { WakeInfo } from "../../shared/wake";
import type { TopicBatchInfo } from "../../shared/topic-message";
import { InfoRow } from "./InfoRow";
import { PathText } from "./PathAttachment";
import { SubagentLimitRow } from "./SubagentLimitRow";
import { TopicCard } from "./TopicCard";
import { WakeCard } from "./WakeCard";
import { ShellCard } from "./ShellCard";
import { cardOfRow } from "../lib/shell-runs";
import type { ShellRowInfo } from "../../shared/protocol";
import { BUILTIN_VIEWS } from "./BuiltinKinds";
import { LIVE_VIEWS } from "./LiveKinds";
import { Icon } from "./ui";
import { isModuleLoadError } from "../lib/module-load";
import { recheckHost } from "../lib/mesh";

/**
 * The card toolkit's host for one transcript row (§chat.transcript-cards/toolkit): it draws the
 * row's kind's view (lib/transcript-kinds.ts) inside an error box of its own. A view that throws
 * while drawing draws "This card couldn't be drawn: {why}" with Reload in its place, and every
 * other row goes on. Reload draws that card again; it never reloads the page or the chat. A view
 * whose code file can't be loaded (lib/module-load: a rebuild removed it, and the browser keeps a
 * failed load for the page's life) says Sova was updated instead, with Reload Page, and asks the
 * host again so the stale-tab banner rises. The boundary adds nothing to the page while the view
 * draws.
 *
 * A piece of the running turn (`input`, matched by a kind's live form: `hit.live`) is drawn the same
 * way, by its kind's live view (components/LiveKinds.tsx). A host draws a live piece or a settled
 * row for its whole life: the settled row that replaces a live one at the turn's end is a new row.
 */
export function TranscriptKindRow(props: { hit: KindHit; item?: KindViewProps["item"]; input?: LiveInput; limitPath?: string; index?: () => number; reserve?: string }) {
  const live = untrack(() => props.hit.live);
  /** What a live view is given: getters too. */
  const liveProps: LiveKindViewProps = {
    get input() {
      return props.input!;
    },
    get value() {
      return props.hit.value;
    },
  };
  /** What the view is given: getters, so it reads its row and its value as they change. */
  const viewProps: KindViewProps = {
    get item() {
      return props.item!;
    },
    get value() {
      return props.hit.value;
    },
    get limitPath() {
      return props.limitPath;
    },
    get index() {
      return props.index;
    },
  };
  /** The row's view, drawn again only when its kind changes. Made inside the error box, so what it
      throws lands there; Reload makes it again, a module view loaded again with it. */
  const draw = () => {
    const kind = createMemo(() => props.hit.kind);
    return createMemo(() => {
      if (live) {
        const view = LIVE_VIEWS[kind().live!.view] as Component<LiveKindViewProps>;
        return untrack(() => view(liveProps));
      }
      const view = viewComponent(kind().view);
      if (!view) return undefined;
      if (!("load" in kind().view!)) return untrack(() => view(viewProps));
      // A module view: the row holds its reserved height until the module arrives.
      return untrack(() => (
        <Suspense fallback={<div class="kind-pending" style={{ "min-height": props.reserve }} aria-busy="true" />}>{view(viewProps)}</Suspense>
      ));
    });
  };
  return <ErrorBoundary fallback={(err, reset) => <CardFailure error={err} reload={reset} />}>{/* a memo is drawn as a reactive child */ draw() as unknown as JSX.Element}</ErrorBoundary>;
}

/** Why a card couldn't be drawn, in a sentence's words (an Error's message, else the thrown value). */
export const whyOf = (err: unknown): string => {
  const why = err instanceof Error ? err.message : typeof err === "string" ? err : "it failed while drawing";
  return why.trim().replace(/\.$/, "") || "it failed while drawing";
};

/** A card's failure: its code file couldn't be loaded (Sova was updated: Reload Page), or anything else (Reload, that card). */
export function CardFailure(props: { error: unknown; reload: () => void }) {
  if (!isModuleLoadError(untrack(() => props.error))) return <CardErrorBox why={whyOf(props.error)} reload={props.reload} />;
  // The host is asked now, not at its next check: the tab learns at once that it is the older build.
  recheckHost();
  return <NewerSovaBox />;
}

/** A card whose code file this page's build can't load: only the newer page draws it. */
export function NewerSovaBox() {
  return (
    <div class="banner banner-error card-error" role="status">
      <Icon name="alert-circle" class="banner-icon" />
      <div class="banner-main">
        <p class="banner-title">This card needs the newer Sova. Reload the page to draw it.</p>
      </div>
      <div class="banner-action">
        <button type="button" class="button button-sm" onClick={() => location.reload()}>
          Reload Page
        </button>
      </div>
    </div>
  );
}

/** A card's error box: what went wrong, in the error colour, and Reload (§chat.transcript-cards/toolkit). */
export function CardErrorBox(props: { why: string; reload: () => void; /** What couldn't be drawn: a card (the default) or a drawing. */ noun?: "card" | "drawing" }) {
  return (
    <div class="banner banner-error card-error" role="status">
      <Icon name="alert-circle" class="banner-icon" />
      <div class="banner-main">
        <p class="banner-title">This {props.noun ?? "card"} couldn't be drawn: {props.why}.</p>
      </div>
      <div class="banner-action">
        <button type="button" class="button button-sm" onClick={() => props.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

/** A kind's view; a module view is loaded again each time it is made (a Reload after a view threw). */
function viewComponent(view: KindView | undefined): Component<KindViewProps> | undefined {
  if (!view) return undefined;
  if ("page" in view) return PAGE_VIEWS[view.page] as Component<KindViewProps>;
  return lazy(view.load);
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A compaction entry: where it happened in the thread, with its summary on demand. */
function Compaction(props: { compaction: NonNullable<RowFacts["compaction"]> }) {
  const tokens = () => props.compaction.tokensBefore ?? null;
  const details = () => (isObj(props.compaction.details) ? props.compaction.details : {});
  const read = () => strings(details().readFiles);
  const changed = () => strings(details().modifiedFiles);
  return (
    <details class="disclosure compaction">
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="disclosure-label">Compacted</span>
        <span class="disclosure-preview">
          <Show when={tokens() !== null} fallback="· earlier messages summarized">
            · <span class="text-mono">{thousands(tokens()!)}</span> tokens summarized
          </Show>
        </span>
      </summary>
      <div class="disclosure-body">
        <div class="compaction-summary">{props.compaction.summary ?? ""}</div>
        <Show when={read().length > 0}>
          <p class="toolcard-section-label">Files read</p>
          <ul class="compaction-files">
            <For each={read()}>{(f) => <li>{tildePath(f, home())}</li>}</For>
          </ul>
        </Show>
        <Show when={changed().length > 0}>
          <p class="toolcard-section-label">Files changed</p>
          <ul class="compaction-files">
            <For each={changed()}>{(f) => <li>{tildePath(f, home())}</li>}</For>
          </ul>
        </Show>
      </div>
    </details>
  );
}

/** An info row; a turn that ended on an error keeps its "Error: …" row, with the limit row beside it in a held chat. */
function InfoView(props: KindViewProps) {
  return (
    <>
      <InfoRow>
        <PathText text={props.item.text ?? ""} attachments={props.item.attachments} />
      </InfoRow>
      {/* A turn that ended on an error keeps its "Error: …" row (the transcript's
          `${entryId}:stop`); the limit row rides beside it with that turn's own
          provider (the row's `model` — never the session's current one). */}
      <Show when={props.limitPath && isErroredTurnStop(props.item) ? { path: props.limitPath, item: props.item } : null}>
        {(x) => <SubagentLimitRow path={x().path} message={x().item.text?.replace(/^Error: /, "") ?? ""} provider={rowProvider(x().item.model)} />}
      </Show>
    </>
  );
}

/** Sova's own views drawn in the page, by the name a kind gives (lib/transcript-kinds.ts `PageView`). */
export const PAGE_VIEWS: { [K in PageView]: Component<KindViewProps<never>> } = {
  wake: (props: KindViewProps<WakeInfo>) => <WakeCard nudge={props.value} text={props.item.text ?? ""} time={props.item.at} />,
  topic: (props: KindViewProps<TopicBatchInfo>) => <TopicCard batch={props.value} time={props.item.at} />,
  compaction: (props: KindViewProps<NonNullable<RowFacts["compaction"]>>) => <Compaction compaction={props.value} />,
  info: InfoView,
  shell: (props: KindViewProps<ShellRowInfo>) => <ShellCard card={cardOfRow(props.value)} />,
  ...BUILTIN_VIEWS,
};
