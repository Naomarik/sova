import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { argsSummary, CODEMODE_TOOL, codemodeDetails, codemodeTally, codemodeTallyText, isObj, str, type CodemodeCall, type CodemodeTally } from "../lib/message";
import { prettyJson } from "../lib/format";
import { highlightByPath } from "../lib/markdown";
import {
  addedFile,
  diffSnippets,
  fromStructuredPatch,
  isStructuredPatch,
  parseUnifiedPatch,
  type FileDiff,
} from "../lib/diff";
import { summaryStats } from "../lib/tool-diff-stats";
import { MEMORY_TOOLS } from "../../shared/memory";
import { copyText } from "../lib/ui-state";
import type { ToolBody } from "../lib/tool-content";
import type { TmpAttachment } from "../../shared/protocol";
import { ImageStrip } from "./ImageStrip";
import { PathAttachment } from "./PathAttachment";
import { DiffStat, DiffView } from "./DiffView";
import { Chip, CopyButton, Icon, type IconName } from "./ui";

/** "none": no result and nothing is streaming, so none is coming. */
export type ToolStatus = "running" | "done" | "error" | "none";

const MAX_LINES = 400;
const HEAD_LINES = 200;

function toolIcon(name: string): IconName {
  if (name === CODEMODE_TOOL) return "code";
  if (MEMORY_TOOLS.includes(name)) return "clock";
  if (name === "bash") return "terminal";
  if (["read", "write", "edit"].includes(name)) return "file";
  if (["grep", "find", "ls"].includes(name)) return "search";
  return "more";
}

interface Code {
  html: string;
  lang: string;
}

/** `{edits:[{oldText,newText}]}`, or the older single `{oldText,newText}`; null if any is malformed. */
function editsOf(args: Record<string, unknown>): { oldText: string; newText: string }[] | null {
  const list: unknown[] = Array.isArray(args.edits) ? args.edits : [args];
  const out: { oldText: string; newText: string }[] = [];
  for (const e of list) {
    const oldText = isObj(e) ? str(e.oldText) : undefined;
    const newText = isObj(e) ? str(e.newText) : undefined;
    if (oldText === undefined || newText === undefined) return null;
    out.push({ oldText, newText });
  }
  return out.length > 0 ? out : null;
}

/**
 * What a write/edit call changed, as a diff; null keeps the JSON view. The result's details win:
 * pi's edit `patch` or Claude Code's `structuredPatch` carry the file's own line numbers. Without
 * them (still streaming, failed, older sessions) an edit diffs its own snippets, unnumbered.
 * `note` says what the diff can't show.
 */
type FileView = { kind: "write" | "edit"; path: string; diff: FileDiff; content?: string; note?: string };

function fileView(name: string, args: unknown, details: unknown): FileView | null {
  const path = isObj(args) ? str(args.path) : undefined;
  if (!isObj(args) || path === undefined) return null;
  const d = isObj(details) ? details : undefined;
  if (name === "write") {
    const content = str(args.content);
    if (content === undefined) return null;
    if (d && isStructuredPatch(d.structuredPatch) && d.structuredPatch.length > 0 && d.created !== true)
      return { kind: "write", path, content, diff: fromStructuredPatch(path, d.structuredPatch) };
    const note = d?.created === true ? undefined : "The whole file as written. If it replaced one, the old content wasn't recorded.";
    return { kind: "write", path, content, diff: addedFile(content, path), note };
  }
  if (name !== "edit") return null;
  const edits = editsOf(args);
  // Copy Code copies what the edit wrote: each replacement's new text, a blank line between.
  const content = edits?.length ? { content: edits.map((e) => e.newText).join("\n\n") } : {};
  const patched = patchDiff(path, d);
  if (patched) return { kind: "edit", path, diff: patched, ...content };
  return edits ? { kind: "edit", path, diff: diffSnippets(edits, path), ...content, note: "Line numbers weren't recorded; each change is shown on its own." } : null;
}

/** The recorded diff of an edit result's details, if it has one for this file. */
function patchDiff(path: string, d: Record<string, unknown> | undefined): FileDiff | null {
  if (!d) return null;
  const patch = str(d.patch);
  if (patch) {
    const [f] = parseUnifiedPatch(patch);
    if (f && f.hunks.length > 0) return { ...f, oldPath: path, newPath: path };
  }
  if (isStructuredPatch(d.structuredPatch) && d.structuredPatch.length > 0) return fromStructuredPatch(path, d.structuredPatch);
  return null;
}

const codeClass = (lang: string) => (lang ? `hljs language-${lang}` : undefined);

interface ToolCardProps {
  name: string;
  args: unknown;
  /** The result's `details`: an edit's recorded patch (pi `patch`, Claude Code `structuredPatch`). */
  details?: unknown;
  /** Raw argument JSON while the model is still streaming it. */
  argsText?: string;
  status: ToolStatus;
  output?: string;
  images?: string[];
  /** /tmp image paths named in the output. */
  attachments?: TmpAttachment[];
  /** A control on the collapsed line, before the status chip (a navigate result's "Go"). */
  action?: JSX.Element;
  /** The folded line as the row carries it, when the arguments aren't on the row. */
  summary?: string;
  /** "+n −m" as the row carries it (with `lazy`, in place of counting `details`). */
  stats?: { added: number; removed: number } | null;
  /** A codemode script's calls as the row carries them (with `lazy`, in place of counting `details`). */
  calls?: CodemodeTally | null;
  /** The arguments, output and details aren't on the row: they come from here, asked for before
      the card is opened (lib/tool-content). */
  lazy?: LazyContent;
}

/** A card's content that its row doesn't carry (ToolContentStore.handle). */
export interface LazyContent {
  body(): ToolBody;
  want(): void;
  hold(): () => void;
  retry(): void;
}

/** How far outside the view a card's content is fetched ahead of an opening. */
const NEAR_VIEW = "1200px 0px";

const observers = new WeakMap<Element, IntersectionObserver>();
const nearCallbacks = new WeakMap<Element, () => void>();
const VIEWPORT = {};

/** The element `el` scrolls in: the transcript's, else the nearest scrolling ancestor, else none
    (the viewport). */
function scrollRoot(el: Element): Element | null {
  const transcript = el.closest(".transcript");
  if (transcript) return transcript;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/** Calls `fn` once, when `el` comes within NEAR_VIEW of its scroll view. Returns the stop. */
function whenNear(el: Element, fn: () => void): () => void {
  if (typeof IntersectionObserver !== "function") {
    fn();
    return () => {};
  }
  const root = scrollRoot(el);
  const key = (root ?? VIEWPORT) as Element;
  let io = observers.get(key);
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io!.unobserve(e.target);
          nearCallbacks.get(e.target)?.();
          nearCallbacks.delete(e.target);
        }
      },
      { root, rootMargin: NEAR_VIEW },
    );
    observers.set(key, io);
  }
  nearCallbacks.set(el, fn);
  io.observe(el);
  return () => {
    io!.unobserve(el);
    nearCallbacks.delete(el);
  };
}

/**
 * A tool call and its result, collapsed to one mono line until opened; returned images stay visible
 * below it. The body (Arguments, Output, their highlighting) is built the first time the card is
 * opened and kept after, like a report's: a long session holds hundreds of closed cards, and their
 * bodies were most of its DOM and all of its highlighting at open. A closed card does no diff or
 * highlighting work: before its first opening there is no body, and after it the body holds what
 * it last drew until the card opens again.
 */
export function ToolCard(props: ToolCardProps) {
  const [opened, setOpened] = createSignal(false);
  const [isOpen, setIsOpen] = createSignal(false);
  const failed = () => props.status === "error";
  // Images the tool returned itself show under the summary row, open or closed.
  const hasImages = () => (props.images?.length ?? 0) > 0;
  const summary = () => props.summary ?? argsSummary(props.args, props.name);
  /** A memory recall (§chat.transcript/recall-rows): a quiet row that reads what it opened, no tool name, no Done. */
  const recall = () => MEMORY_TOOLS.includes(props.name);
  // A codemode script's calls: live from its updates' details, else as its row carries them.
  const tally = createMemo(() => {
    if (props.name !== CODEMODE_TOOL) return "";
    const d = codemodeDetails(props.details);
    return codemodeTallyText(d ? codemodeTally(d.calls) : (props.calls ?? { total: 0, failed: 0, running: 0 }));
  });
  // Counted off the recorded patch only, never a diff of the arguments (a closed card runs none).
  // A lazy row brings its count with it.
  const stats = createMemo(() =>
    props.lazy ? (props.stats ?? null) : props.args === undefined || props.status === "running" ? null : summaryStats(props.name, props.details),
  );
  // A lazy card's content is asked for before it is opened: as it nears the view, or as the pointer
  // or focus reaches it, so opening it draws the body at once.
  let wrap!: HTMLDivElement;
  const want = () => props.lazy?.want();
  onMount(() => {
    if (!props.lazy) return;
    onCleanup(whenNear(wrap.closest(".entry") ?? wrap, want));
  });
  /** The user reaching for it asks again after a failed ahead-of-time fetch. */
  const reach = () => props.lazy && wantAgain(props.lazy);

  // The wrapper stays the same element whether or not images have arrived, so a live card that
  // gains its first image mid-stream keeps its open state.
  return (
    <div class="toolcard" classList={{ "toolcard-recall": recall() }} ref={wrap}>
      <details
        class="toolcard-details"
        onToggle={(e) => {
          const now = e.currentTarget.open;
          setIsOpen(now);
          if (now) setOpened(true);
        }}
      >
        <summary class="toolcard-summary" onPointerEnter={reach} onFocus={reach}>
          <Icon name="chevron-right" small class="icon-twist" />
          <Icon name={toolIcon(props.name)} small />
          <Show when={!recall()}>
            <span class="toolcard-name">{props.name}</span>
          </Show>
          <span class="toolcard-arg" title={summary()}>
            {summary()}
          </span>
          <Show when={tally()}>
            <span class="toolcard-calls">{tally()}</span>
          </Show>
          <Show when={stats()}>{(st) => <DiffStat added={st().added} removed={st().removed} />}</Show>
          {props.action}
          <Switch>
            <Match when={props.status === "running"}>
              <Chip tone="accent" live>
                Running
              </Chip>
            </Match>
            <Match when={props.status === "done" && !recall()}>
              <Chip tone="success">Done</Chip>
            </Match>
            <Match when={failed()}>
              <Chip tone="error">Failed</Chip>
            </Match>
            <Match when={props.status === "none"}>
              <Chip>No result</Chip>
            </Match>
          </Switch>
        </summary>
        <Show when={opened()}>
          <Show when={props.lazy} fallback={<ToolCardBody {...props} live={isOpen()} />}>
            {(lazy) => <LazyBody card={props} lazy={lazy()} live={isOpen()} />}
          </Show>
        </Show>
      </details>
      <Show when={hasImages()}>
        <div class="toolcard-media">
          <ImageStrip images={props.images} where={`from tool result ${props.name}`} />
        </div>
      </Show>
    </div>
  );
}

/** Asks for a card's content, again if the last ask failed. */
const wantAgain = (lazy: LazyContent) => (lazy.body().state === "error" ? lazy.retry() : lazy.want());

/** How long a card opened before its content landed stays quiet before saying it's loading. */
const LOADING_QUIET_MS = 300;

/** A lazy card's body: its content once fetched (held while the card is drawn), else what's
    keeping it. */
function LazyBody(props: { card: ToolCardProps; lazy: LazyContent; live: boolean }) {
  onCleanup(props.lazy.hold());
  wantAgain(props.lazy);
  const [slow, setSlow] = createSignal(false);
  const t = setTimeout(() => setSlow(true), LOADING_QUIET_MS);
  onCleanup(() => clearTimeout(t));
  const body = () => props.lazy.body();
  return (
    <Switch>
      <Match when={(() => { const b = body(); return b.state === "ready" ? b.content : undefined; })()}>
        {(c) => (
          <ToolCardBody
            {...props.card}
            args={c().args !== undefined ? c().args : props.card.args}
            output={c().result ? c().result!.output : props.card.output}
            details={c().result ? c().result!.details : props.card.details}
            live={props.live}
          />
        )}
      </Match>
      <Match when={body().state === "error"}>
        <div class="toolcard-body">
          <div class="toolcard-section">
            <p class="toolcard-note">
              Couldn't load this call's arguments and output. {(body() as { message?: string }).message ?? ""}
            </p>
            <button type="button" class="button button-sm" onClick={() => props.lazy.retry()}>
              Retry
            </button>
          </div>
        </div>
      </Match>
      <Match when={body().state === "missing"}>
        <div class="toolcard-body">
          <p class="toolcard-note">This call is no longer on the session's branch, so its arguments and output can't be shown.</p>
        </div>
      </Match>
      <Match when={slow()}>
        <div class="toolcard-body" role="status">
          <p class="toolcard-note">Loading arguments and output…</p>
        </div>
      </Match>
    </Switch>
  );
}

/** A codemode script's own body, else the tool card's. */
function ToolCardBody(props: ToolCardProps & { live: boolean }) {
  const script = () => (props.name === CODEMODE_TOOL && isObj(props.args) ? str(props.args.code) : undefined);
  return (
    <Show when={script() !== undefined} fallback={<PlainBody {...props} />}>
      <CodemodeBody {...props} script={script()!} />
    </Show>
  );
}

/** The words of a script call's status, as the tool card's chip says them. */
const CALL_CHIP: Record<CodemodeCall["status"], { tone?: "accent" | "success" | "error" | "warn"; word: string }> = {
  running: { tone: "accent", word: "Running" },
  ok: { tone: "success", word: "Done" },
  error: { tone: "error", word: "Failed" },
  cancelled: { tone: "warn", word: "Cancelled" },
};

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/**
 * A codemode call's body (§chat.transcript/codemode-card): the script, highlighted, with Copy; each call it
 * made, from its result's details (pi's record of them), live while it runs; then its output as any tool
 * card shows it, and the file holding all of a cut output. Its images are the card's media strip.
 */
export function CodemodeBody(props: ToolCardProps & { live: boolean; script: string }) {
  const details = createMemo(() => codemodeDetails(props.details));
  const calls = () => details()?.calls ?? [];
  const code = createMemo<Code | null>((prev) => (!props.live ? prev : highlightByPath(props.script, "script.js")), null);
  return (
    <div class="toolcard-body">
      <div class="toolcard-section">
        <div class="toolcard-section-label">
          Script
          <CopyButton label="Copy Script" text={() => props.script} onCopy={(t) => copyText(t, "Copied script.")} />
        </div>
        <pre class="toolcard-output toolcard-code">
          <Show when={code()?.lang} fallback={props.script}>
            <code class={codeClass(code()!.lang)} innerHTML={code()!.html} />
          </Show>
        </pre>
      </div>
      <div class="toolcard-section">
        <div class="toolcard-section-label">Calls</div>
        <Show when={calls().length > 0} fallback={<p class="toolcard-note">{props.status === "running" ? "No calls yet." : "No calls."}</p>}>
          <ol class="codemode-calls">
            <For each={calls()}>
              {(c) => (
                <li class="codemode-call">
                  <div class="codemode-call-head">
                    <span class="codemode-call-name">{c.name}</span>
                    <Show when={c.name.startsWith("models.")}>
                      <span class="codemode-call-kind">model call</span>
                    </Show>
                    <span class="codemode-call-args" title={c.args}>
                      {c.args}
                    </span>
                    <Show when={c.durationMs !== undefined}>
                      <span class="codemode-call-meta">{seconds(c.durationMs!)}</span>
                    </Show>
                    <Show when={c.cost !== undefined}>
                      <span class="codemode-call-meta">{usd(c.cost!)}</span>
                    </Show>
                    <Chip tone={CALL_CHIP[c.status].tone} live={c.status === "running"}>
                      {CALL_CHIP[c.status].word}
                    </Chip>
                  </div>
                  <Show when={c.error}>
                    <p class="codemode-call-error">{c.error}</p>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
      {/* The tool card's own Output and attachments (its body box gives way to this one: base.css). */}
      <PlainBody {...props} outputOnly />
      <Show when={details()?.fullOutputPath}>
        {(path) => <p class="toolcard-path">Full output: {path()}</p>}
      </Show>
    </div>
  );
}

/** Arguments and Output, built once the card is first opened; they follow a streaming call from
    then on while the card is open, and hold still (no diff, no highlighting) while it is closed. */
function PlainBody(props: ToolCardProps & { live: boolean; outputOnly?: boolean }) {
  const [showAll, setShowAll] = createSignal(false);
  const hasArgs = () => !props.outputOnly && (props.args !== undefined || !!props.argsText);
  const failed = () => props.status === "error";
  const lines = () => (props.output ?? "").split("\n");
  const shown = () => (showAll() || lines().length <= MAX_LINES ? props.output : lines().slice(0, HEAD_LINES).join("\n"));
  // Highlighting is string work; memos keep it off unrelated re-renders. Streaming args
  // (props.args still undefined) stay plain JSON text.
  // Each keeps its last value while the card is closed: an update to a closed card waits for it to open.
  const file = createMemo<FileView | null>((prev) => (!props.live ? prev : props.outputOnly || props.args === undefined ? null : fileView(props.name, props.args, props.details)), null);
  const readPath = () => (props.name === "read" && !failed() && isObj(props.args) ? str(props.args.path) : undefined);
  const readCode = createMemo((prev: Code | null): Code | null => {
    if (!props.live) return prev;
    const path = readPath();
    const code = path === undefined ? null : highlightByPath(shown() ?? "", path);
    return code?.lang ? code : null;
  }, null);

  return (
    <div class="toolcard-body">
      <Switch
        fallback={
          <Show when={hasArgs()}>
            <div class="toolcard-section">
              <div class="toolcard-section-label">Arguments</div>
              <pre>{props.args !== undefined ? prettyJson(props.args) : props.argsText}</pre>
            </div>
          </Show>
        }
      >
        <Match when={file()}>
          {(v) => (
            <div class="toolcard-section">
              <div class="toolcard-section-label">
                {v().kind === "write" ? "Content" : "Changes"}
                <Show when={v().content}>
                  {(content) => <CopyButton label="Copy Code" text={() => content()} onCopy={(t) => copyText(t, "Copied code.")} />}
                </Show>
              </div>
              <DiffView file={v().diff} />
              <Show when={v().note}>{(note) => <p class="toolcard-note">{note()}</p>}</Show>
            </div>
          )}
        </Match>
      </Switch>
      <Show when={props.output}>
        <div class="toolcard-section">
          <div class="toolcard-section-label">
            {failed() ? "Error" : "Output"}
            <CopyButton label="Copy Output" text={() => props.output ?? ""} onCopy={(t) => copyText(t, "Copied output.")} />
          </div>
          <Show
            when={readCode()}
            fallback={
              <pre class="toolcard-output" classList={{ "toolcard-output-error": failed() }}>
                {shown()}
              </pre>
            }
          >
            {(code) => (
              <pre class="toolcard-output toolcard-code">
                <code class={codeClass(code().lang)} innerHTML={code().html} />
              </pre>
            )}
          </Show>
          <Show when={!showAll() && lines().length > MAX_LINES}>
            <button type="button" class="button button-sm" onClick={() => setShowAll(true)}>
              Show All {lines().length.toLocaleString("en-US")} Lines
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.attachments && props.attachments.length > 0}>
        <div class="toolcard-section">
          <div class="toolcard-section-label">Attachments · {props.attachments!.length}</div>
          <For each={props.attachments}>
            {(a) => <PathAttachment attachment={a} where={`from tool result ${props.name}`} />}
          </For>
        </div>
      </Show>
    </div>
  );
}
