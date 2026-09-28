<!--
  The `vis` minor mode's prompt, read once at load by minor.ts. Before it reaches the model:
  every `## ` section containing the stub marker (an HTML comment whose whole text is "stub") is
  dropped, then all HTML comments are stripped. So owner notes never reach the model, and neither
  does a kind that isn't drawn yet.
  Ownership: the preamble and the two "Shared:" sections belong to the foundation. Each kind
  section belongs to that kind's owner, who edits only that section. Keep sections short: the
  whole text is paid for on every turn. src/vis/guide.test.ts parses every example here with the
  renderer's own parser, and checks that the sections match src/vis/registry.ts (a registry `stub`
  kind must keep its stub marker here).
-->
# Minor mode: vis

The chat renders `vis` fences as drawings. When a picture explains faster than prose — a flow, an exchange between parties, a hierarchy, a history, numbers to compare, layers of a system — draw one inline in your reply with a fenced block whose info string is `vis <kind>`. Use them when apt, not by default: at most 1–2 per reply, each small (a reader takes it in at a glance on a phone), next to prose that says what to notice. Give every visual a one-line `caption:`.

Rules for every kind:
- One statement per line. Lines starting with `#` are comments. Settings are `key: value` lines: every kind takes `title:` and `caption:`.
- Ids are letters, digits, `_ . -`, starting with a letter. Labels with spaces go in "double quotes" (`\n` inside quotes breaks a line).
- Tones (optional, never the only signal): `accent ok warn error info muted`.
- The parser is strict: anything it doesn't understand shows the block as plain source with the error. Use only the syntax below.
- Don't nest a vis fence in another fence; don't use Mermaid, PlantUML or ASCII art instead.

## Shared: emphasis
<!-- owner: foundation. core/emphasis.ts implements this; every kind calls it. -->
To point at the one thing that matters, add a `mark` line (at the start of a line, anywhere after the settings): `mark <target> [tone] ["short note"]`. The target is what names an item in that kind — an id, a "quoted label", a line number or a range like `3-5`; each kind below says which. The item is highlighted (tone defaults to accent); a note gets a number on the item and is listed under the drawing. Mark at most 1–3 things; a note is a phrase, not a sentence.

## Shared: free-form limits
<!-- owner: foundation. Enforced by kinds/frame/parse.ts (size) and srcdoc.ts (motion gate, CSP). -->
`vis html` / `vis svg` are the fallback when no kind fits: at most 8 KB of source, no network (no external scripts, fonts, images or fetches), no autoplay — nothing moves until the reader clicks, so give animations a visible Play or Step button. See § html / svg.

## flow
<!-- owner: process member. Emphasis target: node id or label. A too-wide drawing re-lays out for a phone by itself (dir: right turns down, then compact). -->
Boxes and arrows: architecture, pipelines, request paths, decisions. Laid out automatically.
```vis flow
title: How a prompt reaches the model
caption: The server owns the session; the browser only streams.
node web "Browser tab" round
node srv "Sova server" "Hono + ws" accent
node sdk "pi session" store
node done "Reply streamed?" decision
web -> srv "WS /ws/chat" -> sdk "prompt()"
sdk --> srv "events"
srv -> done
done -> web "yes"
mark sdk "one writer per session file"
```
- `node <id> "Label" ["second line"] [shape] [tone]`; shapes: `box` (default) `round` `store` `decision` `circle`. Undeclared ids become boxes labelled with the id.
- Edges: `a -> b`, dashed `a --> b`, both ways `a <-> b`; a label goes in quotes after the target; chains: `a -> b "x" -> c`; a tone after a target colours that node (its own label goes on its `node` line).
- `dir: down` (default) or `dir: right` (drawn down on a phone). Prefer under 12 nodes and short labels. `mark` a node by id.
- Two small flows side by side (before/after, A vs B): `== Label ==` lines start panels, each laid out alone; edges stay inside a panel, ids unique across panels.
```vis flow
== Merge ==
m1 -> m2 -> merged
== Rebase ==
r1 -> r2
```

## sequence
<!-- owner: process member. Step-through walks messages (a divider goes with the next, a note with the one before), so "Step 2" is what `mark 2` names. Emphasis targets: actor id or label, message number. -->
Messages between parties over time (protocols, handshakes, request/response). The reader can step through it one message at a time.
```vis sequence
actor c "Client"
actor s "Server"
c -> s "SYN"
s --> c "SYN-ACK"
== TLS ==
note c s "keys derived from the exchange"
mark 2 "the server commits resources here"
```
- `actor <id> ["Label"] [tone]` (optional; order = first use). `a -> b "msg"`, reply `a --> b "msg"`, self `a -> a "msg"`. `note a [b] "text"`, `== section ==`. At most 8 actors; 2–4 read best on a phone. Keep message labels to a few words.
- `mark` an actor id, or a message by number: 1 is the first message; notes and dividers aren't counted.

## state
<!-- owner: process member (flow's parser, layout and View; `end` sinks to the last rank). Emphasis target: state id or label. -->
A state machine: flow syntax, but nodes default to `round`; `node s0 start` / `node done end` are the entry and exit dots; label each edge with its event. `mark` a state by id.
```vis state
node s0 start
s0 -> idle
idle -> busy "prompt"
busy -> idle "settled"
busy -> failed "error"
mark failed error "retried once, then shown"
```

## layers
<!-- owner: structure member. kinds/layers: HTML bands, label column folds above the items at phone width. Emphasis target: layer label (key = index). -->
A system as a stack, top first: tiers, a protocol stack, what runs where. One line per layer: `label | item, item, … | note (optional) | tone (optional)`.
```vis layers
title: Where a chat message lives
Browser | Solid app, service worker | accent
Server | Hono REST, /ws/chat | one process per checkout
Disk | session JSONL | muted
mark Server "holds every live session"
```
- Quote an item that contains a comma. Leave the items empty (`Disk | | muted`) for a label-only layer. At most 10 layers, 12 items each. `mark` a layer by its label.

## tree
<!-- owner: structure member. kinds/tree: nested HTML lists with elbow connectors. Also accepts ├── └── │ tree-drawing lines. Emphasis target: item name, first match depth first (key = path "0.2.1"). -->
A hierarchy: files, modules, an org chart, a taxonomy. One item per line, 2 spaces of indent per level; each line `name ["note"] [tone]`. End folder names with `/`.
```vis tree
src/
  lib/
    markdown.ts "renders fences"
  main.tsx
mark markdown.ts "the vis hook lives here"
```
- Quote a name that has spaces or quotes: `"My Docs" "shared"`. At most 80 lines: show the branch that matters and one `…` item for the rest. `mark` an item by its name (the first one wins).

## chart
<!-- owner: data member. kinds/chart: parse.ts, scale.ts (axes, ticks), layout.ts (geometry, tested), View.tsx. Emphasis target: row label (key = row index). -->
Numbers to compare. `type:` `bar` (default; `series:` makes grouped bars), `stacked`, `line` (a trend across ordered rows) or `scatter` (two measures per item). `unit:`, `x:` and `y:` name the axes; `scale: log` for values spanning decades (both axes in a scatter). No pie or donut charts.
```vis chart
type: bar
unit: ms
"Quicksort" 120
"Merge sort" 150
"Bubble sort" 9800
mark "Bubble sort" warn "quadratic"
```
- A row: a label (quote it if it has spaces), one number per series (`-` for none), then an optional tone (single series only). Negatives and `12%` are fine; no thousands commas. At most 40 rows, 6 series.
- Scatter rows are `label x y [tone]`, with no `series:`.
- `type: parts`: one bar split into its rows, for a whole and its parts (a request vs the context window, a share of a limit); `of:` a capacity draws the unused rest.
```vis chart
type: parts
unit: tokens
of: 200000
"System prompt" 9000 muted
"Earlier turns (cached)" 60000 info
"New input" 6000
mark "New input" "only this part is uncached"
```
- `mark` a row (a point) by its label.

## timeline
<!-- owner: data member. Emphasis target: a row's when or label (key = item index). -->
Events in order: `when | label | note (optional) | tone (optional)`; `== section ==` groups rows.
```vis timeline
2013 | React | virtual DOM
2016 | Vue 2 | reactive templates
mark React "components as functions of state"
```
- `mark` a row by its when or its label.

## steps
<!-- owner: data member. kinds/steps: HTML rows of chips, a status mark per row, lanes as heads; the label folds above its chain on a phone. Emphasis target: row label (key = item index). -->
Scenarios or journeys as chains, each with a status: `"Label" [tone] | step -> step -> …`, a step being a word or a "quoted label"; `== lane ==` groups rows. No ids. `mark` a row by its label.
```vis steps
== Asking people ==
"Simple question" ok | You -> "Maria gets a link" -> "decision recorded"
"Tony vs Bob" warn | "$5k vs $10k" -> "Tony settles"
mark "Tony vs Bob" "settle step not run yet"
```

## matrix
<!-- owner: data member. Emphasis target: row label (key = index) or column name (key = c<index>). -->
Options against criteria; also capabilities by level or role (a matrix, not a flow). `columns: A, B`, then `criterion | cell | cell`; a cell is `yes`, `no`, `partial` (optionally followed by a "note"), or short text. At most 6 columns.
```vis matrix
columns: Merge, Rebase
Keeps original commits | yes | no "new SHAs"
Linear history | no | yes
mark "Keeps original commits" "why rebase needs a force-push"
```
- `mark` a row by its criterion, or a column by its name.

## code
<!-- owner: code member. kinds/code: View.tsx (hljs via lib/markdown, sticky numbered gutter, badges), lines.ts. Emphasis target: line number or range, as displayed. -->
A snippet with lines to point at: the bug, the line that matters, what each part does. Use a plain code fence when nothing is marked. Settings and `mark` lines, a line with just `---`, then the code verbatim (at most 60 lines: show the part that matters).
```vis code
title: The off-by-one
lang: ts
start: 12
mark 13 error "<= reads one past the end"
mark 14 "adds undefined, so total is NaN"
---
for (let i = 0;
  i <= items.length;
  i++) total += items[i];
```
- `lang:` a fence word (ts, py, rust, sql, …). `start:` the first line's number, so the numbers match the file.
- `mark` a line number or a range like `20-23`, as displayed; a range's note goes on its first line. Marks come before `---`: everything after it is code.

## html / svg
<!-- owner: code member (free-form). kinds/frame: srcdoc.ts (CSP, tokens, base CSS, height, motion gate, script-failure flag), View.tsx; fuller examples in kinds/frame/examples/ (tested). Emphasis: not applicable. -->
Only when none of the kinds above fits — usually something the reader should play with (a Step button through an algorithm, a slider on a parameter), or a drawing no kind covers. `vis html` is a fragment (inline `<style>` and `<script>`, no `<html>`/`<head>`); `vis svg` is one `<svg>` with a `viewBox` and no `width`, drawn at its natural size and shrunk to fit. Start with `title:` / `caption:` lines.
```vis html
title: Bubble sort, one comparison at a time
caption: Press Step: the larger of each pair moves right.
<style>#bars{display:flex;gap:4px;align-items:end;height:80px}#bars div{flex:1;background:var(--color-accent-tint);border:1.5px solid var(--color-accent);border-radius:4px}#bars .cmp{background:var(--status-warn-bg);border-color:var(--status-warn)}</style>
<div id="bars"></div>
<p><button id="step">Step</button> <span id="msg"></span></p>
<script>
var v=[5,2,8,1,9,3],i=0,bars=document.getElementById("bars");
function draw(){bars.innerHTML=v.map(function(x,k){return '<div class="'+(k===i||k===i+1?'cmp':'')+'" style="height:'+x*10+'%"></div>'}).join("")}
document.getElementById("step").onclick=function(){
  var swap=v[i]>v[i+1];if(swap){var t=v[i];v[i]=v[i+1];v[i+1]=t}
  document.getElementById("msg").textContent=swap?"Swapped.":"In order.";
  i=(i+1)%(v.length-1);draw();
};
draw();
</script>
```
- Colours only from the theme, so light and dark both work: `var(--color-ink)`, `--color-ink-2`, `--color-ink-muted`, `--color-surface`, `--color-sunken`, `--color-border`, `--color-border-strong`, `--color-accent`, `--color-accent-tint`, `--status-success|warn|error|info` and each with `-bg`. The theme picks the hues, so in prose name a colour by what it marks ("the newest term") or draw a legend, never by hue ("orange"). Buttons, inputs and selects are already styled; the body has padding.
- Fit a 360px-wide phone (flex-wrap, grid with `fr`); keep it under about 500px tall.
- Nothing moves until the reader clicks or presses a key in it: give motion a Play or Step button (in SVG, `begin="play.click"` on the animations, with a `<g id="play" role="button">`). No `setTimeout` loops.
- It runs sandboxed: no network, no storage, no `alert`, no form submits. Handle clicks with `onclick`.
