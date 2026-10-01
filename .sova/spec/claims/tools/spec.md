# §tools/spec — The spec tooling's notes to the agent
> Part of the Sova design spec · [overview](../design/overview.md)

The spec tools preserve declared requirements, keep proposed changes separate, and report what
was checked against particular inputs. Their checks establish structure and applicability, not
semantic correctness. The minor mode adds task reminders and change accounting; response wording
is not proof that implementation and requirements agree.

This milestone repairs existing promotion integrity, inspection safety, and runtime accounting.
It does not remove existing release checks. Bounded packets and observation-only assessments are
later milestones, contingent on proving this repair first.

## §tools.spec/census-note — The `[spec census]` note stays short

After a tool call that brings new changed files, the `[spec census]` note says what the census
found: its header counts, a `New:` line for the new files, a note for each new file outside the
boundary that no claim maps, and the foreign § newly touched. In `New:` each file names at most 3 of
the § that map it, then `(+N more)`; a file no claim maps still reads `unclaimed`. The fixed `Rule:`
line and the `No draft yet` line are printed once in a session per work tree, on the first note that
has them, in both pi and Claude Code workers. Returning to a work tree retains its census state.
Each `New claims under a foreign §` pair (`id → parent`) is printed once, on the same terms: a later note
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

## §tools.spec/promotion-integrity — Publication and its receipt recover together

A promotion includes both the selected current-document changes and its promotion receipt in
one recoverable operation. Failure leaves either the prior state, the complete recorded state,
or an explicit pending transaction; it never silently publishes without its receipt. Evidence
revalidation checks required implementation inputs and retained logs. Superseded evidence stays
in history but does not remain an active orphan warning after a valid replacement.

## §tools.spec/inspection-safety — Refused inputs are not inspected

The core, draft, and review commands validate path configuration before traversing it. Invalid
boundaries are rejected consistently by full and changed census. Review refusal policy applies
before incumbent contents are read. Log paths receive the same ancestor-symlink checks as other
evidence. Git-backed inspection must not execute configured clean/process filters; unsupported
configurations are explicitly refused rather than weakening the read-only contract. Partial or
unreadable draft inventories remain explicitly incomplete, not an exact empty result.

## §tools.spec/runtime-accounting — Change obligations survive correction

The parent retains worker and interrupted-run operations throughout corrective continuations;
consumption for later turns happens only after the run is settled. Worktree-configured workers
write the same parent ledger as dedicated workers. Worker accounting covers a shell call's
explicit other-worktree destination. An incomplete check is reported as incomplete. A mapped
claim may be truthfully named after an ordinary code edit, without being rejected merely because
its prose was unchanged. Writer routing changes reach sessions whose spec mode was enabled by a
note, not only sessions whose original prompt already contained spec.
