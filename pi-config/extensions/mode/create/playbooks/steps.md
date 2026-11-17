# steps: steps, stop points, cycles and flows

`steps` is a list, run in order:

| Key | What |
|---|---|
| `id`, `label` | its name, and its words on the card |
| `goal` | one line: what the step achieves |
| `teams` | the teams that work on it, by id; none: the main chat alone |
| `stop` | `always`: the run waits for the person here; `optional`: a tick on the card (`startsOff`: off unless ticked) |
| `asks` | more things it stops for, a few words each ("the baseline would have to grow") |
| `report` | what it shows before it's done: `chart`, `table` or `verdict` |
| `phase` | its page, `phases/<id>.md`, read when it begins |

At a stop the run shows its report, then waits for the person's words: go on, stop here, or something else.

**A cycle.** At most one step may repeat a group of steps:

```json
{ "id": "cycle", "label": "Improve and re-test",
  "repeat": { "max": 5, "askEvery": 1, "until": "rule", "rule": "phases/stop-rule.md",
              "carry": "The winner becomes the next base" },
  "steps": [ … plain steps … ] }
```

How it goes round is the person's to set on the card, from these defaults: `max`, how many times at most (up to 50); `askEvery`, after how many cycles it stops to ask (1: every cycle; the same as `max`: only at the end); `until`, `rule` (stop once the playbook's rule is met, or at `max`) or `max` (always run `max`, the rule only reported). `rule` is the stop rule in words, or a page holding it; `carry` says what goes into the next cycle.

**A state machine**, `machine`, instead of `steps`, for a flow that loops back or ends early ("review failed → back to fix", "no new release → done, quietly"):

```json
{ "initial": "find",
  "states": { "find": { "label": "Find the target", "on": { "nothing-to-do": "done", "found": "research" } },
              "research": { "label": "Research", "teams": ["research"], "on": { "done": { "to": "report", "when": "the judge says complete" } } },
              "report": { "label": "Report", "stop": "always", "on": {} },
              "done": { "label": "Nothing to do", "quiet": true, "on": {} } } }
```

A state with no moves ends the run; `quiet` ends it with no report; a move's `limit` caps how often it's taken. Sova checks the machine is whole, but the main chat follows it and says where it is: use steps unless the flow needs to loop or exit early.

The main chat follows the steps and reports each in an ordinary message; it stops at a stop point by ending its turn.
