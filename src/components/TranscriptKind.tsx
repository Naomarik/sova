import { createMemo, createSignal, ErrorBoundary, For, lazy, Show, Suspense, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { RowFacts } from "../../shared/harness-wire";
import { isObj } from "../lib/message";
import { thousands, tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { isErroredTurnStop } from "../lib/turn";
import { rowProvider } from "../lib/subagent-limit";
import type { KindHit, KindView, KindViewProps, PageView } from "../lib/transcript-kinds";
import type { WakeInfo } from "../../shared/wake";
import type { TopicBatchInfo } from "../../shared/topic-message";
import { InfoRow } from "./InfoRow";
import { PathText } from "./PathAttachment";
import { SubagentLimitRow } from "./SubagentLimitRow";
import { TopicCard } from "./TopicCard";
import { WakeCard } from "./WakeCard";
import { Icon } from "./ui";

/**
 * The card toolkit's host for one transcript row (§chat.transcript-cards/toolkit): it draws the
 * row's kind's view (lib/transcript-kinds.ts) inside an error box of its own. A view that throws
 * while drawing, or whose module fails to load, draws "This card couldn't be drawn: {why}" with
 * Reload in its place, and every other row goes on. Reload draws that card again (a module view
 * is loaded again); it never reloads the page or the chat. The boundary adds nothing to the page
 * while the view draws.
 */
export function TranscriptKindRow(props: { hit: KindHit; item: KindViewProps["item"]; limitPath?: string; reserve?: string }) {
  const [attempt, setAttempt] = createSignal(0);
  const view = createMemo((): Component<KindViewProps> | undefined => {
    attempt();
    return viewComponent(props.hit.kind.view);
  });
  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <CardErrorBox
          why={whyOf(err)}
          reload={() => {
            setAttempt((n) => n + 1);
            reset();
          }}
        />
      )}
    >
      <Show when={props.hit.kind.view && "load" in props.hit.kind.view} fallback={<Dynamic component={view()} item={props.item} value={props.hit.value} limitPath={props.limitPath} />}>
        {/* A module view: the row holds its reserved height until the module arrives. */}
        <Suspense fallback={<div class="kind-pending" style={{ "min-height": props.reserve }} aria-busy="true" />}>
          <Dynamic component={view()} item={props.item} value={props.hit.value} limitPath={props.limitPath} />
        </Suspense>
      </Show>
    </ErrorBoundary>
  );
}

/** Why a card couldn't be drawn, in a sentence's words (an Error's message, else the thrown value). */
export const whyOf = (err: unknown): string => {
  const why = err instanceof Error ? err.message : typeof err === "string" ? err : "it failed while drawing";
  return why.trim().replace(/\.$/, "") || "it failed while drawing";
};

/** A card's error box: what went wrong, in the error colour, and Reload (§chat.transcript-cards/toolkit). */
export function CardErrorBox(props: { why: string; reload: () => void }) {
  return (
    <div class="banner banner-error card-error" role="status">
      <Icon name="alert-circle" class="banner-icon" />
      <div class="banner-main">
        <p class="banner-title">This card couldn't be drawn: {props.why}.</p>
      </div>
      <div class="banner-action">
        <button type="button" class="button button-sm" onClick={() => props.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

/** A module view, loaded once per attempt: a failed load is tried again on Reload, never cached. */
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
};
