# cards: buttons, cards and drawings that are your project's own

Recommend an offer when the person wants a button that answers a question or runs one thing; a card type when a chat should show a question, checklist, status or table of the project's own; a view card only when none of those will draw it; and a drawing kind for a picture with no answer. Everything here needs a project in Git. In a folder that isn't a project, offer Add as Project (the `project` topic). With no queue the branch is the person's to merge; with no Git the files are made by hand.

## Offers

- Change: a button card the agent may show under its reply, up to 8 per project, each saying when it may show and what its 1 to 4 buttons do. A `send` button sends a message as the person, so it does only what a chat can do when asked; it can't start or restart the project's main copy, for one. A `run` button runs Sova's own command, and only `project.worktree.merge` is allowed, for a session the project's overseer tracks. So before you offer a button, check that a chat could do the job if the person typed it. If it couldn't, say a button can't do this and name the control that can: for a server, the Branches tab (the `project` topic).
- Lives: `.sova/offers.json` in the project. Only the main branch's file counts: a branch can't give itself offers.
- Approves: the person, by Land or Apply. Send buttons need nothing more. Run buttons need the person's own click in the page: Approve Run Buttons on the project page's Offers list, or Apply and Approve on the card. They ask again when they change.
- By: Card or Land. The card is the `offers` setting and holds the whole file, or null to remove it. A card lands with no checks: where the project's checks could catch this change, choose Land, or say so before Apply.
- Live: once on the main branch. An offer removed or disabled stops at once, in running chats too; a new offer reaches new chats, because a chat keeps the set it started with.
- Check: the project page's Settings tab lists each offer, with why it's broken if it is. Start a new chat and bring about its `when`.

Recommend send buttons first:

```json
{"version": 1, "offers": {"carry-on": {
  "when": "A step finished and the next one is clear.",
  "title": "Carry on with the next step?",
  "buttons": [{"label": "Carry On", "about": "Tells the chat to start the next step.", "send": "Carry on."}]
}}}
```

## Card types

- Change: a card a chat can raise, up to 16 per project. `draws` picks one Sova draws from data (`question`, `checklist`, `status`, `table`, `buttons`) or `view`, the project's own view. A type with `when` can be raised by the agent; one without is raised only from outside, by a script or a project mode's hook.
- Lives: `.sova/cards/<name>/card.json` in the project, and `view.tsx` beside it for a view, which also needs `data`, the shape of its data. A chat reads the checkout it runs in, so a chat in a worktree uses its own branch's cards.
- Approves: the person, by Land. The first time a card wants to act (send a message or run a command that changes something; a view, any command) it asks, and the person presses Trust {project}'s Cards. That covers the whole project from then on; Stop Trusting Cards on the Cards section ends it.
- By: Land. No card holds these.
- Live: new chats after landing, since each chat keeps the types it started with. A chat in the worktree gets them in its own new chats sooner. Saving a `view.tsx` redraws open cards within about a second.
- Check: the project page's Settings tab, Cards section, lists each type or says what's broken. Then ask a new chat to raise one: a chat has the `card` tool only when it holds a type with `when`.

A data card takes no `data` shape: Sova's own is used.

```json
{"version": 1, "toolkit": 1, "title": "Release checklist", "when": "Before a release, to track its steps.", "draws": "checklist", "answer": "at-once"}
```

## Drawing kinds

- Change: a kind of drawing of the project's own, up to 8, which a chat draws with a `vis project.<name>` fence. It has no answer and runs no commands, so it needs no trust.
- Lives: `.sova/drawings/<name>/` in the project: `kind.json`, `view.tsx` and `GUIDE.md`, which the agent reads to learn it.
- Approves: the person, by Land.
- By: Land. No card holds these.
- Live: new chats after landing, with vis on. A chat keeps the kinds it started with. Saving `view.tsx` redraws open drawings.
- Check: the Cards section lists it or says what's broken. In a new chat with vis on, ask for one.

```json
{"version": 1, "toolkit": 1, "accepts": "text"}
```

## Sova's own cards

- Change: nothing: a project can add cards but can't replace or change Sova's own, and a kind with a dot in its name can never be mistaken for one of Sova's.
- Lives: inside Sova.
- Approves: nobody: there's no change to approve.
- By: None.
- Live: never.
- Check: there's nothing to check.
