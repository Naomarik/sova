import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import type { MemoryLine, MemoryMessage, MemoryOpen, MemoryOutline } from "../../shared/protocol";
import { ApiError, getMemoryOutline, openMemoryLine } from "../lib/api";
import { relativeTime } from "../lib/format";
import { absoluteTime } from "../lib/spend";
import { jumpWhenArrived } from "../lib/jump";
import { KIND_LABEL, lineRange, openLineLabel, outlineHeading, outlineNote, outlineShown } from "../lib/memory-ui";
import { toast } from "../lib/ui-state";
import { Banner, Icon } from "./ui";

/** How often an open section reads the outline again while memory is on. */
const POLL_MS = 10_000;
const DRAWER = "(max-width: 1279px)";

/**
 * The Session tab's Memory section (§app.subagents-pane/memory-outline): the lines the model sees
 * now, oldest first, each opening onto the two lines under it down to the original messages, and
 * each jumping to its first message in the transcript. Read-only.
 */
export function MemoryOutlineSection(props: { path: string; now: number; onClose?: () => void }) {
  const path = createMemo(() => props.path);
  const [open, setOpen] = createSignal(false);
  const [outline, { refetch }] = createResource(path, async (p): Promise<MemoryOutline | null> => {
    try {
      return await getMemoryOutline(p);
    } catch (err) {
      // An older server has no such route, and a file that isn't a session has no memory: no section.
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  });
  /** The last good read, so a failed poll keeps the lines on screen. */
  const shown = createMemo<MemoryOutline | null>((prev) => (outline.state === "ready" ? (outline() ?? null) : (prev ?? null)), null);
  const memoryOn = createMemo(() => shown()?.on ?? false);

  createEffect(
    on([open, memoryOn], ([isOpen, isOn]) => {
      if (!isOpen || !isOn) return;
      const timer = setInterval(() => void refetch(), POLL_MS);
      onCleanup(() => clearInterval(timer));
    }),
  );

  const jump = (line: Pick<MemoryLine, "entryId" | "id" | "n">) => {
    const missing = () => toast("That message isn't in the transcript on screen.");
    if (!line.entryId) return missing();
    if (jumpWhenArrived(line.entryId, props.path, missing) === "missing") return;
    if (window.matchMedia(DRAWER).matches) props.onClose?.();
  };

  return (
    <Switch>
      <Match when={outline.error && !shown()}>
        <Banner
          tone="error"
          title="Couldn't read this chat's memory."
          body="Nothing was changed."
          action={
            <button type="button" class="button button-sm" onClick={() => void refetch()}>
              Try Again
            </button>
          }
        />
      </Match>
      <Match when={outlineShown(shown()) ? shown() : null}>
        {(o) => (
          <details class="disclosure memory-outline" onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary class="disclosure-summary" onClick={() => !open() && void refetch()}>
              <Icon name="chevron-right" small class="icon-twist" />
              <span class="disclosure-label">Memory</span>
              <span class="disclosure-preview">· {outlineHeading(o())}</span>
            </summary>
            <div class="disclosure-body stack-2">
              <Show when={o().status.state !== "off" && o().status.problem}>
                {(p) => <Banner tone="warn" title="Memory can't write summaries right now." body={p()} />}
              </Show>
              <Show when={outlineNote(o())}>{(note) => <p class="list-meta memory-outline-note">{note()}</p>}</Show>
              <Show when={o().lines.length > 0}>
                <ul class="memory-lines" aria-label="Memory lines, oldest first">
                  <For each={o().lines}>{(line) => <LineRow line={line} path={props.path} now={props.now} onJump={jump} />}</For>
                </ul>
              </Show>
            </div>
          </details>
        )}
      </Match>
    </Switch>
  );
}

/** One line: its messages, its text, a disclosure onto what it was made from, and a jump. */
function LineRow(props: { line: MemoryLine; path: string; now: number; onJump(line: MemoryLine): void }) {
  const [expanded, setExpanded] = createSignal(false);
  // Read once, the first time it is opened (again after a failure, on Try Again).
  const [key, setKey] = createSignal<number | null>(null);
  const [opened, { refetch }] = createResource(key, (): Promise<MemoryOpen> => openMemoryLine(props.path, props.line.id, props.line.n));
  const toggle = () => {
    const next = !expanded();
    setExpanded(next);
    if (next && key() === null) setKey(1);
  };
  const range = () => lineRange(props.line);
  return (
    <li class="memory-line">
      <div class="memory-line-row">
        <button
          type="button"
          class="button button-ghost button-icon memory-line-open"
          aria-expanded={expanded() ? "true" : "false"}
          aria-label={openLineLabel(props.line)}
          title={openLineLabel(props.line)}
          onClick={toggle}
        >
          <Icon name="chevron-right" small class="icon-twist" />
        </button>
        <p class="memory-line-main">
          <span class="memory-line-range text-mono">{range()}</span>
          <Show when={props.line.text !== null} fallback={<span class="memory-line-text memory-line-pending">Not summarized yet.</span>}>
            <span class="memory-line-text">{props.line.text}</span>
          </Show>
        </p>
        <button
          type="button"
          class="button button-ghost button-icon memory-line-jump"
          aria-label={`Show ${props.line.n === 1 ? "message" : "messages"} ${range()} in the transcript`}
          title={`Show ${props.line.n === 1 ? "message" : "messages"} ${range()} in the transcript`}
          onClick={() => props.onJump(props.line)}
        >
          <Icon name="arrow-right" small />
        </button>
      </div>
      <Show when={expanded()}>
        <Switch>
          <Match when={opened.loading}>
            <p class="list-meta memory-line-under" role="status">
              Loading…
            </p>
          </Match>
          <Match when={opened.error}>
            <div class="memory-line-under">
              <Banner
                tone="error"
                title="Couldn't open these messages."
                body={String(opened.error instanceof Error ? opened.error.message : opened.error)}
                action={
                  <button type="button" class="button button-sm" onClick={() => void refetch()}>
                    Try Again
                  </button>
                }
              />
            </div>
          </Match>
          <Match when={opened()}>
            {(r) => (
              <Show
                when={"message" in r() ? (r() as { message: MemoryMessage }).message : null}
                fallback={
                  <ul class="memory-lines memory-line-under">
                    <For each={(r() as { lines: MemoryLine[] }).lines}>{(child) => <LineRow line={child} path={props.path} now={props.now} onJump={props.onJump} />}</For>
                  </ul>
                }
              >
                {(m) => (
                  <div class="memory-message memory-line-under">
                    <p class="list-meta">
                      {KIND_LABEL[m().kind]}
                      <Show when={m().at}>
                        {(at) => (
                          <>
                            {" · "}
                            <span title={absoluteTime(at(), props.now)}>{relativeTime(at(), props.now)}</span>
                          </>
                        )}
                      </Show>
                      <Show when={m().page}>{(pg) => <> · part {pg().index + 1} of {pg().of}</>}</Show>
                    </p>
                    <pre class="memory-message-text" tabindex="0">{m().text}</pre>
                  </div>
                )}
              </Show>
            )}
          </Match>
        </Switch>
      </Show>
    </li>
  );
}
