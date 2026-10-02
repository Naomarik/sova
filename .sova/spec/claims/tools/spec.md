# §tools/spec — The spec tooling's notes to the agent
> Part of the Sova design spec · [overview](../design/overview.md)

The spec tools preserve declared requirements, keep proposed changes separate, and report what
was checked against particular inputs. Their checks establish structure and applicability, not
semantic correctness. The minor mode adds task reminders and change accounting; response wording
is not proof that implementation and requirements agree.

Complete graph queries remain available to machine consumers. Task-facing packets deliver exact
requirements within an explicit whole-response budget, with continuation and unknowns kept visible.
They change context delivery, not release policy. Structured observation-only assessments are separately
recorded input-bound comparisons, not proof of requirements truth or mandatory release policy.

## §tools.spec/change-assessments — Input-bound structured comparisons

Observation-only structured assessments retain explicitly routed claim candidates and unmapped
changed files with changed, preserved, not-applicable or unresolved recorder dispositions, reasons
and verification bases bound to exact claim and implementation inputs. Absent, unreadable,
uninvestigated or changed inputs remain explicitly unknown or stale. No disposition, declared
label or applicable receipt establishes semantic correctness or changes release policy. Batch
exclusions retain candidate identities without duplicate claim prose.

Durable metadata-only receipts keep declared labels, accepted-intent assertions, recorded
verification outcomes and current input applicability distinct, with nullable task and worker
attribution. Preparation starts every candidate unresolved; omission never excludes it. Explicit
paths and caller-declared snapshot baselines support projects without Git; missing baselines remain
unknown. In Git projects, resolved commit hashes and initial dirty snapshot hashes are separately
identified. Assessment-specific inspection refuses its own receipt storage before graph, claim-tree
or lazy incumbent contents are read, including optional draft triage's current-tree reads; ordinary
inspection CLI policies keep their existing behavior.
Refused inputs are not read, raw source and logs are not retained, and concurrent
cooperating writers cannot overwrite immutable receipts. The tools do not authenticate identity or
infer exhaustive behavioral candidates. Status enumeration preserves unread, corrupt and capped
receipt inventories as incomplete and keeps unknown owner attribution visible.

Each capture uses a fresh in-memory inspection graph and batches immutable Git blob inspection
without dropping routed candidates, closure inputs or refusal findings. Separate captures and
status checks do not share cached source state, and existing inspection CLI output and refusal
contracts remain unchanged. The raw manifest and claim bytes actually parsed by that graph must
match their bound present input hashes within the capture; mixed source versions refuse as a race,
even when the requested claim's own prose is unchanged. Optional draft triage binds the exact
proposed, baseline and current manifest/claim sources it reads; changes to those inputs stale prior
assessments even when candidate identities and reasons stay unchanged.

## §tools.spec/assessment-observations — Automatic unresolved observations

With spec enabled, observed task changes automatically create unresolved structured observations
with a fixed task base and actual nullable parent, worker, task and attempt attribution. Retries
and reopen preserve task identity and prior immutable receipts. Repeated changes to one path and
late task-settle changes are observed by input fingerprints, not only new filename detection.
Observation reports scope changes, not forensic authorship; ownership ambiguities remain unknown.
Native Claude Code worker hooks collect the same unresolved observations and retain task identity
only when the backend supplies a known prompt boundary identifier; otherwise task attribution stays
null and unknown rather than guessing from prompt text or the time. The server cannot verify native
task boundaries with its pi-session reader, so native task attribution remains unknown; private native
hook error markers are not themselves parent receipts, and missing receipts mean absent evidence and
unknown applicability, not a successful comparison or an inferred cause.

An explicit assessment tool records or queries dispositions and structured verification results.
It flags failed or unavailable CLI operations as SDK tool errors while retaining their structured
content and details. Successful preparations and records remain normal operations even with
outstanding claims or failed verification declarations, and stale or unknown status remains a valid
observation query. These flags never change continuations, release gates or readiness.
Session-list and merge-readiness refreshes do not consume assessment receipts or query their
status. Explicit assessment queries and automatic runtime observations remain available without
changing ordinary readiness checks, footer rules or release gates. A newer unresolved same-task observation is not
hidden by an older preserved record. Failed verification remains an explicit outcome distinct from
current input applicability and the recorder's disposition. Legacy labels without receipts remain
declarations with unknown assessment provenance.

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

## §tools.spec/context-packets — Exact context within a whole-response budget

The read-only `packet` command complements the existing complete-graph `scope` API; it does not
change that API's output or prose-only budget semantics. Its default response budget is 12,000
UTF-8 bytes, including all serialized JSON metadata, cursor data, and the terminating newline.
Supported explicit budgets are integers from 1,024 to 32,768 bytes. Every response with a supported
budget, including errors, fits it; invalid-budget errors use a small bounded response of their own.
Packet output is compact JSON, not a large human rendering or an unbounded stderr side channel.

Passages are the exact text the scope API supplies, never generated summaries. Every prose item,
whole or fragmented, includes its declared kind and any authority/evidence labels; absent labels
stay absent. These are recorded statuses, not a verdict derived by the packet. The requested
claim comes first; its parent orientation and nearby declared obligations precede distant
transitive material in a deterministic order. Oversized prose is delivered as explicit fragments
whose concatenation exactly recovers the original text, preserving Unicode and long lines. A
fragment never claims to be the whole claim. Pagination must make progress or return an explicit
budget/refusal result, never an empty-success loop or silent omission.

The packet separates prose delivery from compact inventories of unread passages, dependency
unknowns, and code locations. Detailed inventories can be paged without dumping them into every
prose response. Counts and continuation make omitted material discoverable. A readable page is
not evidence of a complete behavioral context, a complete dependency graph, or an agent having
read previous pages. Exit/status fields and the guide state those distinctions explicitly.

Continuation tokens bind the requested identity and the captured spec inputs; a changed manifest,
claim source or relevant reported input state invalidates the continuation rather than silently
mixing versions. Malformed, out-of-range and mismatched tokens are refused within the budget.
Tokens are navigation state, not authenticated reviewer identity or proof that earlier pages were
read. The actual ordered streams and serialized inventory data also participate in the fingerprint,
so changing the records or order being navigated invalidates an old token. The command stores no
sessions, cursors, or source snapshots and runs no project code.

The minor-mode guide uses bounded packets for task reading and tells the agent to finish relevant
fragments and inspect the stated frontier and findings, including warnings about missing code. Full graph tools remain available for deliberate
machine inspection and review. No new mandatory assessment or release gate is introduced here.

### Reading a packet

`packet '§ns/name'` starts the prose stream. `--part inventory|frontier|code|findings` starts a
detailed inventory independently; `--cursor` continues the chosen stream, and the budget may be
changed between pages. Counts name the whole streams; `remaining` and `next` describe only the
selected stream. An empty stream terminates without a cursor. `packet --help` also returns small
bounded JSON. The global help and the existing graph commands keep their existing formats.

Prose fragments carry exclusive UTF-8 byte ranges. Their `complete` flag means that this one item
contains the whole passage; the final piece of a previously fragmented passage is still partial.
Finish contiguous ranges through `end == total`, not by waiting for that flag to become true.
Oversized inventory records may likewise carry fragments of their exact JSON serialization;
joining and parsing them recovers the original record. No record is silently discarded to fit.

Exit 0 means the selected stream is done and the underlying scope has no warnings. Exit 1 means
that stream has more pages or scope warnings remain. Exit 2 is a refusal. A missing manifest carries
bounded `cause: manifest-not-found` so the agent can start a draft; a malformed graph does not carry
that cause. An orphaned claims tree still refuses destructive draft creation. Navigation status and
scope uncertainty remain distinct; none of these establishes semantic completeness or prior reading.
Raw manifest and claim bytes, traversal identity, safely read provenance inputs, and reported scope
states participate in cursor binding. Code contents that were not read are not
snapshotted. Refused inputs are not reopened merely to compute a fingerprint.
