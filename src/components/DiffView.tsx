import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { readKey, writeKey } from "../lib/storage-keys";
import { BIG_DIFF_ROWS, filePath, renderFile, viewKey, type FileDiff, type RenderedGap, type RenderedRow, type SplitRow } from "../lib/diff";
import "../design/diff.css";

export type DiffLayout = "unified" | "split";

const LAYOUT_KEY = "sova:diff-layout";
const store = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

/** Unified or Split, remembered on this device; Split applies only where a view is wide enough. */
export const [diffLayout, setDiffLayoutSignal] = createSignal<DiffLayout>(store() && readKey(store()!, LAYOUT_KEY) === "split" ? "split" : "unified");
export function setDiffLayout(layout: DiffLayout): void {
  setDiffLayoutSignal(layout);
  const s = store();
  if (s) writeKey(s, LAYOUT_KEY, layout);
}

/** Split's default minimum: the view's own width, in px (the transcript column's). */
export const SPLIT_MIN_WIDTH = 900;

/** "+12 −4", coloured. */
export function DiffStat(props: { added: number; removed: number; class?: string }) {
  return (
    <span class={`diff-stat text-num${props.class ? ` ${props.class}` : ""}`} aria-label={`${props.added} added, ${props.removed} removed`}>
      <span class="diff-stat-add">+{props.added}</span> <span class="diff-stat-del">−{props.removed}</span>
    </span>
  );
}

/** The Unified / Split pair. Split is disabled, with its reason, when `splitAllowed` is false. */
export function DiffLayoutToggle(props: { layout: DiffLayout; splitAllowed: boolean; onChange: (l: DiffLayout) => void }) {
  const split = () => props.layout === "split" && props.splitAllowed;
  return (
    <span class="diff-layout" role="group" aria-label="Diff layout">
      <button type="button" class="diff-layout-button" aria-pressed={split() ? "false" : "true"} onClick={() => props.onChange("unified")}>
        Unified
      </button>
      <button
        type="button"
        class="diff-layout-button"
        aria-pressed={split() ? "true" : "false"}
        disabled={!props.splitAllowed}
        title={props.splitAllowed ? undefined : "Too narrow for two sides"}
        onClick={() => props.onChange("split")}
      >
        Split
      </button>
    </span>
  );
}

/** A path with its folder muted; a rename reads "old → new". */
export function DiffPath(props: { file: FileDiff }) {
  const parts = (p: string) => {
    const at = p.lastIndexOf("/");
    return { dir: at >= 0 ? p.slice(0, at + 1) : "", base: at >= 0 ? p.slice(at + 1) : p };
  };
  const one = (p: string) => (
    <>
      <span class="diff-path-dir">{parts(p).dir}</span>
      {parts(p).base}
    </>
  );
  return (
    <span class="diff-path" title={props.file.status === "R" ? `${props.file.oldPath} → ${props.file.newPath}` : filePath(props.file)}>
      <Show when={props.file.status === "R" && props.file.oldPath && props.file.newPath} fallback={one(filePath(props.file))}>
        {one(props.file.oldPath!)} → {one(props.file.newPath!)}
      </Show>
    </span>
  );
}

export interface DiffViewProps {
  file: FileDiff;
  /** Only these hunks (indices into file.hunks), in file order: a step's share of the file. All when omitted. */
  hunks?: readonly number[];
  /** The view's own width, in px, below which Split is off. */
  splitMinWidth?: number;
  /** The header row (path, +n −m, Unified/Split). Default shown. */
  header?: boolean;
  /** Replaces the plain path in the header (a link to the file, say). */
  title?: JSX.Element;
  /** Extra header content, after the stat. */
  headerExtra?: JSX.Element;
  /** A controlled layout; the remembered one when omitted. */
  layout?: DiffLayout;
  onLayout?: (l: DiffLayout) => void;
  /** Changed rows past which the diff waits behind "Load Diff". */
  bigRows?: number;
  /** For a file without its whole text: a fold asks for it with `load` (which comes back as
      `file.oldText`); `state` "none" means there is none to have, and folds stay closed. */
  context?: { state: ContextState; load(): void };
  class?: string;
}

export type ContextState = "idle" | "loading" | "error" | "none";

/**
 * One file's diff: two line-number columns and a sign gutter (never selected, so a copy is code
 * only), word marks on paired changed lines, unchanged runs folded (expanding in place when the
 * whole text is known, or can be asked for), Unified or Split. n / p move between hunks while the
 * view has focus.
 */
export function DiffView(props: DiffViewProps) {
  let root!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  onMount(() => {
    setWidth(root.clientWidth);
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? root.clientWidth));
    ro.observe(root);
    onCleanup(() => ro.disconnect());
  });
  const layout = () => props.layout ?? diffLayout();
  const setLayout = (l: DiffLayout) => (props.onLayout ? props.onLayout(l) : setDiffLayout(l));
  const splitAllowed = () => width() >= (props.splitMinWidth ?? SPLIT_MIN_WIDTH);
  const split = () => layout() === "split" && splitAllowed();

  const shownHunks = () => (props.hunks ? props.hunks.map((i) => props.file.hunks[i]).filter((h) => h !== undefined) : props.file.hunks);
  const stats = createMemo(() => {
    if (!props.hunks) return { added: props.file.added, removed: props.file.removed };
    let added = 0;
    let removed = 0;
    for (const h of shownHunks()) for (const r of h.rows) r.kind === "add" ? added++ : r.kind === "del" && removed++;
    return { added, removed };
  });
  const [loaded, setLoaded] = createSignal(false);
  const big = () => stats().added + stats().removed > (props.bigRows ?? BIG_DIFF_ROWS);
  const model = createMemo(() => (big() && !loaded() ? null : renderFile(props.file, props.hunks)));
  const numWidth = createMemo(() => {
    let max = 1;
    for (const h of props.file.hunks) max = Math.max(max, h.oldStart + h.oldLines, h.newStart + h.newLines);
    const m = props.file.oldText !== undefined ? props.file.oldText.split("\n").length : 0;
    return `${String(Math.max(max, m)).length}ch`;
  });

  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const unfold = (key: string) => setOpen((s) => new Set(s).add(key));

  let cur = -1;
  // A view handed another file starts over: its "Load Diff" guard and its folds. The key is a
  // memo, so the same file read again (or given its whole text) keeps them.
  const key = createMemo(() => viewKey(props.file, props.hunks));
  createEffect(
    on(
      key,
      () => {
        setLoaded(false);
        setOpen(new Set<string>());
        cur = -1;
      },
      { defer: true },
    ),
  );
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || (e.key !== "n" && e.key !== "p")) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable]")) return;
    const hunks = [...root.querySelectorAll<HTMLElement>("[data-hunk]")];
    if (hunks.length === 0) return;
    e.preventDefault();
    const at = hunks.findIndex((h) => h.contains(t));
    if (at >= 0) cur = at;
    cur = e.key === "n" ? Math.min(hunks.length - 1, cur + 1) : Math.max(0, cur - 1);
    const el = hunks[cur]!;
    el.focus({ preventScroll: true });
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div
      ref={root}
      class={`diff${props.class ? ` ${props.class}` : ""}`}
      classList={{ "diff-split": split(), "diff-unnumbered": !props.file.numbered }}
      style={{ "--diff-num-w": numWidth() }}
      tabindex="0"
      aria-label={`Changes to ${filePath(props.file)}. n and p move between hunks.`}
      onKeyDown={onKeyDown}
    >
      <Show when={props.header !== false}>
        <div class="diff-head">
          {props.title ?? <DiffPath file={props.file} />}
          <DiffStat added={stats().added} removed={stats().removed} />
          {props.headerExtra}
          <DiffLayoutToggle layout={layout()} splitAllowed={splitAllowed()} onChange={setLayout} />
        </div>
      </Show>
      <Show
        when={model()}
        fallback={
          <button type="button" class="diff-fold diff-load" onClick={() => setLoaded(true)}>
            Load Diff ({(stats().added + stats().removed).toLocaleString("en-US")} lines)
          </button>
        }
      >
        {(m) => (
          <Show when={m().hunks.length > 0} fallback={<p class="diff-empty">{emptyNote(props.file)}</p>}>
            <div class="diff-body">
              <For each={m().hunks}>
                {(h, k) => (
                  <>
                    <Show when={h.gapBefore} fallback={<Show when={k() > 0 || !props.file.numbered}><HunkBreak heading={h.hunk.heading} first={k() === 0} /></Show>}>
                      {(g) => <Gap gap={g()} heading={h.hunk.heading} open={open().has(`b${h.index}`)} onOpen={() => unfold(`b${h.index}`)} split={split()} context={props.context} />}
                    </Show>
                    <div class="diff-hunk" data-hunk={h.index} tabindex="-1">
                      <Show when={split()} fallback={<Index each={h.rows}>{(r) => <UnifiedRow row={r()} />}</Index>}>
                        <Index each={h.split}>{(r) => <SplitLine row={r()} />}</Index>
                      </Show>
                    </div>
                  </>
                )}
              </For>
              <Show when={m().gapAfter}>
                {(g) => <Gap gap={g()} heading="" open={open().has("after")} onOpen={() => unfold("after")} split={split()} context={props.context} />}
              </Show>
            </div>
          </Show>
        )}
      </Show>
    </div>
  );
}

function emptyNote(f: FileDiff): string {
  if (f.binary) return "Binary file, not shown.";
  if (f.status === "R") return "Renamed, with no line changes.";
  if (f.status === "A") return "Empty new file.";
  if (f.status === "D") return "Deleted an empty file.";
  return "No line changes.";
}

const plural = (n: number) => `${n.toLocaleString("en-US")} unchanged ${n === 1 ? "line" : "lines"}`;

/** Between hunks of a snippet diff, or two hunks of a step that aren't neighbours: a rule, with git's heading if any. */
function HunkBreak(props: { heading: string; first: boolean }) {
  return (
    <Show when={props.heading || !props.first}>
      <div class="diff-fold diff-fold-static">{props.heading ? `⋯ ${props.heading}` : "⋯"}</div>
    </Show>
  );
}

/** Folded unchanged lines: a button that shows them in place when their text is known or can be
    asked for (it then opens once the text arrives), a note when it can't. */
function Gap(props: { gap: RenderedGap; heading: string; open: boolean; onOpen: () => void; split: boolean; context?: DiffViewProps["context"] }) {
  const label = () => `${plural(props.gap.count)}${props.heading ? ` · ${props.heading}` : ""}`;
  const askable = () => !props.gap.rows && !!props.context && props.context.state !== "none";
  const reading = () => props.open && askable() && props.context!.state === "loading";
  const show = () => {
    props.onOpen();
    if (!props.gap.rows) props.context?.load();
  };
  return (
    <Show
      when={props.open && props.gap.rows}
      fallback={
        <Show when={(props.gap.rows || askable()) && !reading()} fallback={<div class="diff-fold diff-fold-static">⋯ {reading() ? `Reading ${label()}…` : label()}</div>}>
          <button
            type="button"
            class="diff-fold"
            title={props.context?.state === "error" && !props.gap.rows ? "Couldn't read the file's lines. Try again." : undefined}
            onClick={show}
          >
            ⋯ Show {label()}
          </button>
        </Show>
      }
    >
      {(rows) => {
        const list = rows()();
        return (
          <div class="diff-context">
            <Show when={props.split} fallback={<Index each={list}>{(r) => <UnifiedRow row={r()} />}</Index>}>
              <Index each={list}>{(r) => <SplitLine row={{ left: r(), right: r() }} />}</Index>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

const SIGN = { ctx: " ", add: "+", del: "−" } as const;

function UnifiedRow(props: { row: RenderedRow }) {
  return (
    <div class={`diff-row diff-${props.row.kind}`} title={props.row.noEol ? "No newline at end of file" : undefined}>
      <span class="diff-num" aria-hidden="true">{props.row.oldNo ?? ""}</span>
      <span class="diff-num" aria-hidden="true">{props.row.newNo ?? ""}</span>
      <span class="diff-sign" aria-hidden="true">{SIGN[props.row.kind]}</span>
      <span class="diff-code" innerHTML={props.row.html} />
    </div>
  );
}

function Half(props: { row: RenderedRow | null; side: "old" | "new" }) {
  return (
    <Show when={props.row} fallback={<div class="diff-half diff-filler" />}>
      {(r) => (
        <div class={`diff-half diff-${r().kind}`}>
          <span class="diff-num" aria-hidden="true">{(props.side === "old" ? r().oldNo : r().newNo) ?? ""}</span>
          <span class="diff-sign" aria-hidden="true">{SIGN[r().kind]}</span>
          <span class="diff-code" innerHTML={r().html} />
        </div>
      )}
    </Show>
  );
}

function SplitLine(props: { row: SplitRow }) {
  return (
    <div class="diff-row diff-srow">
      <Half row={props.row.left} side="old" />
      <Half row={props.row.right} side="new" />
    </div>
  );
}
