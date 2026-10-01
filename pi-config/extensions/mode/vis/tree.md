<!-- owner: structure member. kinds/tree: nested HTML lists with elbow connectors. Also accepts ├── └── │ tree-drawing lines. Emphasis target: item name, first match depth first (key = path "0.2.1"). -->
# vis tree
A hierarchy: files, modules, an org chart, a taxonomy. One item per line, 2 spaces of indent per level; each line `name ["note"] [tone]`. End folder names with `/`, inside quotes: `"My Docs/"`, never `"My Docs"/`.
```vis tree
src/
  lib/
    markdown.ts "renders fences"
  main.tsx
mark markdown.ts "the vis hook lives here"
```
- Quote names with spaces or quotes: `"My Docs/" "shared"`. At most 80 lines: show the branch that matters and one `…` item for the rest.
- `mark` targets: an item's label.
