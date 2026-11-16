# cast: who runs it, their prompts, and which models

`roles` is an object keyed by role id. `main` is the chat that conducts the run; it's optional, and its prompt is the `PLAYBOOK.md` body. Every other role is a helper:

| Key | What |
|---|---|
| `label` | its name on the card |
| `prompt` | its page, `roles/<id>.md`; required for a helper |
| `kind` | `planning`, `investigation`, `routine` or `complex`: the kind of work, for the fallback below |
| `models` | the preferred order: `[{"model": "provider/id", "effort": "high"}, …]` |
| `only` | `true`: one of its own models or it doesn't run (a blind grader, a test model where the provider is the point) |
| `count` | how many: a number, or `{"input": "<a number choice>"}` |
| `per` | one helper per item of a list or models choice: `{"input": "testModels"}` |
| `optional`, `startsOff` | the person may turn it off on the card; `startsOff` means off unless they turn it on |
| `sees` | `blind`: it must not know which version made what |
| `fresh` | `cycle`: started anew each cycle; `run` (default): kept for the whole run |

**Model refs.** `claude-code/<id>` is Sova's Claude backend (`claude-code/claude-fable-5-2`); anything else is `provider/id` of a pi model (`zai/glm-5.3`). The provider is part of the model: `zai/glm-5.3` is the ZAI subscription, not Ollama's GLM. Efforts: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

**Which model a role gets**, the first that can run: the person's pick on the card, then the playbook's list (skipping any that Settings → Models turns off), then their profile's model for the role's `kind`, then the chat's own model. The card names the model with its provider and, when it isn't the first choice, why. An `only` role never falls through: with none of its models able to run, Start is off. The run's plan keeps each role's whole list, so a helper whose model stops working mid-run moves down its own list.

**Teams.** A step that names two or more helper roles runs them as one team, and Sova adds a coordinator and a monitor to every team, on the person's team models; the card shows them and counts them toward the limit (24 at once). One helper runs alone. A step's `team` overrides it.

**Prompts.** Write each role's page as a brief: what it does, what it reads, what it writes and where, and what it reports. Put the person's choices in with `{{<choice id>}}` slots; Start fills them and writes each finished brief into the run's folder. Never name a model in a prompt: the card decides that.
