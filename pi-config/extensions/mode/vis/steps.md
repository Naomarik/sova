<!-- owner: data member. kinds/steps: HTML rows of chips, a status mark per row, lanes as heads; the label folds above its chain on a phone. Emphasis target: row label (key = item index). -->
# vis steps
Scenarios or journeys as chains, each with a status: `"Label" [tone] | step -> step -> …`, a step being a word or a "quoted label"; `== lane ==` groups rows. No ids; mark a row, not a step. `|` only separates the label from the chain: never put one inside a label or step.
```vis steps
== Asking people ==
"Simple question" ok | You -> "Maria gets a link" -> "decision recorded"
"Tony vs Bob" warn | "$5k vs $10k" -> "Tony settles"
mark "Tony vs Bob" "settle step not run yet"
```
- `mark` targets: a row's label.
