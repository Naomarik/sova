# §tools/spec — The spec tooling's notes to the agent
> Part of the Sova design spec · [overview](../design/overview.md)

What the spec minor mode tells a coding agent while it works: the notes its hooks append to tool
results, in pi sessions and workers and in Claude Code workers alike.

## §tools.spec/census-note — The `[spec census]` note stays short

After a tool call that brings new changed files, the `[spec census]` note says what the census
found: its header counts, a `New:` line for the new files, a note for each new file outside the
boundary that no claim maps, and the foreign § newly touched. In `New:` each file names at most 3 of
the § that map it, then `(+N more)`; a file no claim maps still reads `unclaimed`. The fixed `Rule:`
line and the `No draft yet` line are printed once in a session per work tree, on the first note that
has them (in a Claude Code worker, once each time its calls move to another work tree, even one
seen before), and each `New claims under a foreign §` pair (`id → parent`) is printed once, on the
same terms: a later note
lists only pairs not printed before, still at most 12 with `(+N more)`, so pairs held back by the
cap come in a later note, and the line is left out when there is none. Apart from the skipped tools
below, the note fires in exactly the cases it did before, and the census still counts every foreign
§ it saw, printed or not, so the end-of-turn check accepts any of them.

The census is skipped after a tool that cannot write the repository, by an explicit list of tool
names: in pi, read, grep, find, ls, align, agent_list, agent_models, agent_transcript, agent_wait,
team_list, team_inbox, team_roster, link_inbox, link_members and link_offers; in Claude Code, its
own read-only tools and the team tools team_inbox, team_msg, team_ask, team_roster, team_report and
wake_nudge. A skipped call neither looks at the tree nor moves the census's baseline, so the next
call that can write reports every change since. Shell commands are never skipped.
