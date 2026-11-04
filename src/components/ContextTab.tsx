import { createEffect, createMemo, createResource, createSignal, For, Index, Match, on, Show, Switch } from "solid-js";
import type { TeamInfo, WorkerInfo } from "../../shared/protocol";
import { fetchSessionContextView, fetchSetupFile } from "../lib/api";
import {
  approxTokens,
  contextHeadline,
  contextLayout,
  contextRoom,
  flatParts,
  inWindow,
  meterShares,
  NOT_LOADED_NOTE,
  OTHER_META,
  partLang,
  partMeta,
  partNote,
  partOpens,
  partSubtitle,
  shareOf,
  workerReplyKey,
  type ContextLine,
  type ContextLineKind,
  type ContextPart,
} from "../lib/context-parts";
import { ForKey } from "../lib/for-key";
import { jumpWhenArrived } from "../lib/jump";
import { fileShape, type FileShape, type MarkdownView } from "../lib/markdown-viewer";
import { OPEN_FILE_FAILED } from "../lib/session-setup";
import { toast } from "../lib/ui-state";
import { workerLabel } from "../lib/workers";
import { ReaderDoc, ReaderTools } from "./ReaderDoc";
import { Icon } from "./ui";
import "./ContextTab.css";

/** Below this the session pane is a drawer over the transcript, so a jump closes it (as the Timeline's). */
const DRAWER = "(max-width: 1279px)";

/** A part as read when its level opened: never read again while it stays open. */
interface Doc {
  shape: FileShape;
  markdown: string;
}
/** One level of the sheet: a group, or a part of one with its text. */
type Level = { line: ContextLineKind; label: string } | { line: ContextLineKind; label: string; part: ContextPart; doc: Doc };
const isPart = (l: Level): l is Extract<Level, { part: ContextPart }> => "part" in l;

/** A row's size: a file not yet loaded shows what it would add. */
const sizeOf = (p: ContextPart) => (inWindow(p) ? approxTokens(p.tokens) : `+${approxTokens(p.tokens)}`);
/** Paths and tool names are machine names. */
const monoName = (p: ContextPart) => p.group === "instructions" || p.group === "subfolder" || p.group === "tools";

/**
 * The Context tab: what fills this chat's window (or one of its workers'), as of the last reply.
 * The total is the reply's own usage; each part is an estimate, and Other is what the estimates
 * don't explain. Every top line is a group and opens the same way, whatever it holds: one sheet
 * over the tab, with a breadcrumb and Back, where a group lists its parts and a part reads in
 * place. It reads once on open and again on each change to the session's file (`changed`, the pane's
 * insight signal) and, for a picked worker, when one of its replies ends (`workerReplyKey`); never
 * polls. A part open in the sheet isn't read again.
 */
export function ContextTab(props: { path: string; workers: WorkerInfo[]; teams?: TeamInfo[]; changed: number; onClose?: () => void }) {
  const pickable = () => props.workers.filter((w) => w.sessionFile);
  const [who, setWho] = createSignal(props.path);
  /** The session read: this chat, or the picked worker while it is still listed. */
  const target = createMemo(() => (pickable().some((w) => w.sessionFile === who()) ? who() : props.path));
  /** A picked worker's own reply-end signal: its replies don't move the parent's file. */
  const workerKey = createMemo(() => workerReplyKey(pickable().find((w) => w.sessionFile === target())));
  const [view] = createResource(
    () => `${props.changed}\u0002${workerKey()}\u0001${target()}`,
    (key) => fetchSessionContextView(key.slice(key.indexOf("\u0001") + 1)),
  );
  const ok = createMemo(() => {
    const v = view.latest;
    return v?.state === "ok" ? v : null;
  });
  const layout = createMemo(() => {
    const v = ok();
    return v ? contextLayout({ parts: flatParts(v), conversation: v.conversation, total: v.total, window: v.window }) : null;
  });
  const windowSize = () => ok()?.window ?? null;
  const lineOf = (id: ContextLineKind) => layout()?.lines.find((l) => l.id === id);

  // ---- The sheet ---------------------------------------------------------------------------
  const [stack, setStack] = createSignal<Level[]>([]);
  const [docView, setDocView] = createSignal<MarkdownView>("rendered");
  let root!: HTMLDivElement;
  let back: HTMLButtonElement | undefined;
  let body: HTMLDivElement | undefined;
  /** Bumped by every move, so a slow read that lands after the reader moved on opens nothing. */
  let moves = 0;

  const focusKey = (key: string) => queueMicrotask(() => root?.querySelector<HTMLElement>(`[data-ctx-key="${CSS.escape(key)}"]`)?.focus());
  const opened = () =>
    queueMicrotask(() => {
      if (body) body.scrollTop = 0;
      back?.focus();
    });
  /** Back to `depth` levels (0 closes the sheet); focus returns to the row the first left level was opened from. */
  const backTo = (depth: number) => {
    moves++;
    const left = stack()[depth];
    if (!left) return;
    setStack(stack().slice(0, depth));
    focusKey(isPart(left) ? `part:${left.part.id}` : `line:${left.line}`);
    if (depth > 0) queueMicrotask(() => body && (body.scrollTop = 0));
  };
  const openLine = (l: ContextLine) => {
    moves++;
    setStack([{ line: l.id, label: l.label }]);
    opened();
  };
  const openPart = async (l: Level, p: ContextPart) => {
    const mine = ++moves;
    let text: string;
    if (p.text !== undefined) text = p.text;
    else if (p.path !== undefined) {
      try {
        text = (await fetchSetupFile(target(), p.path)).text;
      } catch (err) {
        toast(`${OPEN_FILE_FAILED} ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (mine !== moves) return;
    } else return;
    setDocView("rendered");
    setStack([...stack(), { line: l.line, label: l.label, part: p, doc: { markdown: text, shape: fileShape(p.path ?? p.id, text, partLang(p)) } }]);
    opened();
  };
  // Another chat or window closes the sheet; so does a fresh read whose group is gone.
  createEffect(on(target, () => setStack([]), { defer: true }));
  createEffect(() => {
    const first = stack()[0];
    if (first && layout() && !lineOf(first.line)) setStack([]);
  });
  const onSheetKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // Taken here, so the pane (which closes on Escape) sees it handled.
    e.preventDefault();
    backTo(stack().length - 1);
  };

  const showInTranscript = () => {
    const start = ok()?.talk?.start;
    if (!start) return;
    const missing = () => toast("That message isn't in the transcript on screen.");
    if (jumpWhenArrived(start, props.path, missing) === "missing") return;
    if (window.matchMedia(DRAWER).matches) props.onClose?.();
  };

  // ---- Rows ---------------------------------------------------------------------------------
  /** One row, the same for a group and a part: name, short line, share of the window, ≈ size, and an
      arrow only when it opens. */
  const Row = (r: { key: string; name: string; mono?: boolean; chip?: { word: string; done: boolean }; meta?: string; share: number | null; size: string; opens: boolean; onOpen?: () => void }) => {
    const inner = () => (
      <>
        <span class="list-main context-row-main">
          <span class="list-title context-row-name" classList={{ "text-mono": !!r.mono }}>
            {r.name}
          </span>
          <Show when={r.chip || r.meta}>
            <span class="context-row-meta">
              <Show when={r.chip}>
                {(c) => (
                  <span class={c().done ? "chip chip-count chip-success" : "chip chip-count"}>
                    <span class="chip-dot" />
                    {c().word}
                  </span>
                )}
              </Show>
              <Show when={r.meta}>
                <span class="context-row-meta-text">{r.meta}</span>
              </Show>
            </span>
          </Show>
          <Show when={r.share !== null}>
            <span class="context-share" aria-hidden="true">
              <span style={{ width: `${r.share}%` }} />
            </span>
          </Show>
        </span>
        <span class="context-row-size">{r.size}</span>
        <Show when={r.opens} fallback={<span class="context-row-chevron" aria-hidden="true" />}>
          <Icon name="chevron-right" small class="context-row-chevron" />
        </Show>
      </>
    );
    return (
      <li>
        <Show when={r.opens} fallback={<div class="list-row context-row context-row-static">{inner()}</div>}>
          <button type="button" class="list-row list-row-interactive context-row" data-ctx-key={r.key} aria-haspopup="dialog" onClick={() => r.onOpen?.()}>
            {inner()}
          </button>
        </Show>
      </li>
    );
  };
  const PartRows = (r: { level: Level; parts: ContextPart[] }) => (
    <ForKey each={r.parts} by={(p) => p.id}>
      {(p) => (
        <Row
          key={`part:${p().id}`}
          name={p().label}
          mono={monoName(p())}
          chip={partMeta(p()).chip}
          meta={partMeta(p()).text || undefined}
          share={shareOf(p().tokens, windowSize(), inWindow(p()))}
          size={sizeOf(p())}
          opens={partOpens(p())}
          onOpen={() => void openPart(r.level, p())}
        />
      )}
    </ForKey>
  );

  // ---- The sheet's levels --------------------------------------------------------------------
  const top = () => stack().at(-1);
  const GroupLevel = (g: { level: Level; line: ContextLine }) => {
    const counted = () => (g.line.notLoadedFrom < 0 ? g.line.parts : g.line.parts.slice(0, g.line.notLoadedFrom));
    const later = () => (g.line.notLoadedFrom < 0 ? [] : g.line.parts.slice(g.line.notLoadedFrom));
    return (
      <>
        <Show when={g.line.meta}>
          <p class="context-sheet-sub">{g.line.meta}</p>
        </Show>
        <Show when={g.line.kind === "conversation" && target() === props.path && ok()?.talk?.start}>
          <div class="context-sheet-actions">
            <button type="button" class="button" onClick={showInTranscript}>
              Show in Transcript
            </button>
          </div>
        </Show>
        <Show when={counted().length > 0}>
          <ul class="list context-list" aria-label={g.line.label}>
            <PartRows level={g.level} parts={counted()} />
          </ul>
        </Show>
        <Show when={later().length > 0}>
          <section class="stack-2" aria-labelledby="context-not-loaded">
            <h4 class="text-eyebrow context-sheet-eyebrow" id="context-not-loaded">
              Not yet loaded · not counted
            </h4>
            <p class="usage-note text-muted">{NOT_LOADED_NOTE}</p>
            <ul class="list context-list" aria-labelledby="context-not-loaded">
              <PartRows level={g.level} parts={later()} />
            </ul>
          </section>
        </Show>
        <Show when={g.line.kind === "instructions" && ok()?.nestedIncomplete}>
          <p class="usage-note text-muted">This list may be incomplete.</p>
        </Show>
      </>
    );
  };
  const PartLevel = (l: { level: Extract<Level, { part: ContextPart }> }) => {
    const note = () => partNote(l.level.part);
    return (
      <>
        <p class="context-sheet-sub" classList={{ "text-mono": l.level.part.path !== undefined }}>
          {partSubtitle(l.level.part, { label: l.level.label })}
        </p>
        <Show when={note()}>
          <p class="usage-note text-muted">{note()}</p>
        </Show>
        <Show when={l.level.doc.shape.kind !== "note"}>
          <div class="context-sheet-actions">
            <ReaderTools shape={l.level.doc.shape} markdown={l.level.doc.markdown} view={docView()} onView={setDocView} full />
          </div>
        </Show>
        <ReaderDoc shape={l.level.doc.shape} markdown={l.level.doc.markdown} view={docView()} />
      </>
    );
  };
  const levelName = (l: Level) => (isPart(l) ? l.part.label : l.label);
  const topMono = () => {
    const t = top();
    return !!t && isPart(t) && monoName(t.part);
  };
  const levelSize = (l: Level) => {
    if (isPart(l)) return sizeOf(l.part);
    const line = lineOf(l.line);
    return line ? approxTokens(line.tokens) : "";
  };

  return (
    <div class="context-tab" ref={root}>
      <div class="session-panel-scroll" tabindex="0" inert={stack().length > 0 ? true : undefined}>
        <div class="stack">
          <Show when={pickable().length > 0}>
            <label class="field">
              <span class="field-label">Whose context</span>
              <span class="select-wrap">
                <select class="select" onChange={(e) => setWho(e.currentTarget.value)}>
                  <option value={props.path} selected={target() === props.path}>
                    This chat
                  </option>
                  <For each={pickable()}>
                    {(w) => (
                      <option value={w.sessionFile} selected={target() === w.sessionFile}>
                        {workerLabel(w, props.teams)}
                      </option>
                    )}
                  </For>
                </select>
                <span class="select-caret" aria-hidden="true">
                  <Icon name="chevron-down" small />
                </span>
              </span>
            </label>
          </Show>

          <Switch>
            <Match when={!view.latest && view.error}>
              <p class="usage-note field-error">Couldn't read this chat's context. {String(view.error instanceof Error ? view.error.message : view.error)}</p>
            </Match>
            <Match when={!view.latest}>
              <p class="usage-note text-muted">Reading this chat's context.</p>
            </Match>
            <Match when={view.latest?.state === "remote"}>
              <p class="usage-note text-muted">This chat runs on another machine, so its context can't be read here.</p>
            </Match>
            <Match when={view.latest?.state === "unavailable" && view.latest}>
              {(v) => <p class="usage-note text-muted">{v().state === "unavailable" ? (v() as { reason: string }).reason : ""}</p>}
            </Match>
            <Match when={ok() && layout()}>
              {(lay) => (
                <section class="stack-2" aria-labelledby="context-window-label">
                  <h3 class="text-eyebrow" id="context-window-label">
                    Context window
                  </h3>
                  <p class="context-headline">
                    {contextHeadline(ok()!.total, ok()!.window)}
                    <Show when={contextRoom(ok()!.total, ok()!.window)}>{(r) => <span class="text-muted"> · {r()}</span>}</Show>
                  </p>
                  <Show when={lay().free !== null}>
                    <div class="context-meter" aria-hidden="true">
                      <For each={meterShares(lay(), windowSize())}>
                        {(s) => <span class="context-meter-part" classList={{ "context-meter-other": s.id === "other" }} style={{ width: `${s.pct}%` }} />}
                      </For>
                    </div>
                  </Show>
                  <p class="usage-note text-muted">
                    {ok()!.total === null ? "Each size below is an estimate (≈)." : "As of the last reply. Each part is an estimate (≈); Other is what the estimates don't explain."}
                    <Show when={!ok()!.prompt}> This chat isn't running here, so its mode, rules and tools are unknown and fall under Other.</Show>
                  </p>
                  <ul class="list context-list" aria-labelledby="context-window-label">
                    <ForKey each={lay().lines} by={(l) => l.id}>
                      {(l) => (
                        <Row
                          key={`line:${l().id}`}
                          name={l().label}
                          meta={l().meta || undefined}
                          share={shareOf(l().tokens, windowSize())}
                          size={approxTokens(l().tokens)}
                          opens={l().parts.length > 0}
                          onOpen={() => openLine(l())}
                        />
                      )}
                    </ForKey>
                  </ul>
                  <Show when={lay().other !== null}>
                    <ul class="list context-list context-apart" aria-label="Other">
                      <Row key="line:other" name="Other" meta={OTHER_META} share={shareOf(lay().other!, windowSize())} size={approxTokens(lay().other!)} opens={false} />
                    </ul>
                  </Show>
                </section>
              )}
            </Match>
          </Switch>
        </div>
      </div>

      <Show when={top()}>
        <div class="context-scrim" aria-hidden="true" onClick={() => backTo(0)} />
        <section class="context-sheet" role="dialog" aria-labelledby="context-sheet-title" onKeyDown={onSheetKey}>
          <header class="context-sheet-head">
            <nav class="context-crumbs" aria-label="Breadcrumb">
              <button ref={back} type="button" class="button button-icon button-ghost" aria-label="Back" title="Back" onClick={() => backTo(stack().length - 1)}>
                <Icon name="chevron-left" />
              </button>
              <ol>
                <li>
                  <button type="button" class="context-crumb" onClick={() => backTo(0)}>
                    Context
                  </button>
                  <span class="context-crumb-sep" aria-hidden="true">
                    ›
                  </span>
                </li>
                <Index each={stack().slice(0, -1)}>
                  {(l, i) => (
                    <li>
                      <button type="button" class="context-crumb" onClick={() => backTo(i + 1)}>
                        {levelName(l())}
                      </button>
                      <span class="context-crumb-sep" aria-hidden="true">
                        ›
                      </span>
                    </li>
                  )}
                </Index>
                <li>
                  <span class="context-crumb-current" aria-current="page">
                    {levelName(top()!)}
                  </span>
                </li>
              </ol>
            </nav>
            <div class="context-sheet-titles">
              <h3 class="context-sheet-title" id="context-sheet-title" classList={{ "text-mono": topMono() }}>
                {levelName(top()!)}
              </h3>
              <span class="context-row-size">{levelSize(top()!)}</span>
            </div>
          </header>
          <div class="context-sheet-body" ref={body} tabindex="0" aria-labelledby="context-sheet-title">
            <Show when={top()} keyed>
              {(t) => (
                <Show when={isPart(t) ? t : null} fallback={<Show when={lineOf(t.line)}>{(line) => <GroupLevel level={t} line={line()} />}</Show>}>
                  {(p) => <PartLevel level={p()} />}
                </Show>
              )}
            </Show>
          </div>
        </section>
      </Show>
    </div>
  );
}
