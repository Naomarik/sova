/**
 * `vis matrix` view: an HTML table; marks are a glyph plus a hidden word, never hue alone. A marked
 * row or column is tinted and its header carries the note's number. From three columns up, a phone
 * gets one card per row (column names inline) instead of a table that scrolls sideways.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import { EmBadge, emClass } from "../../emphasis";
import type { ViewProps } from "../../types";
import { fontsLoaded } from "../../svg";
import { clearWidths, MATRIX_NARROW, matrixColumns } from "./height";
import type { CellMark, MatrixSpec } from "./parse";
import "./matrix.css";

const MARK_TEXT: Record<CellMark, string> = { yes: "Yes", no: "No", partial: "Partly" };

export default function MatrixView(props: ViewProps<MatrixSpec>) {
  const em = createMemo(() => emphasisMap(props.spec));
  const col = (i: number) => em().get(`c${i}`);
  // Column shares from the text's widths: measured again once the web font loads.
  let wrapEl!: HTMLDivElement;
  const [width, setWidth] = createSignal(560);
  // The first measure happens in onMount, before the browser paints.
  onMount(() => {
    const fit = () => setWidth(Math.floor(wrapEl.clientWidth || 560));
    const ro = new ResizeObserver(fit);
    ro.observe(wrapEl);
    fit();
    onCleanup(() => ro.disconnect());
  });
  const cards = () => width() <= MATRIX_NARROW && props.spec.columns.length >= 3;
  const cols = createMemo(() => (fontsLoaded() && clearWidths(), matrixColumns(props.spec, width())));
  return (
    <div ref={wrapEl} class="vis-matrix-wrap" classList={{ "vis-matrix-many": props.spec.columns.length >= 3 }} tabindex="0" role="region" aria-label={`${props.label} (scrolls sideways)`}>
      {/* Cards (matrix.css' container query, the same width test) take no table width. */}
      <table class="vis-matrix" style={cards() ? undefined : { width: `${cols().reduce((a, b) => a + b, 0)}px` }}>
        <colgroup>
          <For each={cols()}>{(px) => <col style={{ width: `${px}px` }} />}</For>
        </colgroup>
        <thead>
          <tr>
            <td class="vis-matrix-corner" />
            <For each={props.spec.columns}>
              {(c, i) => (
                <th scope="col" class={emClass(col(i()))}>
                  <EmBadge e={col(i())} />
                  {c}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.spec.rows}>
            {(r, ri) => (
              <tr class={emClass(em().get(String(ri())))}>
                <th scope="row">
                  <EmBadge e={em().get(String(ri()))} />
                  {r.label}
                </th>
                <For each={r.cells}>
                  {(c, i) => (
                    <td class={col(i()) ? `vis-matrix-col-em vis-tone-${col(i())!.tone}` : ""}>
                      <span class="vis-matrix-col" aria-hidden="true">
                        {props.spec.columns[i()]}
                      </span>
                      <span class="vis-matrix-cell">
                        <Show when={c.mark}>
                          <Glyph mark={c.mark!} />
                          <span class="visually-hidden">{MARK_TEXT[c.mark!]}</span>
                        </Show>
                        <Show when={c.text}>
                          <span class="vis-cell-text">{c.text}</span>
                        </Show>
                        <Show when={!c.mark && !c.text}>
                          <span class="vis-cell-empty" aria-label="None">
                            —
                          </span>
                        </Show>
                      </span>
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

/** Yes: a check. No: a cross. Partly: a half-filled circle. Drawn inline, in currentColor. */
function Glyph(props: { mark: CellMark }) {
  return (
    <svg class={`vis-cell-mark vis-cell-mark-${props.mark}`} viewBox="0 0 16 16" aria-hidden="true">
      {props.mark === "yes" ? (
        <path d="M3 8.5 L6.5 12 L13 4.5" />
      ) : props.mark === "no" ? (
        <path d="M4 4 L12 12 M12 4 L4 12" />
      ) : (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path class="vis-cell-mark-half" d="M8 2.5 A5.5 5.5 0 0 0 8 13.5 Z" />
        </>
      )}
    </svg>
  );
}
