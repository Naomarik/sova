import { children, createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import type { TmpAttachment, TranscriptItem } from "../../shared/protocol";
import type { LiveBlock, LiveEntry, LiveState } from "../lib/live";
import { prettyJson, shortModel, stampTime, thousands, tildePath } from "../lib/format";
import { isObj, str, timestampOf, toolCallArgs, toolResultView } from "../lib/message";
import { stripPastedPaths } from "../lib/path-attachments";
import { home } from "../lib/ui-state";
import { registerTranscript } from "../lib/jump";
import { usePaneId } from "../lib/pane-scope";
import { isHiddenBlock, liveHiddenCounts, splitHidden, thinkingHiddenLabel, toolsHiddenLabel } from "../lib/hidden-rows";
import { isTurnStart } from "../lib/turn";
import { parseWakeNudge } from "../../shared/wake";
import { ImageStrip } from "./ImageStrip";
import { PathAttachment, PathText } from "./PathAttachment";
import { ReportRow } from "./ReportRow";
import { AlignCard } from "./AlignCard";
import { ExplainCard } from "./ExplainCard";
import { alignOf, latestAlignId } from "../lib/align";
import { explainOf } from "../lib/explain";
import { Markdown } from "./Markdown";
import { ToolCard, type ToolStatus } from "./ToolCard";
import { WakeCard } from "./WakeCard";
import { Banner, Chip, Icon } from "./ui";

function Stamp(props: { iso?: string }) {
  return (
    <Show when={props.iso}>
      <span class="message-time" title={props.iso}>
        {stampTime(props.iso!)}
      </span>
    </Show>
  );
}

function UserTurn(props: { text: string; time?: string; pending?: boolean; images?: string[]; attachments?: TmpAttachment[] }) {
  return (
    <article class="message message-user" aria-label={props.time ? `You, ${stampTime(props.time)}` : "You"}>
      <div class="message-head">
        <span class="message-author">You</span>
        <Stamp iso={props.time} />
        <Show when={props.pending}>
          <span>Sending…</span>
        </Show>
      </div>
      <ImageStrip images={props.images} where="in your message" />
      <For each={props.attachments}>{(a) => <PathAttachment attachment={a} where="in your message" />}</For>
      <Show when={props.text}>
        <div class="message-body message-text">{props.text}</div>
      </Show>
    </article>
  );
}

function AssistantText(props: {
  text: string;
  author: string;
  /** Full "provider/model" behind `author` (its short form), for hover. */
  model?: string;
  time?: string;
  streaming?: boolean;
  showHead: boolean;
  attachments?: TmpAttachment[];
}) {
  return (
    <article
      class="message"
      classList={{ "message-streaming": !!props.streaming }}
      aria-label={props.time ? `${props.author}, ${stampTime(props.time)}` : props.author}
    >
      <Show when={props.showHead || props.streaming}>
        <div class="message-head">
          <span class="message-author text-mono" title={props.model}>{props.author}</span>
          <Show when={props.streaming}>
            <span class="live-dot" />
          </Show>
          <Stamp iso={props.time} />
        </div>
      </Show>
      <Markdown text={props.text} streaming={props.streaming} attachments={props.attachments} />
    </article>
  );
}

function Thinking(props: { text: string; streaming?: boolean }) {
  const preview = () => {
    const first = props.text.trim().split("\n")[0] ?? "";
    return first.length > 80 ? `${first.slice(0, 80)}…` : first;
  };
  return (
    <details class="disclosure">
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="disclosure-label">Thinking</span>
        <Show when={props.streaming}>
          <span class="live-dot" />
        </Show>
        <Show when={preview()}>
          <span class="disclosure-preview">· {preview()}</span>
        </Show>
      </summary>
      <div class="disclosure-body">{props.text}</div>
    </details>
  );
}

export function InfoRow(props: { children: JSX.Element }) {
  return (
    <div class="info-row" role="note">
      <span class="info-row-text">
        <Icon name="info" small />
        <span>{props.children}</span>
      </span>
    </div>
  );
}

function Unknown(props: { raw: unknown }) {
  const type = () => (isObj(props.raw) ? str(props.raw.type) : undefined) ?? "unknown";
  return (
    <div class="stack-2">
      <InfoRow>
        Unrecognized entry <code>{type()}</code>
      </InfoRow>
      <details class="disclosure">
        <summary class="disclosure-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="disclosure-label">Raw entry</span>
        </summary>
        <pre>{prettyJson(props.raw)}</pre>
      </details>
    </div>
  );
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A compaction entry: where it happened in the thread, with its summary on demand. */
function Compaction(props: { raw: Record<string, unknown> }) {
  const tokens = () => (typeof props.raw.tokensBefore === "number" ? props.raw.tokensBefore : null);
  const details = () => (isObj(props.raw.details) ? props.raw.details : {});
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
        <div class="compaction-summary">{str(props.raw.summary) ?? ""}</div>
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

/** "The turn stopped with an error." Kept in the thread, in flow, so it stays in the record. */
export function TurnError(props: { message: string }) {
  return (
    <Banner
      tone="error"
      title="The turn stopped with an error."
      body={`${props.message.replace(/\.$/, "")}. Your messages are kept. Send again to retry.`}
    />
  );
}

/**
 * Stands in for the rows "Hide tool calls" and "Hide thinking" remove: each count, with any
 * failures right after the tool count, and the blocks themselves on demand — so hiding is never a
 * dead end and never hides a failure.
 */
function HiddenRows(props: { calls: number; failed: number; running?: number; thinking: number; children: () => JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <details class="disclosure" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <Show when={props.calls > 0}>
          <span class="disclosure-label">{toolsHiddenLabel(props.calls)}</span>
          <Show when={props.failed > 0}>
            <Chip tone="error">{props.failed} failed</Chip>
          </Show>
          <Show when={props.running}>
            <Chip tone="accent" live>
              {props.running} running
            </Chip>
          </Show>
        </Show>
        <Show when={props.thinking > 0}>
          <span class="disclosure-label">
            {props.calls > 0 ? "· " : ""}
            {thinkingHiddenLabel(props.thinking)}
          </span>
        </Show>
      </summary>
      {/* Mounted only while open: a long session's blocks cost nothing while they're hidden. */}
      <Show when={open()}>
        <div class="disclosure-body stack-2" style={{ "white-space": "normal" }}>
          {props.children()}
        </div>
      </Show>
    </details>
  );
}

/**
 * Renders normalized transcript items. Tool results fold into their call's card. `streaming`
 * says whether a tool without a result may still be running (vs. never got one). `hideTools` and `hideThinking`
 * drops every call with its result and puts one summary row after the rest.
 */
export function HistoryItems(props: {
  items: TranscriptItem[];
  author: string;
  streaming: boolean;
  hideTools?: boolean;
  hideThinking?: boolean;
  /** Index from which a call without a result may still be running; after the last user row by default. */
  openFrom?: number;
}) {
  const split = createMemo(() =>
    props.hideTools || props.hideThinking ? splitHidden(props.items, { tools: !!props.hideTools, thinking: !!props.hideThinking }) : null,
  );
  /** The rows rendered: all of them, or everything but tool rows while they're hidden. */
  const rows = () => split()?.shown ?? props.items;
  const results = createMemo(() => {
    const byCall = new Map<string, TranscriptItem>();
    for (const it of props.items) if (it.kind === "tool-result" && it.toolCallId) byCall.set(it.toolCallId, it);
    return byCall;
  });
  const calls = createMemo(() => {
    const ids = new Set<string>();
    for (const it of props.items) if (it.kind === "tool-call" && it.toolCallId) ids.add(it.toolCallId);
    return ids;
  });
  const latestAlign = createMemo(() => latestAlignId(props.items));
  // Only calls after the last user message (or wake nudge — isTurnStart) can still be in flight.
  const lastUserIndex = createMemo(() => {
    for (let i = props.items.length - 1; i >= 0; i--) if (isTurnStart(props.items[i]!)) return i;
    return -1;
  });
  const openFrom = () => props.openFrom ?? lastUserIndex() + 1;

  return (
    <>
      <For each={rows()}>
        {(item, index) => (
          // A box-less wrapper so the outline strip can find an entry's row (Jump to Message).
          <div class="entry" data-entry={item.id}>
            <Switch fallback={<Unknown raw={item.raw} />}>
              <Match when={item.kind === "user"}>
                <UserTurn text={item.text ?? ""} time={timestampOf(item.raw)} images={item.images} attachments={item.attachments} />
              </Match>
              <Match when={item.kind === "wake" && item.wake}>
                {(wake) => <WakeCard nudge={wake()} text={item.text ?? ""} time={timestampOf(item.raw)} />}
              </Match>
              <Match when={item.kind === "assistant-text"}>
                <AssistantText
                  text={item.text ?? ""}
                  author={shortModel(item.model) ?? props.author}
                  model={item.model}
                  time={timestampOf(item.raw)}
                  showHead={
                    rows()[index() - 1]?.kind !== "assistant-text" || rows()[index() - 1]?.model !== item.model
                  }
                  attachments={item.attachments}
                />
              </Match>
              <Match when={item.kind === "thinking"}>
                <Thinking text={item.text ?? ""} />
              </Match>
              <Match when={item.kind === "report" && item.report && alignOf(item.report)}>
                {(align) => (
                  <Show when={item.id === latestAlign()} fallback={<span class="align-superseded" hidden />}>
                    <AlignCard report={item.report!} align={align()} attachments={item.attachments} />
                  </Show>
                )}
              </Match>
              <Match when={item.kind === "report" && item.report && explainOf(item.report)}>
                {(explain) => <ExplainCard explain={explain()} />}
              </Match>
              <Match when={item.kind === "report" && item.report}>
                {(report) => <ReportRow report={report()} attachments={item.attachments} />}
              </Match>
              <Match when={item.kind === "info" && isObj(item.raw) && item.raw.type === "compaction" && item.raw}>
                {(raw) => <Compaction raw={raw()} />}
              </Match>
              <Match when={item.kind === "info"}>
                <InfoRow>
                  <PathText text={item.text ?? ""} attachments={item.attachments} />
                </InfoRow>
              </Match>
              <Match when={item.kind === "tool-call"}>
                {(() => {
                  const view = () => {
                    const r = item.toolCallId ? results().get(item.toolCallId) : undefined;
                    return r ? toolResultView(r.raw, r.text) : undefined;
                  };
                  const status = (): ToolStatus => {
                    const v = view();
                    if (v) return v.isError ? "error" : "done";
                    return props.streaming && index() >= openFrom() ? "running" : "none";
                  };
                  return (
                    <ToolCard
                      name={item.text ?? "tool"}
                      args={toolCallArgs(item.raw, item.toolCallId)}
                      status={status()}
                      output={view()?.output}
                      images={item.toolCallId ? results().get(item.toolCallId)?.images : undefined}
                      attachments={item.toolCallId ? results().get(item.toolCallId)?.attachments : undefined}
                    />
                  );
                })()}
              </Match>
              <Match when={item.kind === "tool-result"}>
                {/* Paired results render inside their call's card; orphans get their own. */}
                <Show when={!item.toolCallId || !calls().has(item.toolCallId)}>
                  {(() => {
                    const view = toolResultView(item.raw, item.text);
                    return (
                      <ToolCard
                        name="result"
                        args={undefined}
                        status={view.isError ? "error" : "done"}
                        output={view.output}
                        images={item.images}
                        attachments={item.attachments}
                      />
                    );
                  })()}
                </Show>
              </Match>
            </Switch>
          </div>
        )}
      </For>
      <Show when={split()?.hidden.length ? split() : null}>
        {(s) => (
          <HiddenRows calls={s().calls} failed={s().failed} thinking={s().thinking}>
            {() => <HistoryItems items={s().hidden} author={props.author} streaming={props.streaming} openFrom={s().openFrom} />}
          </HiddenRows>
        )}
      </Show>
    </>
  );
}

function LiveBlockView(props: { block: LiveBlock; live: LiveState; author: string; model?: string; streaming: boolean; showHead: boolean }) {
  return (
    <Switch>
      <Match when={props.block.type === "text" && props.block}>
        {(b) => (
          <Show when={b().text}>
            <AssistantText text={b().text} author={props.author} model={props.model} streaming={props.streaming} showHead={props.showHead} />
          </Show>
        )}
      </Match>
      <Match when={props.block.type === "thinking" && props.block}>
        {(b) => <Thinking text={b().text} streaming={props.streaming} />}
      </Match>
      <Match when={props.block.type === "toolCall" && props.block}>
        {(b) => {
          const tool = () => props.live.tools[b().id];
          const status = (): ToolStatus => {
            const t = tool();
            if (t) return t.status;
            return props.live.running ? "running" : "none";
          };
          return (
            <ToolCard
              name={b().name}
              args={b().args ?? tool()?.args}
              argsText={b().argsText}
              status={status()}
              output={tool()?.output}
              images={tool()?.images}
            />
          );
        }}
      </Match>
    </Switch>
  );
}

/** The in-progress run assembled from streaming events. `hideTools` and `hideThinking` drop those
    blocks and put one summary row after the turn, counted from live status. */
export function LiveEntries(props: { live: LiveState; author: string; hideTools?: boolean; hideThinking?: boolean }) {
  const hide = () => ({ tools: !!props.hideTools, thinking: !!props.hideThinking });
  const shows = (b: LiveBlock | undefined) => !!b && !isHiddenBlock(b, hide());
  /** The nearest block before `i` that renders, so a hidden call doesn't repeat the author head. */
  const shownBefore = (blocks: LiveBlock[], i: number) => {
    for (let j = i - 1; j >= 0; j--) if (!isHiddenBlock(blocks[j], hide())) return blocks[j];
    return undefined;
  };
  const hiddenBlocks = () => props.live.entries.flatMap((e) => (e.kind === "assistant" ? e.blocks.filter((b) => isHiddenBlock(b, hide())) : []));
  /** A hidden thinking block still streams (live dot) until its own message is done. */
  const blockDone = (b: LiveBlock) => props.live.entries.some((e) => e.kind === "assistant" && e.done && e.blocks.includes(b));
  const hidden = createMemo(() => (props.hideTools || props.hideThinking ? liveHiddenCounts(props.live, hide()) : null));
  return (
    <>
      <For each={props.live.entries}>
        {(entry: LiveEntry) => (
          <Switch>
            <Match when={entry.kind === "user" && entry}>
              {(e) => (
                <Show
                  when={parseWakeNudge(e().text)}
                  fallback={
                    <UserTurn
                      text={e().attachments ? stripPastedPaths(e().text) : e().text}
                      pending={!e().confirmed}
                      images={e().images}
                      attachments={e().attachments}
                    />
                  }
                >
                  {(wake) => <WakeCard nudge={wake()} text={e().text} />}
                </Show>
              )}
            </Match>
            <Match when={entry.kind === "assistant" && entry}>
              {(e) => (
                <>
                  <For each={e().blocks}>
                    {(block, i) => (
                      <Show when={shows(block)}>
                        <LiveBlockView
                          block={block}
                          live={props.live}
                          author={shortModel(e().model) ?? props.author}
                          model={e().model}
                          streaming={!e().done}
                          showHead={shownBefore(e().blocks, i())?.type !== "text"}
                        />
                      </Show>
                    )}
                  </For>
                  <Show when={e().stoppedAt}>
                    <InfoRow>
                      Stopped by you at <code>{stampTime(e().stoppedAt!)}</code>.
                    </InfoRow>
                  </Show>
                  <Show when={e().error}>
                    <TurnError message={e().error!} />
                  </Show>
                </>
              )}
            </Match>
          </Switch>
        )}
      </For>
      <Show when={hidden()?.calls || hidden()?.thinking ? hidden() : null}>
        {(h) => (
          <HiddenRows calls={h().calls} failed={h().failed} running={h().running} thinking={h().thinking}>
            {() => (
              <For each={hiddenBlocks()}>
                {(b) => <LiveBlockView block={b} live={props.live} author={props.author} streaming={!blockDone(b)} showHead={false} />}
              </For>
            )}
          </HiddenRows>
        )}
      </Show>
    </>
  );
}

/** Within this distance of the end, the transcript follows new content. */
const FOLLOW_PX = 80;

/**
 * The transcript scroll region. Follows new content while the user is near the bottom; scrolling
 * up pauses following and offers "Jump to Latest · N new". Changing `resume` forces following
 * (e.g. after the user sends). `banner` sticks to the top of the region.
 */
export function ThreadScroller(props: {
  children: JSX.Element;
  banner?: JSX.Element;
  /** Number of rendered entries, for the "N new" count. */
  count: number;
  resume?: number;
  busy?: boolean;
  /** The session shown here: what a jump from the outline, Skills or Timeline looks up. */
  path?: string;
}) {
  const paneId = usePaneId();
  let el!: HTMLElement;
  let follow = true;
  const [away, setAway] = createSignal<number | null>(null); // count when the user scrolled away
  // Resolve once: reading a JSX prop twice would build its DOM twice.
  const banner = children(() => props.banner);

  const toBottom = () => {
    el.scrollTop = el.scrollHeight;
  };
  const resumeFollowing = () => {
    follow = true;
    setAway(null);
    toBottom();
  };
  const onScroll = () => {
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
    if (near === follow) return;
    follow = near;
    setAway(near ? null : props.count);
  };

  const observer = new MutationObserver(() => {
    if (follow) toBottom();
  });
  onCleanup(() => observer.disconnect());
  createEffect(on(() => props.resume, resumeFollowing, { defer: true }));

  const newCount = () => {
    const a = away();
    return a === null ? 0 : Math.max(0, props.count - a);
  };

  return (
    <div class="transcript-wrap">
      <section
        class="transcript pane"
        id={paneId("transcript")}
        aria-label="Transcript"
        aria-busy={props.busy ? "true" : undefined}
        tabindex="0"
        ref={(node) => {
          el = node;
          observer.observe(node, { childList: true, subtree: true, characterData: true });
          if (props.path) {
            const path = props.path;
            registerTranscript(path, node);
            onCleanup(() => registerTranscript(path, null));
          }
          queueMicrotask(toBottom);
        }}
        onScroll={onScroll}
      >
        <Show when={banner()}>
          <div class="transcript-banner">{banner()}</div>
        </Show>
        <div class="transcript-inner">
          <div class="thread">{props.children}</div>
        </div>
      </section>
      <Show when={away() !== null}>
        <button type="button" class="button jump-latest" onClick={resumeFollowing}>
          <Icon name="chevron-down" small />
          {newCount() > 0 ? `Jump to Latest · ${newCount()} new` : "Jump to Latest"}
        </button>
      </Show>
    </div>
  );
}

/** Placeholder shaped like what lands (spec/03-transcript.md §3); nothing shows for the first 300ms. */
export function TranscriptSkeleton() {
  const [show, setShow] = createSignal(false);
  const t = setTimeout(() => setShow(true), 300);
  onCleanup(() => clearTimeout(t));
  return (
    <Show when={show()}>
      <div class="skeleton skeleton-bubble" />
      <div class="stack-2">
        <div class="skeleton skeleton-title" />
        <div class="skeleton skeleton-line skeleton-w92" />
        <div class="skeleton skeleton-line skeleton-w78" />
        <div class="skeleton skeleton-line skeleton-w60" />
      </div>
      <div class="skeleton skeleton-row skeleton-w60" />
    </Show>
  );
}
