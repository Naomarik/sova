<!--
The file format, for whoever writes a topic.

  Line 1 is the topic's line in the table of contents, exactly: `# <topic>: <words>`.
  Then an optional paragraph on choosing between the things below (recommended first).
  Then one `## <thing>` section per thing the topic covers, each with these six lines, in this order:

    - Change: what can be changed.
    - Lives: where it lives, as a place on the person's computer or a screen.
    - Approves: who approves it.
    - By: Screen, Card, Land, OK, Terminal or None, then anything that word needs.
    - Live: when it shows: now, next turn, next tool call, new chat, rebuild, restart, off and on, after landing.
    - Check: how to see that it worked.

  `By:` starts with one of those six words, or two joined by " or " ("Card or Land"). A line may run on
  after its first sentence; nothing but those six lines belongs in the list. A fenced example may follow
  the list, inside its section: a minimal one for anything a chat writes for the person.
  Paths: exact, from a named root: `<agent dir>/sova/themes/<id>.json`, `<project>/.pi/skills/...`.
  An entry stands alone. It names no Sova source file, no spec, no `§` ID and no checkout: a chat in any
  project reads it. It may name the public guide that goes further, by the page's path (/docs/...).
  Only what has landed goes in. Owner notes like this one never reach the model.
  guide.test.ts holds this format. server/create-guide-growth.test.ts holds which topic owns which item of
  Sova's own lists; its failure message is the worklist.
-->
How to read this entry. Each thing below says what can be changed, where it lives, who approves it, how it changes, when it goes live and how to check it. The word after `By` says how the change is made:

- Screen: name the screen and control; the person makes the change.
- Card: prepare it with `sova_settings` propose. You prepare, and the person presses Apply; you never apply one, even a change that narrows.
- Land: a worker makes it on a branch in a worktree, and the person lands it. You never land one. A change to how a project runs goes by Land when the project has checks, even as one file.
- OK: show the path and the whole change, then wait. Only the person's own message in this chat is an OK. Then write it yourself, or under strict have a worker outside any worktree write it.
- Terminal: name the command; the person runs it in a terminal.
- None: there's no supported way today. Say so and offer the nearest way.

Rules for every topic:

- Credentials never pass through you. No card, file or message of yours carries a key, a token or a sign-in. If someone pastes one, don't use it, and tell them to sign in the supported way.
- Resolve links before you write. A file that links into Sova's own folder is Sova's: offer a way in the person's own folder instead.
- After a change, say when it shows and how to check it, in the entry's words. Promise nothing sooner, and don't claim to show in this chat what only a new chat can show.
- When a change reaches the person's other computers by sync, say so before their OK.
