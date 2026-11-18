# card: what the person sees before Start, and after

Typing `/<id>` in the composer, or picking the playbook in the Playbooks list, opens its setup card in the conversation at that point, the way an alignment card stands: it scrolls with the chat, and Start is pressed there. Words typed after `/<id>` go with the card to the chat. A setup card appears only that way, or when the person reopens it, never by itself.

The chat it opens in fills the choices worked out with it. When the request is clear, it fills them and the person goes on to Start. When the chat's align mode is on and the request is ambiguous (what to test, what counts as done), it may first open an ordinary alignment, then fill the choices from what was decided. Nothing forces that alignment: a clear request, or align mode off, goes straight to the card.

A playbook can also require an alignment (`align` in `playbook.json`, section `choices`): then `/<id>` always opens it first, whatever the align mode, with the playbook's questions. When the person confirms it, its decisions fill the choices (marked From your alignment) and the setup card appears. If they drop it, the card appears with those choices empty, and Start says why.

Before Start it shows:

- **Your choices**, each with where its value came from. A choice worked out with the main chat is read-only and waits for the chat to fill it.
- **Who runs**, folded by default to its count of teams and required members. Open, one block per team headed by its goal, listing its required members: how many, the model with its provider, the effort, why when it isn't the first choice, and the one-line brief. A line says the team adds anyone else it needs. The main chat and each team's coordinator and monitor aren't listed.
- **Steps**, each naming the team that works on it, its stop points, and the cycle settings.
- **How it runs**: this chat or a new one, a new worktree, its mode, and the changing Sova commands it may use.

The person can change the short choices, each required member's model and effort, optional members and optional stops, the cycle settings, and add a note for a member for this run. Edits save as they make them. **Start** passes only on the person's own click on the card: a chat, a tool or a program can never press it, so ask them to. It runs exactly what the card showed. Start is off, with the reason, while a required choice is empty (one the chat fills included), an "only these models" member has no model that can run, or it would need more helpers than one chat runs at once. **Save as My Defaults** keeps the choices and models for next time.

At Start, Sova freezes the card into the run's plan and sends the main chat one message: the playbook, and the run (choices, each team's goal with its required members, which team works on which step, the steps, and this contents page). The setup card stays in place as the read-only record of what was agreed, and the started run moves to a strip above the message box. A run has its own id; when it runs in a new chat, the first chat's card says where it went.
