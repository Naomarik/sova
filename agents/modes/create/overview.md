---
watches: ["pi-config/extensions/mode/create/**", "pi-config/extensions/mode/create-guide-tool.ts"]
alsoUpdate: ["pi-config/extensions/mode/README.md", "site/src/content/docs/modes/create.md", "site/src/content/docs/extending/index.md"]
---
# Create

The third major mode: it does everything Delegate does and knows every supported way to configure or
extend Sova. It is built on Delegate, never a copy of it: one `orchestrates(mode)` test stands wherever
`mode === "delegate"` meant orchestration.

## What lives here

- The guide the model reads: `pi-config/extensions/mode/create/`. `overview.md` is the mode's block,
  `shared.md` the rules every lookup returns, one file per topic. `guide.ts` reads them once at load from
  beside itself, so a chat carries the guide of the code it runs and needs no checkout, project or spec.
  `create-guide-tool.ts` is the `create_guide` tool.
- Tests: `cd pi-config/extensions/mode && node --test create/guide.test.ts` (the file format, the list, the
  lookup). The growth test beside the server's tests holds Sova's own lists to the entries.
- The site pages: `site/src/content/docs/modes/create.md` and `site/src/content/docs/extending/`.
- The promises: §chat/create-mode, §design.copy-deck/create-mode.

## Adding a topic or a thing

**Every new configurable thing gets an entry, in the branch that adds it.** Most of the time that is one
new `## <thing>` section in an existing topic. Only what has landed goes in: work on a branch joins with
its own entry when it lands, in the branch that lands it.

A new section has the six lines in this order: Change, Lives, Approves, By, Live, Check. `By:` starts with
Screen, Card, Land, OK, Terminal or None, or two joined by " or ". `shared.md`'s owner note has the format,
and the test holds it.

An entry stands alone. It names no Sova source file, no spec, no `§` ID and no checkout, because a chat in
any project reads it. It may name a public page by its path (`/docs/...`).

A whole new topic is rarer, and changes what every Create chat pays for:

1. Add the file. Its first line is the table of contents line, exactly `# <topic>: <words>`. The line lives
   only there, so the list and the files can't disagree.
2. Add the topic to `CREATE_GROUPS` in `guide.ts`, in its group and place. A topic with no file isn't listed.
3. Update the list in the test, the promise (§chat.create-mode/contents) and both site pages, which keep
   the same order and words.

Every topic line is paid on every turn of a Create chat. Keep them short, and keep everything else in the
topic's file.

## What the growth test can't see

It fails the build when an item in one of Sova's own lists has no entry: Settings tabs, project settings,
powers, modes, screen places, commands, and each `SOVA_*` a user may set (the others are on a not-for-users
list beside the test). Its failure message is the worklist.

It holds only where Sova keeps a list. It can't see a new control inside an existing tab, or a new file. A
reviewer of such a branch asks for the entry.

## What Sova relies on

- **Delegate's block comes first.** Create's block follows it and changes nothing in it, so a change to
  Delegate's prompt reaches Create. Read [delegate](../delegate/overview.md) too.
- **Prompt and tools.** `create_guide` is in the loadout only while the chat is in Create. It carries no
  prompt snippet, so a mode switch never rewrites the system prompt.
- **Workers get none of it.** A worker gets no major mode, so the chat quotes the part of an entry a worker
  needs in its brief.
- **No default holds it.** `isMode` accepts `create`, so every place that takes a mode from a file or
  another caller must refuse it explicitly, with the wording of §design.copy-deck/create-mode. A new
  place that names a mode has to refuse too (§chat.create-mode/per-chat-only).
- **Sova only.** The terminal offers no Create and has no shortcut for it. It only must not break on a
  chat whose saved mode is `create`.
- **MCP.** Create says MCP isn't supported yet. The branch that adds MCP adds its entry.

## When you change it, also update

- A topic's line, or a change to how something changes: `site/src/content/docs/extending/index.md`, which
  lists the same topics, and `site/src/content/docs/modes/create.md`.
- The mode's block: read it against Delegate's, and remember every line is paid on every turn.
- What a card can hold: §chat.create-mode/settings-cards and the Create page's card section.
