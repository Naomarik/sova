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
- Land: a worker makes it on a branch in a worktree, and the person lands it. You never commit to the main branch, and you merge or land only on the person's word in their own newest message, as the Create instructions say. A change to how a project runs goes by Land when the project has checks, even as one file.
- OK: show the path and the whole change in your reply, every file and whole, then wait. Only the person's own message in this chat, after they've seen that, is an OK. An alignment's go-ahead or a decided question is not one: after an alignment, still show the files and wait. Then write it yourself, or under strict have a worker outside any worktree write it.
- Terminal: a shell command on the person's computer, outside this chat. Name the exact command; the person runs it. Create itself is only in Sova's chats.
- None: there's no supported way today. Say so and offer the nearest way.

Rules for every topic:

- Before you offer a change to a project, of any topic, find out where this chat is: call `sova_settings` get. It says whether this folder is a project, whether it's in Git, and in its merge queue row whether a queue is set up. Then say which case this is, before you offer the change:
  - A project with a merge queue: Card and Land work as above.
  - A project with no merge queue: there's no Land, so don't promise it. A worker still makes the change on a branch in a worktree, and the merge is the person's own, whenever they're ready: you do it only on their word, "merge it" or "land it" in their own newest message. Say so, and offer Initialize on the project page's Merge Queue tab.
  - A folder that isn't a project: say so, and offer Add as Project first. There are no cards and no Land here. If they'd rather not, it goes as in a project with no merge queue.
  - A folder that isn't in Git: say the change is made by hand.
- Credentials never pass through you. No card, file or message of yours carries a key, a token or a sign-in. If someone pastes one, don't use it, and open the `models` entry before you say where to sign in: name only the way it gives.
- `<agent dir>` in a path is this Sova's own folder. Before you name, read or write such a path, run `echo "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"` and use exactly what it prints, every time; never assume `~/.pi/agent`. `<project>` is the root of the chat's project.
- Resolve links before you write. A file that links into Sova's own folder is Sova's: offer a way in the person's own folder instead.
- After a change, say when it shows and how to check it, in the entry's words. Promise nothing sooner, and don't claim to show in this chat what only a new chat can show.
- When a change reaches the person's other computers by sync, say so before their OK. If you don't know whether sync is on, say "if sync is on"; never say it won't spread.
