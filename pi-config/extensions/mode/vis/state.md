<!-- owner: process member (flow's parser, layout and View; `end` sinks to the last rank). Emphasis target: state id or label. -->
# vis state
A state machine: flow syntax, but nodes default to `round`; `node s0 start` / `node done end` are the entry and exit dots. Label each edge with its event (`idle -> busy "prompt"`), so name states by id or on `node` lines, never inline. Quote every label, even one word: `node fw2 "FIN_WAIT_2"`. An event is a string after the edge (`a -> b "no"`); Mermaid's `--no-->` is not syntax.
```vis state
node s0 start
s0 -> idle
idle -> busy "prompt"
busy -> idle "settled"
busy -> failed "error"
mark failed error "retried once, then shown"
```
- `mark` targets: a node's id or label.
