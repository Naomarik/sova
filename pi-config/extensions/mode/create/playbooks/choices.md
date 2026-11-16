# choices: what the person picks on the card

`inputs` is a list; each is one control on the card:

| Key | What |
|---|---|
| `id`, `label`, `help` | its `{{id}}` slot in prompts, and its words on the card |
| `type` | `text` (`multiline`), `number` (`min`, `max`, `integer`), `toggle`, `choice` and `multi` (`options`: `[{"id", "label", "help"}]`), `list`, `models` (a list of `{"model", "effort"}`) |
| `ask` | `always` (open every run, the default), `once` (asked the first time, then kept as the person's standing answer), `optional` (under More Options) |
| `required` | Start is off until it has a value |
| `default` | the author's value |
| `each` | `cycle`: asked again at each cycle's stop |

Each choice on the card says where its value came from: Default, Same as last time, Your standing answer, or From your message.

`facts` (`[{"id", "label", "help"}]`) are things a run looks up and shows beside the choices, never asked: the version pinned now, the latest release.

Every playbook also lets the person, without declaring anything: change each role's model and effort, turn optional roles and optional stops on or off, set the cycle settings, and add a note for one role for this run. They can't rewrite a prompt on the card: a prompt changes in the playbook, for every later run.

Ask only what changes the run. A value that's the same every time is written into the prompt, not asked.
