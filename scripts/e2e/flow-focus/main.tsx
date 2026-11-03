// The page scripts/e2e/flow-focus.mjs drives: Sova's own figure shell and flow View, as the chat
// mounts them, for a few fences (the login flow, a panelled one, a wide one, a state machine).
import { For } from "solid-js";
import { render } from "solid-js/web";
import "../../../src/design/tokens.css";
import "../../../src/design/base.css";
import "../../../src/vis/vis.css";
import { Figure } from "../../../src/vis/Figure";
import { parseVis } from "../../../src/vis/parse";
import type { VisBase } from "../../../src/vis/core/grammar";
import type { ViewProps } from "../../../src/vis/types";
import FlowView from "../../../src/vis/kinds/flow/View";
import type { Component } from "solid-js";

export const CASES: { id: string; kind: string; body: string }[] = [
  {
    id: "login",
    kind: "flow",
    body: `title: Which login new work in a project starts on
caption: The project's login comes first; the chat shows a note whenever it lands elsewhere.
node start "New chat, worker\\nor overseer turn" round
node pick "Login picked by hand\\nin the composer?" decision
node handpick "That login" box ok
node proj "Project has a login?\\n(its own, else its org's)" decision
node ready "Ready here, or free\\nto borrow in the pool?" decision
node assigned "The project's login" box accent
node limit "Limit choice\\n(question 2)" decision
node order "This computer's order:\\nfirst login with room" box
node stop "Stops or waits,\\nchat says why" box warn
start -> pick
pick -> handpick "yes"
pick -> proj "no"
proj -> order "no"
proj -> ready "yes"
ready -> assigned "yes"
ready -> limit "no"
limit -> order "move on, with a note"
limit -> stop "stop or wait"
mark assigned "new: chosen on the project or organization Settings tab"
mark limit "your call in question 2"`,
  },
  {
    id: "sections",
    kind: "flow",
    body: `title: Before and after
== Before ==
a "Request" -> b "Diamond question that used to be cut short?" decision
b -> c "Done" "yes"
== After ==
a "Request" -> b "Hexagon question, every word shown on the drawing?" decision
b -> c "Done" "yes"
b -> d "Ask again" "no"`,
  },
  {
    id: "wide",
    kind: "flow",
    body: `title: One question, many answers
q "Which of these regions should the new replica run in first?" decision
${Array.from({ length: 8 }, (_, i) => `node r${i} "Region number ${i + 1} with a long name"\nq -> r${i}`).join("\n")}`,
  },
  {
    id: "state",
    kind: "state",
    body: `title: What a tap does
node s0 start
node none "Nothing picked"
node picked "One shape picked"
node done end
s0 -> none
none -> picked "tap a shape"
picked -> picked "tap another, or a chip"
picked -> none "tap it again, Esc"
none -> done`,
  },
];

const view = FlowView as unknown as Component<ViewProps<VisBase>>;
// What reached the document: the page's Escape listener stands in for the app's side pane.
(window as unknown as { escapes: number }).escapes = 0;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") (window as unknown as { escapes: number }).escapes++;
});

render(
  () => (
    <div class="md" style={{ "max-width": "760px", margin: "0 auto", padding: "8px" }}>
      <For each={CASES}>
        {(c) => {
          const r = parseVis(c.kind, c.body);
          if (!r.ok) throw new Error(`${c.id}: line ${r.line}: ${r.message}`);
          return (
            <div class="md-vis" data-case={c.id} style={{ "margin-bottom": "16px" }}>
              <Figure kind={c.kind} spec={r.spec} view={view} />
            </div>
          );
        }}
      </For>
    </div>
  ),
  document.getElementById("root")!,
);
