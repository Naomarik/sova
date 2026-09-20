import type { ContextInfo } from "../../shared/protocol";
import { contextSentence, contextStep } from "../lib/context";

const R = 5;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * The sidebar row's context fill: a 12×12 ring that fills clockwise from 12 o'clock. Static by
 * design — no animation, no indeterminate state, and never a ring without a window (the caller
 * guarantees one; a fill with no denominator means nothing). The words live in the title only, so
 * the row's link keeps its short name, and the sentence is the head gauge's own.
 */
export function ContextRing(props: { info: ContextInfo }) {
  const step = () => contextStep(props.info.tokens, props.info.window);
  const fraction = () => Math.min(1, props.info.tokens / props.info.window!);
  return (
    <span
      class="context-ring"
      classList={{ "context-warn": step() === "context-warn", "context-error": step() === "context-error" }}
      title={contextSentence(props.info)}
    >
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <circle class="context-ring-track" cx="6" cy="6" r={R} fill="none" />
        {/* Rotated about the centre in SVG, so 0% starts at 12 o'clock without a CSS rule. */}
        <circle
          class="context-ring-fill"
          cx="6"
          cy="6"
          r={R}
          fill="none"
          transform="rotate(-90 6 6)"
          style={{ "stroke-dasharray": `${CIRCUMFERENCE}`, "stroke-dashoffset": `${CIRCUMFERENCE * (1 - fraction())}` }}
        />
      </svg>
    </span>
  );
}
