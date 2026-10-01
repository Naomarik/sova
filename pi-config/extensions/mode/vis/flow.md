<!-- owner: process member. Emphasis target: node id or label. Phones re-lay it out (dir: right turns down). kinds/flow/parse.ts picks the label style per fence; guide.test.ts pins each bullet. -->
# vis flow
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
- A decision's branches are edges with a string, the branch: `done -> web "yes"`. Mermaid's `--no-->` is not syntax.
- `node db "Orders" store` alone on a line declares a node; then `api -> db "SQL"` labels the edge.
- Label the first node too: with no string right after any line's first id, strings after targets are all edge labels.
- Edges `->`, dashed `-->`, two-way `<->`; chains `a -> b -> c`; `dir: right`; under 12 nodes.
- `group "Label" id id …` frames related nodes (a node in one group at most).
- `== Label ==` lines start side-by-side panels (before/after) with their own ids:
```vis flow
== Before ==
app "App" -> db "Database"
== After ==
app "App" -> cache "Cache" -> db "Database"
```
- `mark` targets: a node's id or label.
