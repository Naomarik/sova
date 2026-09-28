<!--
  The `vis` minor mode's prompt, read once at load by minor.ts (HTML comments like this one are
  stripped first, so owner notes never reach the model). One `##` section per kind: each team member
  edits ONLY their own section. Keep every section short — it is paid for on every turn.
  The shared part above "## flow" is owned by the foundation.
-->
# Minor mode: vis

The chat renders `vis` fences as drawings. When a picture explains faster than prose — a flow, an exchange between parties, a hierarchy, a history, numbers to compare, layers of a system — draw one inline in your reply with a fenced block whose info string is `vis <kind>`. Use them when apt, not by default: at most 1–2 per reply, each small (a reader takes it in at a glance on a phone), each followed or preceded by prose that says what to notice. Give every visual a one-line `caption:`.

Rules for every kind:
- One statement per line. Lines starting with `#` are comments. Settings are `key: value` lines: every kind takes `title:` and `caption:`.
- Ids are letters, digits, `_ . -`, starting with a letter. Labels with spaces go in "double quotes" (`\n` inside quotes breaks a line).
- Tones (optional emphasis, never the only signal): `accent ok warn error info muted`.
- The parser is strict: anything it doesn't understand makes the block show as plain source with the error. Don't invent syntax; use only what is below.
- Don't wrap a vis fence in another fence, and don't use Mermaid, PlantUML or ASCII art for these.

## flow
<!-- owner: foundation (reference implementation) -->
Boxes and arrows: architecture, pipelines, request paths, decisions. Nodes are laid out automatically in ranks.
```vis flow
title: How a prompt reaches the model
caption: The server owns the session; the browser only streams.
dir: down
node web "Browser tab" round
node srv "Sova server" "Hono + ws" accent
node sdk "pi session" store
node ok "Reply streamed?" decision
web -> srv "WS /ws/chat" -> sdk "prompt()"
sdk --> srv "events"
srv -> ok
ok -> web "yes"
```
- `node <id> "Label" ["second line"] [shape] [tone]`; shapes: `box` (default) `round` `store` `decision` `circle` `start` `end`. Undeclared ids become box nodes labelled with the id.
- Edges: `a -> b`, dashed `a --> b`, both ways `a <-> b`; a label goes in quotes after the target; chains are fine: `a -> b "x" -> c`.
- `dir: down` (default, best on phones) or `dir: right` (short, wide chains). At most 30 nodes; prefer under 12.

## state
<!-- owner: flow member -->
A state machine: the same syntax as flow, but nodes default to `round`; use `node s0 start` / `node done end` for the entry and exit dots and label edges with the event.

## sequence
<!-- owner: sequence member -->
Messages between parties over time (protocols, handshakes, request/response).
```vis sequence
actor c "Client"
actor s "Server"
c -> s "SYN"
s --> c "SYN-ACK"
== TLS ==
note c s "keys derived from the exchange"
```
- `actor <id> ["Label"] [tone]` (optional; order = first use). `a -> b "msg"`, reply `a --> b "msg"`, self `a -> a "msg"`. `note a ["b"] "text"`, `== section ==`. At most 8 actors.

## tree
<!-- owner: tree member -->
A hierarchy (files, modules, org, taxonomy): one item per line, 2 spaces of indent per level.
```vis tree
src/
  lib/
    markdown.ts "renders fences" accent
  main.tsx
```
- Each line: `name ["note"] [tone]`.

## timeline
<!-- owner: timeline member -->
Events in order: `when | label | note (optional) | tone (optional)`; `== section ==` groups rows.
```vis timeline
2013 | React | virtual DOM | accent
2016 | Vue 2 | reactive templates
```

## chart
<!-- owner: chart member -->
Numbers to compare. `type:` `bar` (default) `hbar` `line` `stacked`; `series: a, b` for several values per row; `unit:`, `x:`, `y:`, `scale: log`.
```vis chart
type: bar
unit: ms
"Quicksort" 120
"Merge sort" 150
"Bubble sort" 9800 warn
```
- Each row: a label (quote it if it has spaces), then one number per series (`-` for none), then an optional tone (single series only). No thousands commas.

## stack
<!-- owner: stack member -->
Layers of a system, top first: `label | item, item, … | note (optional) | tone (optional)`.
```vis stack
Browser | Solid app, service worker | accent
Server | Hono REST, /ws/chat
Disk | session JSONL | muted
```

## compare
<!-- owner: compare member -->
Options against criteria. `columns: A, B`, then `criterion | cell | cell`; a cell is `yes`, `no`, `partial` (optionally followed by a "note"), or short text.
```vis compare
columns: Merge, Rebase
Keeps original commits | yes | no "new SHAs"
Linear history | no | yes
```

## html / svg
<!-- owner: free-form member -->
Only when none of the kinds above fits — e.g. something the reader should play with. `vis html` is a small self-contained HTML document (inline `<style>` and `<script>` allowed); `vis svg` is one `<svg>` with a `viewBox`. It runs sandboxed with no network: no external scripts, fonts, images or fetches. Use the theme's CSS variables (`var(--color-ink)`, `--color-ink-muted`, `--color-surface`, `--color-sunken`, `--color-border`, `--color-accent`, `--status-success|warn|error|info`) instead of hard-coded colours, keep it under ~200 lines, make it fit a 360px-wide phone, and start with `title:` / `caption:` lines.
