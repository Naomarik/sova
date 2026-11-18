# cast: who runs it: teams, their goals, and the members they must have

The main chat conducts every run on whatever model and profile the chat is set to: a playbook never sets it. Everything else is done by teams.

`teams` is an object keyed by team id. Each team has a one-line `goal` and lists only the `members` it must have; the team adds anyone else it needs. A lone helper is a team of one. Sova adds a coordinator and a monitor to every team, on the person's profile; never declare them. The team's coordinator writes each member's actual instructions from the goal, the member's brief and its notes: a playbook writes no prompts.

| Team key | What |
|---|---|
| `label` | its name on the card |
| `goal` | one line: what the team is for ("Find what moving Sova to the new pi would cost, changing nothing") |
| `members` | the members it must have, by id (unique across the playbook); may be empty |

| Member key | What |
|---|---|
| `label` | its name on the card |
| `brief` | one line, required: why it is picked for the team ("A blind grader that never sees which version wrote a reply") |
| `notes` | its working notes, `references/roles/<id>.md`: the detail the coordinator passes on (commands, rules, what to report) |
| `kind` | `planning`, `investigation`, `routine` or `complex`: the kind of work, for the fallback below |
| `models` | the preferred order: `[{"model": "provider/id", "effort": "high"}, …]` |
| `only` | `true`: one of its own models or it doesn't run (a blind grader, a test model where the provider is the point) |
| `count` | how many: a number, or `{"input": "<a number choice>"}` |
| `per` | one per item of a list or models choice: `{"input": "testModels"}` |
| `optional`, `startsOff` | the person may turn it off on the card; `startsOff` means off unless they turn it on |
| `sees` | `blind`: it must not know which version made what |
| `fresh` | `cycle`: started anew each cycle; `run` (default): kept for the whole run |

**Model refs.** `claude-code/<id>` is Sova's Claude backend (`claude-code/claude-fable-5-2`); anything else is `provider/id` of a pi model (`zai/glm-5.3`). The provider is part of the model: `zai/glm-5.3` is the ZAI subscription, not Ollama's GLM. Efforts: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

**Which model a member gets**, the first that can run: the person's pick on the card, then the playbook's list (skipping any that Settings → Models turns off), then their profile's model for the member's `kind`, then the chat's own model. The card names the model with its provider and, when it isn't the first choice, why. An `only` member never falls through: with none of its models able to run, Start is off. The run's plan keeps each member's whole list, so a member whose model stops working mid-run moves down its own list.

**Briefs and notes.** Keep a brief to one line a person reads on the card. Put everything a member must know to do its part (exact commands, rules, the shape of its report) in its notes page, in plain words: notes aren't filled in, so say "the run folder" and "this playbook's folder" (the run's message names both) and point at the run's choices by their labels. Never name a model in a brief or notes: the card decides that.
