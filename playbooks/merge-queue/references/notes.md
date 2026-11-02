# Notes on landings

Each landing may carry one note: free text, at most 300 characters, shown on the landed row in the queue view, the composer's worktrees popup and the session pane, and quoted in the landing's notice. You set it with `merge.note {entry, note}`; the latest one wins; an empty note clears it. Every other merge verb you call takes `note` and sets it too.

## What goes in
Only what the playbook's "What's worth noting" lists (the project's own list wins). Write it for the user reading the queue later:
- lead with the consequence: "Changes server code: restart Sova to pick it up." not "This branch modifies server/app.ts".
- one or two sentences; several facts joined by semicolons;
- no grading, no summary of the commits, no "LGTM", no emoji.

Nothing worth noting: `merge.note {entry, note: ""}`. An empty note shows nothing; filler hides the notes that matter.

## Examples
- "Changes server code; restart Sova to pick it up. Adds a dependency (pnpm install ran offline)."
- "Renames the state file schedules.json to automations.json; the old one is read once and moved."
- "Resolved a conflict in src/app.css: both sides added rules to the same block; kept both, no rule changed."
- "Leaves the new panel behind a setting that is off by default."
