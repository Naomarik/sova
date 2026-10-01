<!-- owner: structure member. kinds/layers: HTML bands, label column folds above the items at phone width. Emphasis target: layer label (key = index). -->
# vis layers
A system as a stack, top first: tiers, a protocol stack, what runs where. One line per layer: `label | item, item, … | note (optional) | tone (optional)`.
```vis layers
title: Where a chat message lives
Browser | Solid app, service worker | accent
Server | Hono REST, /ws/chat | one process per checkout
Disk | session JSONL | muted
mark Server "holds every live session"
```
- Quote an item that contains a comma. `|` only separates fields: never put one inside a field. Leave the items empty (`Disk | | muted`) for a label-only layer. At most 10 layers, 12 items each.
- `mark` targets: a layer's label.
