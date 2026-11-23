# Find what fails, in real chats

Read the record first: `node scripts/record.mjs show <name>`, with the name from the run's choice The record. It prints what the subject's earlier campaigns tried, by problem, or says this campaign starts it. Keep its one-line summary ("vis: 6 attempts, 2 carried, 1 made it worse") for your first report.

The case finder (its notes: `references/roles/questions.md`) reads where it fails and recent chats like it, and reports the kinds of failure with a count each. Give it the record's output too, so a case guards each problem the record names. You read its report, not the transcripts.

Make the campaign folder now: `<worktree>/.cache/ab/<campaign>/` (a short name: `spec-tool`, `vis-dsl`), with `campaign.json` from your choices (`references/ledger.md`); its `record` is the record's name in lowercase letters, digits and dashes. Check `.cache/` is ignored by Git before anything goes in it.

If the failures turn out to be a bug rather than something a model reads wrong, say so at the next stop: a bug is fixed, not A/B tested.
