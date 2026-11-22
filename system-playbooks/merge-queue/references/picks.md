# Picks: checks beyond the folder rules

The project declares its required checks (they always run), optional checks (`"optional": true` in `.sova/project.json`'s merge section: they run only when something adds them), and folder rules (`rules` in the merge section: "when these paths change, run this check with this selection", each with its reason). Sova applies the rules itself at the start of every run, reading them from the branch being landed, so a branch that edits a rule lands under its own edit; the run shows those checks as Triggered, with the rule's reason and the paths that matched. You add only what the rules miss, each with one line saying why. You never remove or replace a check, a rule's or a required one, and never invent a command: you name check ids the project declares.

## How
1. Read the rules as the branch has them: `git show <commit>:.sova/project.json` (the `rules` of its merge section). No rules: every pick is yours, from the diff alone.
2. Read the diff against them. Add a pick when the change reaches a check's area through a path no rule lists (a shared helper the composer imports, say); its `why` names the path and the reach. A pick that asks for exactly what a rule already runs only adds your reason to it, so don't repeat the rules.
3. `merge.extend {entry, checks: [id], why, select}` for each pick (one call per reason; picks sharing a reason may share a call). `select` narrows a check to files, groups or walkthroughs where the check takes them; a check that takes one selection per run (`"perSelector": true` on it) gets one call per selection. A check whose definition declares `needsSelect` is refused when the pick names no `select` ("… runs with a selection: send the pick's select"): send it again with one. Only a trial runs such a check bare.
4. A rule the project should have (the same pick, landing after landing): say so in the entry's note for the user; never edit `.sova/project.json` yourself.

## Timing
A pick that reaches Sova before the entry's run starts is in its plan. One that arrives while the run's checks run is added to that run after the planned checks, shown with when it arrived, and the run doesn't land or push until it ran and passed. One that arrives after every check ran, while the tested tip waits to land (for the user's Allow or Land Anyway, or a resume), sends the run again from the start with it planned: nothing lands or is pushed without it. After two such reruns of one commit its runs take no more picks ("… has already run again 2 times …"), and once the entry landed `merge.extend` is refused ("… is landed: nothing to extend"). Never ask Sova to wait.

## The reason line
Plain, short, specific: "src/lib/ws.ts changed: the composer reads it, drive its walkthroughs". The run page shows it beside the check as picked by the merge thread.
