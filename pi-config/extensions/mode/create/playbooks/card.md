# card: what the person sees before Start, and after

Typing `/<id>` in the composer, or picking the playbook in the Playbooks list, opens its setup card in the conversation at that point, the way an alignment card stands: it scrolls with the chat, and Start is pressed there. Words typed after `/<id>` go with the card to the chat. A setup card appears only that way, or when the person reopens it, never by itself.

The chat it opens in sets the card from what the person asked, so they needn't touch it: the choices worked out with it, and anything else they said when asking ("on GLM", "three cycles", "no grader", "don't stop after the baseline"), each onto the card's own setting through the card's commands. When the request is clear, it sets them and the person goes on to Start. When the chat's align mode is on and the request is ambiguous (what to test, what counts as done), it may first open an ordinary alignment, then fill the choices from what was decided. Nothing forces that alignment: a clear request, or align mode off, goes straight to the card.

A playbook can also require an alignment (`align` in `playbook.json`, section `choices`): then `/<id>` always opens it first, whatever the align mode, with the playbook's questions. When the person confirms it, its decisions fill the choices (marked From your alignment) and the setup card appears. If they drop it, the card appears with those choices empty, and Start says why.

Before Start it shows:

- **Your choices**, each with where its value came from. A choice worked out with the main chat is read-only and waits for the chat to fill it.
- **Who runs**, folded by default to its count of teams and required members. Open, one block per team headed by its goal, listing its required members: how many, the model with its provider, the effort, why when it isn't the first choice, and the one-line brief. A line says the team adds anyone else it needs. The main chat and each team's coordinator and monitor aren't listed.
- **Steps**, each naming the team that works on it, its stop points, and the cycle settings.
- **How it runs**: this chat or a new one, a new worktree, its mode, and the changing Sova commands it may use.

The person, or the chat on their word, can change the choices, each required member's model and effort (within its own list, or any model Settings → Models allows when the member isn't "only these models"), optional members and optional stops, the cycle settings, and a note for a team or a member for this run. Edits save as they are made, and the card says where each value came from. Three things pass only on the person's own click on the card: **Start**, **Save as My Defaults** and **Close Card**; a chat, a tool or a program can never press them, so ask the person to. Start runs exactly what the card showed. It runs exactly what the card showed. Start is off, with the reason, while a required choice is empty (one the chat fills included), an "only these models" member has no model that can run, or it would need more helpers than one chat runs at once. **Save as My Defaults** keeps the choices and models for next time.

At Start, Sova freezes the card into the run's plan and sends the main chat one message: the playbook, and the run (choices, each team's goal with its required members, which team works on which step, the steps, and this contents page). The setup card stays in place as the read-only record of what was agreed, and the started run moves to a strip above the message box. A run has its own id; when it runs in a new chat, the first chat's card says where it went.
