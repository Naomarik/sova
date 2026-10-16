/**
 * `vis steps` view, in the layout layout.ts picks for the measured content width:
 * - side: a table, one bordered column per row with its head on top, step N of every row on one
 *   line, neighbouring equal steps one chip across their columns with arrows running into it;
 * - grid: a list of bordered rows, a 144px label column, then the steps in equal columns so step N
 *   of every row lines up, and the outcomes in a column at the right;
 * - rail: a list of rows, the label above its steps numbered down a rail, a shared start and a run
 *   of `_` each folded into one line.
 */
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import type { Tone } from "../../core/grammar";
import { emphasisMap } from "../../core/emphasis";
import { EmBadge, emClass } from "../../emphasis";
import type { ViewProps } from "../../types";
import { TONE_ICON, TONE_WORD, visIcon } from "../../icons";
import { connectors, gridCols, monoPieces, range, railLines, sideLines, stepRuns, stepsLayout, type Step } from "./layout";
import type { StepsOutcome, StepsRow, StepsSpec } from "./parse";
import "./steps.css";

function ToneIcon(props: { tone: Tone | null | undefined }) {
  return (
    <Show when={props.tone && TONE_ICON[props.tone]}>
      <span class="icon" role="img" aria-label={TONE_WORD[props.tone!]} style={{ "--icon": `url("${visIcon(TONE_ICON[props.tone!]!)}")` }} />
    </Show>
  );
}

/** A step's text: body runs as text, mono runs (ids, hashes, paths) breaking only after their dashes. */
function StepText(props: { text: string }) {
  return (
    <span class="vis-steps-text">
      <For each={stepRuns(props.text)}>
        {(run) =>
          run.mono ? (
            <span class="vis-steps-mono">
              <For each={monoPieces(run.text)}>{(piece, i) => (i() ? [<wbr />, piece] : piece)}</For>
            </span>
          ) : (
            run.text
          )
        }
      </For>
    </span>
  );
}

/** A step's chip; `who` names the rows a shared chip stands for, for screen readers. */
function Chip(props: { step: Step; who?: string }) {
  const tone = () => props.step.tone;
  return (
    <span class={`vis-steps-chip${tone() ? ` vis-steps-toned vis-tone-${tone()}` : ""}`}>
      <ToneIcon tone={tone()} />
      <Show when={props.who}>
        <span class="vis-steps-sr">{props.who}: </span>
      </Show>
      <Show when={tone() && !TONE_ICON[tone()!]}>
        <span class="vis-steps-sr">{TONE_WORD[tone()!]}: </span>
      </Show>
      <StepText text={props.step.text} />
    </span>
  );
}

function Outcome(props: { outcome: StepsOutcome; class?: string }) {
  return (
    <span class={`vis-steps-out${props.outcome.tone ? ` vis-tone-${props.outcome.tone}` : ""}${props.class ? ` ${props.class}` : ""}`}>
      <ToneIcon tone={props.outcome.tone} />
      <span class="vis-steps-sr">Outcome: </span>
      <span class="vis-steps-text">{props.outcome.text}</span>
    </span>
  );
}

/** The row's status mark and label, with a marked row's note number. */
function Head(props: { row: StepsRow; e: ReturnType<ReturnType<typeof emphasisMap>["get"]>; tag?: "columnheader" }) {
  const tone = () => props.row.tone;
  return (
    <span class="vis-steps-head">
      <span class={`vis-steps-status vis-tone-${tone() ?? "none"}`} classList={{ "vis-steps-status-plain": !tone() || !TONE_ICON[tone()!] }} role={tone() ? "img" : undefined} aria-label={tone() ? TONE_WORD[tone()!] : undefined}>
        <Show when={tone() && TONE_ICON[tone()!]}>
          <span class="icon icon-sm" style={{ "--icon": `url("${visIcon(TONE_ICON[tone()!]!)}")` }} aria-hidden="true" />
        </Show>
      </span>
      <span class="vis-steps-label">
        <EmBadge e={props.e} />
        {props.row.label}
      </span>
    </span>
  );
}

export default function StepsView(props: ViewProps<StepsSpec>) {
  const em = createMemo(() => emphasisMap(props.spec));
  // The layout follows the content width: measured before the first paint, and again on resize.
  let wrapEl!: HTMLDivElement;
  const [width, setWidth] = createSignal(560);
  onMount(() => {
    const fit = () => setWidth(Math.floor(wrapEl.clientWidth || 560));
    const ro = new ResizeObserver(fit);
    ro.observe(wrapEl);
    fit();
    onCleanup(() => ro.disconnect());
  });
  const layout = createMemo(() => stepsLayout(props.spec, width()));
  return (
    <div ref={wrapEl} class="vis-steps-wrap">
      {/* One component per layout: each draws its own structure, so a layout change redraws it whole. */}
      <Switch>
        <Match when={layout() === "side"}>
          <Side spec={props.spec} label={props.label} em={em()} />
        </Match>
        <Match when={layout() === "grid"}>
          <Rows spec={props.spec} label={props.label} em={em()} rail={false} width={width()} />
        </Match>
        <Match when={layout() === "rail"}>
          <Rows spec={props.spec} label={props.label} em={em()} rail width={width()} />
        </Match>
      </Switch>
    </div>
  );
}

type Em = ReturnType<typeof emphasisMap>;

function Side(props: { spec: StepsSpec; label: string; em: Em }) {
  const rows = createMemo(() => props.spec.items.flatMap((it, i) => (it.type === "row" ? [{ row: it, key: String(i) }] : [])));
  const lines = createMemo(() => sideLines(rows().map((r) => r.row)));
  const outcomes = () => rows().some((r) => r.row.outcome);
  // Grid lines: the heads, one per position, the outcomes (when any), and the room under them.
  const span = () => 1 + lines().length + (outcomes() ? 1 : 0) + 1;
  const who = (col: number, n: number) => rows().slice(col, col + n).map((r) => r.row.label).join(", ");
  return (
    <div class="vis-steps-side" role="table" aria-label={props.label} style={{ "--steps-cols": String(rows().length) }}>
      <For each={rows()}>
        {(r, c) => {
          const e = props.em.get(r.key);
          return <div class={`vis-steps-colframe ${emClass(e)}`} style={{ "grid-column": String(c() + 1), "grid-row": `1 / span ${span()}` }} aria-hidden="true" />;
        }}
      </For>
      <div role="row">
        <For each={rows()}>
          {(r, c) => (
            <div role="columnheader" class="vis-steps-colhead" classList={{ "vis-steps-muted": r.row.tone === "muted" }} style={{ "grid-column": String(c() + 1), "grid-row": "1" }}>
              <Head row={r.row} e={props.em.get(r.key)} />
            </div>
          )}
        </For>
      </div>
      <For each={lines()}>
        {(line, k) => (
          <div role="row">
            <For each={line}>
              {(cell) => (
                <div
                  role="cell"
                  aria-colspan={cell.span > 1 ? cell.span : undefined}
                  class="vis-steps-cell"
                  classList={{ "vis-steps-merged": cell.span > 1, "vis-steps-gapcell": cell.step.gap }}
                  style={{ "grid-column": `${cell.col + 1} / span ${cell.span}`, "grid-row": String(k() + 2) }}
                >
                  <Show when={!cell.step.gap}>
                    <For each={connectors(lines()[k() - 1], cell)}>{(x) => <span class="vis-steps-conn" style={{ left: `${(x * 100).toFixed(2)}%` }} aria-hidden="true" />}</For>
                  </Show>
                  <Show when={!cell.step.gap} fallback={<span class="vis-steps-gap"><span class="vis-steps-sr">no step here</span></span>}>
                    <Chip step={cell.step} who={cell.span > 1 ? who(cell.col, cell.span) : undefined} />
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
      <Show when={outcomes()}>
        <div role="row">
          <For each={rows()}>
            {(r, c) => (
              <div role="cell" class="vis-steps-outcell" style={{ "grid-column": String(c() + 1), "grid-row": String(lines().length + 2) }}>
                <Show when={r.row.outcome}>{(o) => <Outcome outcome={o()} />}</Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="vis-steps-foot" style={{ "grid-row": String(span()) }} aria-hidden="true" />
    </div>
  );
}

/** The grid and the numbered list: one list item per lane head and per row. */
function Rows(props: { spec: StepsSpec; label: string; em: Em; rail: boolean; width: number }) {
  const longest = createMemo(() => Math.max(1, ...props.spec.items.map((it) => (it.type === "row" ? it.steps.length : 0))));
  const outcomes = createMemo(() => props.spec.items.some((it) => it.type === "row" && it.outcome));
  const cols = createMemo(() => gridCols(props.width, longest(), outcomes()));
  /** The row above each row in its lane, for the rail's folds. */
  const aboveOf = createMemo(() => {
    const out = new Map<number, StepsRow>();
    let above: StepsRow | null = null;
    props.spec.items.forEach((it, i) => {
      if (it.type === "lane") above = null;
      else {
        if (above) out.set(i, above);
        above = it;
      }
    });
    return out;
  });
  return (
    <div class="vis-steps" role="list" aria-label={props.label}>
      <For each={props.spec.items}>
        {(it, i): JSX.Element => {
          if (it.type === "lane") return <div class="vis-steps-lane" role="listitem">{it.label}</div>;
          const e = () => props.em.get(String(i()));
          const tint = () => (e() ? emClass(e()) : `vis-tone-${it.tone ?? "none"}`);
          if (props.rail) {
            return (
              <div role="listitem" class={`vis-steps-band ${tint()}`} classList={{ "vis-steps-muted": it.tone === "muted" }}>
                <Head row={it} e={e()} />
                <ol class="vis-steps-rail">
                  <For each={railLines(it, aboveOf().get(i()) ?? null)}>
                    {(line) => {
                      if (line.type === "same")
                        return (
                          <li>
                            <span class="vis-steps-num">{range(line.from, line.to)}</span>
                            <span class="vis-steps-fold">
                              {line.from === line.to ? "Step 1" : `Steps ${range(line.from, line.to)}`} as in {line.label}
                            </span>
                          </li>
                        );
                      if (line.type === "gaps")
                        return (
                          <li class="vis-steps-gapline">
                            <span class="vis-steps-num">{range(line.from, line.to)}</span>
                            <span class="vis-steps-gap">
                              <span class="vis-steps-sr">no step here</span>
                            </span>
                          </li>
                        );
                      return (
                        <li>
                          <span class="vis-steps-num">{line.n}</span>
                          <Chip step={line.step} />
                        </li>
                      );
                    }}
                  </For>
                  <Show when={it.outcome}>
                    {(o) => (
                      <li>
                        <span />
                        <Outcome outcome={o()} />
                      </li>
                    )}
                  </Show>
                </ol>
              </div>
            );
          }
          return (
            <div role="listitem" class={`vis-steps-row ${tint()}`} classList={{ "vis-steps-has-out": outcomes(), "vis-steps-muted": it.tone === "muted" }}>
              <Head row={it} e={e()} />
              <ol class="vis-steps-chain" style={{ "--steps-cols": String(cols()) }}>
                <For each={it.steps}>
                  {(_, k) => {
                    const s: Step = { text: it.steps[k()]!, tone: it.stepTones?.[k()] ?? null, gap: !!it.gaps?.includes(k()) };
                    const arrow = () => k() % cols() !== 0 && !s.gap;
                    return (
                      <li classList={{ "vis-steps-gapcell": s.gap }}>
                        <Show when={arrow()}>
                          <span class="vis-steps-arrow icon" style={{ "--icon": `url("${visIcon("arrow-right")}")` }} aria-hidden="true" />
                        </Show>
                        <Show when={!s.gap} fallback={<span class="vis-steps-sr">no step here</span>}>
                          <Chip step={s} />
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ol>
              <Show when={outcomes()}>
                <Show when={it.outcome} fallback={<span />}>
                  {(o) => <Outcome outcome={o()} />}
                </Show>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
