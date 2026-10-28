import { Match, Show, Switch } from "solid-js";
import { effortArcLength, effortMark } from "../lib/effort";
import { dash, RING_ARC, RING_R } from "../lib/waiting";

/** The bolt max draws in the ring's middle: Sova's own, filled (never a star). */
const BOLT = "M2.2 -10 L-5.6 1.6 H-0.6 L-2.2 10 L5.6 -1.6 H0.6 Z";

/**
 * The effort ring (§chat.composer/behavior): a small 270° open ring, its arc filled to the level on
 * the seven-step scale, with the level's mark inside. Quiet ink, never the accent. Decorative: the
 * control that holds it carries the words.
 */
export function EffortRing(props: { level: string; class?: string }) {
  const mark = () => effortMark(props.level);
  return (
    <svg class={`effort-ring${props.class ? ` ${props.class}` : ""}`} data-level={props.level} viewBox="-17 -17 34 34" aria-hidden="true">
      <circle r={RING_R} class="effort-ring-track" stroke-dasharray={dash(RING_ARC)} transform="rotate(135)" />
      {/* None at off: a round cap on a zero-length dash would still draw a dot. */}
      <Show when={effortArcLength(props.level) > 0}>
        <circle r={RING_R} class="effort-ring-arc" stroke-dasharray={dash(effortArcLength(props.level))} transform="rotate(135)" />
      </Show>
      <Switch>
        <Match when={mark().kind === "dot"}>
          <circle class="effort-ring-mark" r="3" />
        </Match>
        <Match when={mark().kind === "bolt"}>
          <path class="effort-ring-mark" d={BOLT} />
        </Match>
        <Match when={mark().kind === "letter" && mark()}>
          {(m) => (
            <text class="effort-ring-mark effort-ring-letter" y="5.6">
              {(m() as { text: string }).text}
            </text>
          )}
        </Match>
      </Switch>
    </svg>
  );
}
