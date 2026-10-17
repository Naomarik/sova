<!-- owner: data member. kinds/steps: chains of steps per row, a status mark per row, lanes as heads; 2–4 rows without lanes stand side by side (equal steps merged), else an aligned grid, a numbered list on a phone (layout.ts). Emphasis target: row label, or a step's text (key = item index). -->
# vis steps
Scenarios or journeys as chains, each with a status: `"Label" [tone] | step -> step -> …`, a step being a word or a "quoted label"; `== lane ==` groups rows. No ids; mark a row, not a step. `|` separates the label, the chain and an optional outcome: never put one inside a label or step.
- A tone after a quoted step marks that step: `"token expired" error`. End a row with `| "outcome"`, its result or cost in a few words (`| "3 tries"`), to compare rows by it.
- Step N of every row lines up. In a step's place, `^` repeats the step at that position in the row above (same lane) and `_` leaves it empty. Up to 4 rows with no lanes stand side by side, and equal steps there merge into one: `"Fix" ok | ^ -> ^ -> _ -> "signed in"`.
```vis steps
"Simple question" ok | You -> "Maria gets a link" -> "decision recorded" | "1 day"
"Tony vs Bob" warn | ^ -> "Tony and Bob get it" -> "they disagree" warn -> "Tony settles" | "6 days"
mark "Tony vs Bob" "settle step not run yet"
```
- `mark` targets: a row's label.
