# card: what the person sees before Start, and after

Typing `/<id>` in the composer, or picking the playbook in the Playbooks list, opens its card, docked above the composer. It folds to one line. Words typed after `/<id>` go with the card to the chat.

Before Start it shows:

- **Your choices**, each with where its value came from.
- **Who runs**: each role, how many, the model with its provider, the effort, why when it isn't the first choice, and View Prompt for the exact brief it gets. Each team's coordinator and monitor too.
- **Steps**, each saying whether it runs as a team or as separate helpers, its stop points, and the cycle settings.
- **How it runs**: this chat or a new one, a new worktree, its mode, and the changing Sova commands it may use.

Edits save as the person makes them. **Start** passes only on the person's own click on the card: a chat, a tool or a program can never press it, so ask them to. It runs exactly what the card showed. Start is off, with the reason, while a required choice is empty, an "only these models" role has no model that can run, or it would need more helpers than one chat runs at once. **Save as My Defaults** keeps the choices and models for next time.

At Start, Sova freezes the card into the run's plan, writes each helper's finished brief into the run's folder, and sends the main chat one message: the playbook, and the run (choices, cast, steps, and this contents page). The card stays as the run's record. A run has its own id; when it runs in a new chat, the first chat's card says where it went.
