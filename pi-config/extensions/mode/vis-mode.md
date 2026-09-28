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
<!-- owner: foundation (reference implementation). Emphasis target: node id or label. -->
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
- Edges: `a -> b`, dashed `a --> b`, both ways `a <-> b`; a label goes in quotes after the target; chains: `a -> b "x" -> c`.
- `dir: down` (default, best on phones) or `dir: right`. Prefer under 12 nodes. `mark` a node by id.

## sequence
<!-- owner: sequence member. Draft View with a step-through control (stepper.tsx). Emphasis targets: actor id, or message number (1 = first message). -->
Messages between parties over time (protocols, handshakes, request/response). The reader can step through it.
```vis sequence
actor c "Client"
actor s "Server"
c -> s "SYN"
s --> c "SYN-ACK"
== TLS ==
note c s "keys derived from the exchange"
mark 2 "the server commits resources here"
```
- `actor <id> ["Label"] [tone]` (optional; order = first use). `a -> b "msg"`, reply `a --> b "msg"`, self `a -> a "msg"`. `note a [b] "text"`, `== section ==`. At most 8 actors. `mark` an actor id or a message number.

## state
<!-- owner: state member (shares flow's parser and layout; state-specific drawing goes in kinds/flow or a new kinds/state). Emphasis target: state id. -->
A state machine: flow syntax, but nodes default to `round`; `node s0 start` / `node done end` are the entry and exit dots; label edges with the event.
```vis state
node s0 start
s0 -> idle
idle -> busy "prompt"
busy -> idle "settled"
busy -> failed "error"
mark failed error "retried once, then shown"
```

## layers
<!-- owner: layers member. Emphasis target: layer label. -->
Layers of a system, top first: `label | item, item, … | note (optional) | tone (optional)`.
```vis layers
Browser | Solid app, service worker | accent
Server | Hono REST, /ws/chat
Disk | session JSONL | muted
mark Server "holds every live session"
```

## tree
<!-- owner: tree member. Emphasis target: item name (first match). -->
A hierarchy (files, modules, org, taxonomy): one item per line, 2 spaces of indent per level; each line `name ["note"] [tone]`.
```vis tree
src/
  lib/
    markdown.ts "renders fences"
  main.tsx
mark markdown.ts "the vis hook lives here"
```

## gitgraph
<!-- stub -->
<!-- owner: gitgraph member. Design the syntax (commit, branch, checkout, merge; rebase and cherry-pick as new commits; tags), write kinds/gitgraph/parse.ts and View.tsx, then drop the stub marker here and `stub: true` in registry.ts. Emphasis target: commit id. -->
Commit history across branches — merges, rebases, cherry-picks.

## chart
<!-- owner: chart member. Draft View. Scatter parses (type: scatter, rows `label x y [tone]`) but isn't drawn yet: add it to this section when it is. Emphasis target: row label. -->
Numbers to compare. `type:` `bar` (default; several `series:` make grouped bars), `stacked`, or `line`; `unit:`, `x:`, `y:`, `scale: log`. No pie or donut charts.
```vis chart
type: bar
unit: ms
"Quicksort" 120
"Merge sort" 150
"Bubble sort" 9800
mark "Bubble sort" warn "quadratic"
```
- Each row: a label (quote it if it has spaces), then one number per series (`-` for none), then an optional tone (single series only). No thousands commas.

## timeline
<!-- owner: timeline member. Emphasis target: a row's when or label. -->
Events in order: `when | label | note (optional) | tone (optional)`; `== section ==` groups rows.
```vis timeline
2013 | React | virtual DOM
2016 | Vue 2 | reactive templates
mark React "components as functions of state"
```

## matrix
<!-- owner: matrix member. Emphasis target: row label. -->
Options against criteria. `columns: A, B`, then `criterion | cell | cell`; a cell is `yes`, `no`, `partial` (optionally followed by a "note"), or short text.
```vis matrix
columns: Merge, Rebase
Keeps original commits | yes | no "new SHAs"
Linear history | no | yes
mark "Keeps original commits" "why rebase needs a force-push"
```

## code
<!-- stub -->
<!-- owner: code member. The parser is done (kinds/code/parse.ts); write View.tsx (numbered gutter, the marked lines' badges, highlight with lib/markdown's `highlight`), then drop the stub marker here and `stub: true` in registry.ts. Emphasis target: line number or range, as displayed. -->
An annotated snippet: settings and `mark` lines, a line with just `---`, then the code verbatim. Lines are numbered from `start:` (default 1).
```vis code
title: The off-by-one
lang: ts
mark 2 "<= reads one past the end"
---
for (let i = 0;
  i <= items.length;
  i++) total += items[i];
```

## html / svg
<!-- owner: free-form member. Emphasis: not applicable. -->
Only when none of the kinds above fits — usually something the reader should play with. `vis html` is a small self-contained HTML document (inline `<style>` and `<script>`); `vis svg` is one `<svg>` with a `viewBox`. Start with `title:` / `caption:` lines. Colours come from the theme's CSS variables: `var(--color-ink)`, `--color-ink-muted`, `--color-surface`, `--color-sunken`, `--color-border`, `--color-accent`, `--status-success|warn|error|info`. Fit a 360px-wide phone. The limits in § Shared: free-form limits apply: 8 KB, no network, nothing moves until a click.
