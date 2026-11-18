# choices: what the person picks on the card

`inputs` is a list; each is one control on the card:

| Key | What |
|---|---|
| `id`, `label`, `help` | its name, and its words on the card |
| `type` | `text` (`multiline`), `number` (`min`, `max`, `integer`), `toggle`, `choice` and `multi` (`options`: `[{"id", "label", "help"}]`), `list`, `models` (a list of `{"model", "effort"}`) |
| `ask` | `always` (open every run, the default), `once` (asked the first time, then kept as the person's standing answer), `optional` (under More Options), `chat` (worked out with the main chat in the conversation and filled in by it; `text` or `list` only) |
| `required` | Start is off until it has a value |
| `default` | the author's value |
| `each` | `cycle`: asked again at each cycle's stop |

Each choice on the card says where its value came from: Default, Same as last time, Your standing answer, or From your message.

Use `chat` for anything the person would explain rather than type in a box: what goes wrong, what counts as done. The card shows it read-only until the main chat fills it, and Start stays off while a required one is empty; a `default` is the chat's starting point. Keep picks, numbers, toggles and models on the card.

`align` makes the run start with an alignment, for a playbook where measuring or doing the wrong thing would waste the run: `{"questions": [{"id", "ask", "fills"}]}`, each `ask` one line and each `fills` the id of a `chat` choice its decision fills. Without it, the chat aligns first only when its align mode is on and the request is ambiguous.

`facts` (`[{"id", "label", "help"}]`) are things a run looks up and shows beside the choices, never asked: the version pinned now, the latest release.

Every playbook also lets the person, without declaring anything: change each required member's model and effort, turn optional members and optional stops on or off, set the cycle settings, and add a note for one member for this run. Goals, briefs and notes change in the playbook, for every later run.

Ask only what changes the run. A value that's the same every time is written into the playbook (its recipe, a phase page or a member's notes), not asked.
