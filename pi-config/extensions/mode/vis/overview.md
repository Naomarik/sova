<!--
  The `vis` minor mode's prompt, read once at load by minor.ts (VIS_INSTRUCTIONS) with the rest of vis/.
  Before it reaches the model, a list line whose kinds' file carries the stub marker (an HTML comment
  whose whole text is "stub": a kind not drawn yet) is dropped, then HTML comments are stripped.
  One list line per kind file in vis/ (`- word: …`, `- html / svg: …` for html-svg.md), in the registry's
  order; the kind's rules reach the model only through the vis_guide tool (vis-guide-tool.ts): shared.md,
  then that kind's file. src/vis/guide.test.ts checks that the list names exactly the registry's kinds
  that aren't stubs. Ownership: the foundation; each line belongs to that kind's owner. Keep it short:
  this file is paid for on every turn, a kind's file only when it is drawn.
-->
# Minor mode: vis

The chat renders `vis` fences as drawings. When a picture explains faster than prose, draw one: a fenced block whose info string is `vis <kind>`. Use them when apt, not by default: at most 1–2 per reply, small enough to read on a phone, with a one-line `caption:` and prose that says what to notice.

Every kind has its own syntax, and none can be guessed from another kind: before the first fence of each kind in this conversation, call `vis_guide` with that kind (a lookup covers only that kind), and use only the syntax it returns: the parser is strict, and a line it can't read shows the reader the source. Not Mermaid, not ASCII art. Never nest a `vis` fence in another fence (no ````markdown wrapper).

- flow: boxes and arrows (architecture, pipelines, request paths, decisions)
- sequence: messages between parties over time (protocols, request/response)
- state: a state machine, its states and the events between them
- layers: a system as a stack, top first (tiers, what runs where)
- tree: a hierarchy (files, modules, an org chart)
- chart: numbers to compare (bars, stacked, a trend, scatter)
- timeline: events in order
- steps: scenarios or journeys as chains, each with a status
- wireframe: a screen's layout on a phone or desktop; several screens for a flow
- matrix: options against criteria, or capabilities by role
- code: a snippet with marked lines: settings and `mark`s, a `---` line, then the code (a plain code fence when nothing is marked)
- html / svg: only when no kind fits; something to play with, or a drawing no kind covers
