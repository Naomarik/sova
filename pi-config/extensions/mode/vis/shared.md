<!--
  owner: foundation. The rules every kind shares and the `mark` syntax (core/emphasis.ts implements it;
  every kind calls it). The vis_guide tool returns this file first, then the asked kind's file (minor.ts
  visGuide), with HTML comments stripped; each kind's own `mark` targets are in its file.
  server/baton-vis-guide.ts takes the rules list and the mark paragraph for gathering sessions.
-->
# vis: rules for every kind
- One statement per line; `#` starts a comment. Settings are `key: value` lines, always with the colon, first in the block and once each; every kind takes `title:` and `caption:` (one short sentence).
- Ids are letters, digits, `_ . -`, starting with a letter. Labels with spaces go in "double quotes" (`\n` breaks a line); any text is at most 200 characters.
- Tones (optional, never the only signal): `accent ok warn error info muted`.
- The parser is strict: a line it can't read shows the block as source. Use only the syntax below.
- Not vis (Mermaid, ASCII art): `A->>B: msg` is `a -> b "msg"`; `A[Label] --> B` is `a "Label" --> b`.

To point at what matters, add a `mark` line (at column 0, after the settings): `mark <target> [tone] ["short note"]`. A target is its item's exact label, quoted if it has spaces (even if its row isn't): `mark "Vue 2" "…"`. The item is highlighted (accent by default); a note is numbered and listed under the drawing. Mark at most 1–3 things; notes under 120 characters. Targets may share one mark: `mark a, b, c "the scope set"`.
