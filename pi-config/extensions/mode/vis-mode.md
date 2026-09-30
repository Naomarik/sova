<!--
  The `vis` minor mode's prompt, read once at load by minor.ts. Before it reaches the model:
  every `## ` section containing the stub marker (an HTML comment whose whole text is "stub") is
  dropped, then all HTML comments are stripped. So owner notes never reach the model, and neither
  does a kind that isn't drawn yet.
  Ownership: the preamble and the "Shared:" section belong to the foundation. Each kind
  section belongs to that kind's owner, who edits only that section. Keep sections short: the
  whole text is paid for on every turn. src/vis/guide.test.ts parses every example here with the
  renderer's own parser, and checks that the sections match src/vis/registry.ts (a registry `stub`
  kind must keep its stub marker here).
-->
# Minor mode: vis

The chat renders `vis` fences as drawings. When a picture explains faster than prose — a flow, an exchange between parties, a hierarchy, a history, numbers to compare, layers of a system, a screen's layout — draw one inline in your reply with a fenced block whose info string is `vis <kind>`. Use them when apt, not by default: at most 1–2 per reply, each small (a reader takes it in at a glance on a phone), next to prose that says what to notice. Give every visual a one-line `caption:`.

Rules for every kind:
- One statement per line; `#` starts a comment. Settings are `key: value` lines; every kind takes `title:` and `caption:` (one short sentence).
- Ids are letters, digits, `_ . -`, starting with a letter. Labels with spaces go in "double quotes" (`\n` breaks a line); any text is at most 200 characters.
- Tones (optional, never the only signal): `accent ok warn error info muted`.
- The parser is strict: a line it can't read shows the block as source, with the error. Use only the syntax below.
- Don't nest a vis fence in another fence. Not vis (Mermaid, ASCII art): `A->>B: msg` is `a -> b "msg"`; `A[Label] --> B` is `a "Label" --> b`.

## Shared: emphasis
<!-- owner: foundation. core/emphasis.ts implements this; every kind calls it. -->
To point at what matters, add a `mark` line (at the start of a line, after the settings): `mark <target> [tone] ["short note"]` (quote a target with spaces). The item is highlighted (tone defaults to accent); a note gets a number and is listed under the drawing. Mark at most 1–3 things; a note is a phrase under 120 characters. Several targets share one mark and its note: `mark a, b, c "the scope set"`.
- Targets: flow and state, a node's id or label; sequence, an actor, a message's "label" or its number (1 = the first message; notes and dividers don't count); code, a line or a range `20-23` as displayed; matrix, a row's criterion or a column's name; wireframe, see its section; any other kind, a row's (layer's, item's) label.

## flow
<!-- owner: process member. Emphasis target: node id or label. Phones re-lay it out (dir: right turns down). kinds/flow/parse.ts picks the label style per fence; guide.test.ts pins each bullet. -->
Boxes and arrows: architecture, pipelines, request paths, decisions. A screen layout is a wireframe, not a flow.
```vis flow
title: How a prompt reaches the model
caption: The server owns the session; the browser only streams.
web "Browser tab" -> srv "Sova server" "WS /ws/chat" -> sdk "pi session" store
sdk --> srv "events"
srv -> done "Reply streamed?" decision
done -> web "yes"
group "One process" srv sdk
mark sdk "one writer per session file"
```
- `web "Browser tab" ->`: label a node where it first appears. Two lines in a box: `\n` in its label, `-> gw "Gateway\nKong"`.
- `srv "Sova server" "WS /ws/chat"`: after a target, the first string labels it and the second labels the edge, never a second line.
- `sdk --> srv "events"`: a node already labelled takes one string, the edge's.
- `done "Reply streamed?" decision`: a shape (`box round store decision circle`) and a tone may follow.
- `node db "Orders" store` alone on a line declares a node; then `api -> db "SQL"` labels the edge.
- With no string right after any line's first id, strings after targets are all edge labels.
- Edges `->`, dashed `-->`, two-way `<->`; chains `a -> b -> c`; `dir: right`; under 12 nodes.
- `group "Label" id id …` frames related nodes (a node in one group at most).
- `== Label ==` lines start side-by-side panels (before/after) with their own ids:
```vis flow
== Before ==
app "App" -> db "Database"
== After ==
app "App" -> cache "Cache" -> db "Database"
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

## state
<!-- owner: process member (flow's parser, layout and View; `end` sinks to the last rank). Emphasis target: state id or label. -->
A state machine: flow syntax, but nodes default to `round`; `node s0 start` / `node done end` are the entry and exit dots. Label each edge with its event (`idle -> busy "prompt"`), so name states by id or on `node` lines, never inline.
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
- Quote an item that contains a comma. Leave the items empty (`Disk | | muted`) for a label-only layer. At most 10 layers, 12 items each.

## tree
<!-- owner: structure member. kinds/tree: nested HTML lists with elbow connectors. Also accepts ├── └── │ tree-drawing lines. Emphasis target: item name, first match depth first (key = path "0.2.1"). -->
A hierarchy: files, modules, an org chart, a taxonomy. One item per line, 2 spaces of indent per level; each line `name ["note"] [tone]`. End folder names with `/`, inside quotes: `"My Docs/"`, never `"My Docs"/`.
```vis tree
src/
  lib/
    markdown.ts "renders fences"
  main.tsx
mark markdown.ts "the vis hook lives here"
```
- Quote names with spaces or quotes: `"My Docs/" "shared"`. At most 80 lines: show the branch that matters and one `…` item for the rest.

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
- `type: parts`: one bar split into its rows, for a whole and its parts; `of:` a capacity draws the unused rest (rows past it don't draw: drop `of:`, say so in the caption).
```vis chart
type: parts
unit: tokens
of: 200000
"System prompt" 9000 muted
"Earlier turns (cached)" 60000 info
"New input" 6000
mark "New input" "only this part is uncached"
```

## timeline
<!-- owner: data member. Emphasis target: a row's when or label (key = item index). -->
Events in order: `when | label | note (optional) | tone (optional)`; `== section ==` groups rows.
```vis timeline
2013 | React | virtual DOM
2016 | Vue 2 | reactive templates
mark React "components as functions of state"
```

## steps
<!-- owner: data member. kinds/steps: HTML rows of chips, a status mark per row, lanes as heads; the label folds above its chain on a phone. Emphasis target: row label (key = item index). -->
Scenarios or journeys as chains, each with a status: `"Label" [tone] | step -> step -> …`, a step being a word or a "quoted label"; `== lane ==` groups rows. No ids.
```vis steps
== Asking people ==
"Simple question" ok | You -> "Maria gets a link" -> "decision recorded"
"Tony vs Bob" warn | "$5k vs $10k" -> "Tony settles"
mark "Tony vs Bob" "settle step not run yet"
```

## wireframe
<!-- owner: structure member. kinds/wireframe: DOM blocks, SVG arrow overlay. Emphasis target: a block's first text (the screen it is written under first), a screen name. -->
Low-fi screens: what sits where on a phone or desktop page; several screens show a flow, before/after or states. One block per line: a word, its "text"s, then optional words; indent a block to put it inside the one above.
```vis wireframe
title: Invoices on a phone
caption: Totals first; tapping an invoice opens it.
screen "Invoices"
header "Invoices"
  icon "search"
row
  stat "Unpaid" "AED —" warn
  stat "Paid this month" "AED —"
tabs "All, Unpaid, Paid"
list
  item "Invoice no." "customer · due date" "AED —" -> "Invoice"
  item "Invoice no." "customer · due date" "AED —"
button "New invoice" accent
screen "Invoice"
header "Invoice no."
  icon "back"
card "Amount due" "AED —"
  button "Send reminder" accent
mark "Unpaid" "tap to filter"
```
- Blocks: `header "Title"`, `tabs "A, B, C"` (`*B` selects B), `tabbar "A, B, C"`, `sidebar`, `footer`; `row` (up to 4), `col`, `grid`, `card "Title" ["subtitle"]`, `list` of `item "Title" ["detail"] ["right"]`, `modal "Title"`, `sheet "Title"`; `heading`, `text`, `image "what it shows"`, `avatar`, `icon "name"`, `badge`, `stat "Label" "value"`, `chart "Label" [bar|line|pie]`, `table "Col, Col"` (its `item`s are rows), `progress "Label" "60%"`; `button`, `link`, `input "Label" ["value"] ["hint"]`, `search`, `select`, `checkbox`, `toggle`, `radio`; `empty "Message"`, `loading`, `alert "Message"`, `toast`.
- Words after the texts: a tone (`accent`: the main action; `error` on an input: its hint is the error), `on` (checked, selected), `wide`.
- `screen "Name" [phone|desktop]` starts a screen (up to 6; `device: desktop` sets the default). `-> "Name"` after a block: the screen a tap opens. `mark` a block by its first text or a screen by its name.
- Only the words and numbers you were given; else a placeholder ("Name", "Order no.", "AED —"). Never make up prices, IDs, dates or times.

## matrix
<!-- owner: data member. Emphasis target: row label (key = index) or column name (key = c<index>). -->
Options against criteria; also capabilities by level or role (a matrix, not a flow). `columns: A, B`, then `criterion | cell | cell`; a cell is `yes`, `no`, `partial` (optionally followed by a "note"), or short text that may end with a tone (`72% warn`; quote text ending in a tone word). At most 6 columns.
```vis matrix
columns: Merge, Rebase
Keeps original commits | yes | no "new SHAs"
Linear history | no | yes
Conflicts to resolve | once ok | per commit warn
mark "Keeps original commits" "why rebase needs a force-push"
```

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
- Marks come before `---`: everything after it is code.

## html / svg
<!-- owner: code member (free-form). kinds/frame: srcdoc.ts (CSP, tokens, base CSS, height, motion gate, script-failure flag), View.tsx; fuller examples in kinds/frame/examples/ (tested). Emphasis: not applicable. -->
Only when none of the kinds above fits — usually something the reader should play with (a Step button through an algorithm, a slider on a parameter), or a drawing no kind covers. `vis html` is a fragment (inline `<style>` and `<script>`, no `<html>`/`<head>`); `vis svg` is one `<svg>` with a `viewBox` and no `width`, drawn at its natural size and shrunk to fit. Start with `title:` / `caption:` lines. Aim under 8K characters (the document after `title:` / `caption:`); up to 16K draws marked large, beyond that only the source shows.
```vis html
title: Bubble sort, one comparison at a time
caption: Press Step: the larger of each pair moves right.
<style>#b{display:flex;gap:4px;align-items:end;height:80px}#b i{flex:1;border:1.5px solid var(--color-accent)}#b .c{border-color:var(--status-warn)}</style>
<div id="b"></div><button id="s">Step</button>
<script>
var v=[5,2,8,1,9,3],i=0,b=document.getElementById("b");
function draw(){b.innerHTML=v.map(function(x,k){return '<i class="'+(k==i||k==i+1?"c":"")+'" style="height:'+x*10+'%"></i>'}).join("")}
document.getElementById("s").onclick=function(){if(v[i]>v[i+1]){var t=v[i];v[i]=v[i+1];v[i+1]=t}i=(i+1)%(v.length-1);draw()};
draw();
</script>
```
- Colours only from the theme, so light and dark both work: `var(--color-ink)`, `--color-ink-2`, `--color-ink-muted`, `--color-surface`, `--color-sunken`, `--color-border`, `--color-border-strong`, `--color-accent`, `--color-accent-tint`, `--status-success|warn|error|info` and each with `-bg`. In prose name a colour by what it marks, never by hue. Buttons, inputs and selects are already styled; the body has padding.
- Fit a 360px-wide phone (flex-wrap, grid with `fr`); keep it under about 500px tall.
- Nothing moves until the reader clicks or presses a key in it: give motion a Play or Step button (in SVG, `begin="play.click"` on the animations, with a `<g id="play" role="button">`). No `setTimeout` loops.
- Check a large draft with the `vis_check` tool before you post it.
- It runs sandboxed: no network (no external scripts, fonts, images or fetches), no storage, no `alert`, no form submits. Handle clicks with `onclick`.
