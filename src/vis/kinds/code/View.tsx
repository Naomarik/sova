/**
 * `vis code` view: the snippet highlighted as a whole (lib/markdown's hljs setup), split into
 * lines, each with its displayed number in a gutter that stays put while the code scrolls
 * sideways. A marked line gets the shared emphasis (tone fill, the gutter's bar) and, on the first
 * line of a mark with a note, the note's number badge.
 */
import { createMemo, For, Show } from "solid-js";
import { highlight, resolveLanguage } from "../../../lib/markdown";
import { emphasisMap } from "../../core/emphasis";
import { EmBadge, emClass } from "../../emphasis";
import type { ViewProps } from "../../types";
import { estimateHeight } from "./layout";
import { splitHighlighted } from "./lines";
import type { CodeSpec } from "./parse";
import "./code.css";

export default function CodeView(props: ViewProps<CodeSpec>) {
  const em = createMemo(() => emphasisMap(props.spec));
  // Highlighting output is escaped HTML built from the model's text: the only innerHTML here.
  const rows = createMemo(() => splitHighlighted(highlight(props.spec.lines.join("\n"), props.spec.lang ?? "")));
  const hasBadges = createMemo(() => (props.spec.emphasis ?? []).some((e) => e.n !== undefined));
  const digits = createMemo(() => String(props.spec.start + props.spec.lines.length - 1).length);
  const lang = () => (props.spec.lang ? resolveLanguage(props.spec.lang) : "plaintext");
  return (
    <div class="vis-code" tabindex="0" role="region" aria-label={`${props.label} (scrolls sideways)`} style={{ "--vis-code-digits": String(digits()), height: `${estimateHeight(props.spec, 0)}px` }}>
      <div class={`vis-code-lines hljs language-${lang()}`} classList={{ "vis-code-has-badges": hasBadges() }}>
        <For each={rows()}>
          {(html, i) => {
            const n = () => props.spec.start + i();
            const e = () => em().get(String(n()));
            return (
              <div class={`vis-code-line ${emClass(e())}`}>
                <span class="vis-code-gutter" aria-hidden={e()?.n ? undefined : "true"}>
                  <span class="vis-code-num">{n()}</span>
                  <Show when={hasBadges()}>
                    <span class="vis-code-badge">
                      <EmBadge e={e()} />
                    </span>
                  </Show>
                </span>
                <code class="vis-code-text" innerHTML={html || " "} />
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
