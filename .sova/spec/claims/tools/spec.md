# §tools/spec — The spec tooling's notes to the agent
> Part of the Sova design spec · [overview](../design/overview.md)

The spec tools preserve declared requirements, keep proposed changes separate, and report what
was checked against particular inputs. Their checks establish structure and applicability, not
semantic correctness. The minor mode adds task reminders and change accounting; response wording
is not proof that implementation and requirements agree.

Complete graph queries remain available to machine consumers. Task-facing packets deliver exact
requirements within an explicit whole-response budget, with continuation and unknowns kept visible.
Beside the full-closure packet, a contents view (`toc`) lists a claim's one-hop neighbours with what
each is and why it is linked, and single-passage reads (`read`) return one claim without its chain,
so the agent chooses what it reads.
A map (`map`) shows every area on one page, and `where` finds the claims for a source file or a name.
They change context delivery, not release policy. Structured observation-only assessments are separately
recorded input-bound comparisons, not proof of requirements truth or mandatory release policy.
A shipped playbook runs these tools for a review the operator starts, inside limits the operator
sets, and only then.

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

## §tools.spec/assessment-observations — Assessments run only when asked

No session, pi worker, worktree-configured worker or Claude Code worker hook runs an assessment
capture, records a task baseline or writes an assessment receipt by itself: not when a task starts,
after any tool call, when a run settles or when a session reopens, with spec on or off. Sessions and
workers have no assessment tool. An assessment is an explicit companion CLI operation that an
operator or agent asks for: `prepare` against a declared known base revision, then `record` and
`status`. Its receipt names that declared base, never a claimed task start. Nothing captures a
snapshot baseline on the caller's behalf, so a late call cannot subtract the task's own earlier edits
or commits: with a known base and no declared snapshot, every committed and working-tree change since
that base is included. Attribution is only what the caller passes; absent attribution stays null.

Receipts and session task and error entries left by earlier automatic observation stay as they are:
readable, immutable, and never migrated, rewritten or deleted. A native hook's state from then keeps
its assessment fields unchanged and ignored: it loads without an error, a failure note or a new
capture, while its ordinary census and turn fields go on updating. Session-list and
merge-readiness refreshes do not consume assessment receipts or query their status. Explicit assessments never change continuations, ordinary
readiness checks, footer rules or release gates. Successful preparations and records remain normal
operations even with outstanding claims or failed verification declarations, and stale or unknown
status remains a valid query. A newer unresolved same-task observation is not hidden by an older
preserved record. Failed verification remains an explicit outcome distinct from current input
applicability and the recorder's disposition. Legacy labels without receipts remain declarations
with unknown assessment provenance.

## §tools.spec/review-playbook — A spec review runs only when the operator starts it

Sova ships a Spec review playbook (`playbooks/spec-review/`, §chat.playbooks): one Markdown entry
with no script and no state of its own. It answers one question about a project's spec, either
comparing code and docs against a known base revision or looking back at how the spec workflow went,
never both in one run, and only when the operator sends it. It declares no schedule, and leaves no
worker, monitor or timer running after its report.

Its brief names the question, the kind, the root, a base that is an ancestor of HEAD, the scope and
the limits: minutes, report length, model runs and tokens. A brief the operator's message gives in
full is approved as sent; otherwise only a bounded preflight runs before the operator approves one.
That preflight refuses a root that isn't the checkout's top folder, or a base that isn't a commit
and an ancestor of HEAD, before it lists anything; otherwise it prints the full base and at most 201
lines of the files changed since it. The approved scope is frozen: a file changed later is reported
as outside it and never read, and a supporting read stays inside the root, scope and limits and is
named in the report. The limits are cooperative: nothing enforces them, the report gives each as
observed or unknown, a packet budget bounds only the bytes of the page it returns, and while token
use is unknown the run asks before any further model run.

A run writes nothing beyond its chat: no files, no assessment receipts, no workers, no cleanup. It
reads with git, with the helpers known to apply turned off (fsmonitor, external diff, textconv;
not a sandbox), with the trusted spec tools at the declared base, and with the agent's own file
reading. Each published command re-establishes the tools' location, root and base itself, never
relying on an earlier call. A request for a durable assessment receipt is reported as needing a
separate opt-in method, since the companion has no bounded view of its capture. The report has
fixed sections within the report length and keeps observed, inferred and proposed apart; changes to
the playbook's own method appear there only as proposed diffs, never applied by the run.

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

## §tools.spec/span-promotion — Promotion merges per declaration, not per file

Promotion compares base, current and draft per declaration (an H1 lede or an H2 span), not per
claim file. When current and the draft both changed one claim file, the draft's changed
declarations are applied and current's other changes are kept, unless a declaration was changed
on both sides differently, or deleted on one side and changed on the other: that still stops as a
conflict, and neither side's prose is dropped. Bytes outside every declaration (text before the
lede, blank lines after a span) merge as the gap they sit in; a gap changed differently on both
sides is a conflict. New declarations that both sides inserted after the same kept declaration
are placed in a fixed order: each side's run stays together, and the run whose first identifier
sorts first comes first, so the bytes don't depend on which side landed first. A file whose kept
declarations were reordered, that holds a carriage return, or whose graph on any side doesn't
load, is still compared as a whole file. A merged file must read back as exactly the declarations
it was merged from, byte for byte, or the promotion is refused as a conflict and nothing is written.

## §tools.spec/agreed-promotion — An agreed promise lands in the main spec before it is built

A behavior or surface record may carry `agreed: {by, at}`: who made the decision it records, and
when (an ISO date, optionally with a time). It names who decided and when, not that they read the
record's current words; no tool checks what the prose means. A later promotion may reword the prose
and keep `agreed`. A change of meaning goes back to the person who decided, and their new agreement
replaces `agreed`: a promotion may replace the `agreed` of a record current already has only when
the same promotion also changes that record's prose and the new `at` is not earlier than the old
one. A promotion that changes `agreed` on unchanged prose, or that removes it without deleting the
whole record, is refused, so the later build updates the same record and still says who decided,
and nobody re-stamps a decision silently. A record with `agreed` and no `code` may be
promoted on doc-only evidence, as notes and sections are: that records the decision, not that
anything was built. A record reads as built only when it has `code` and the `evidence` label
`reviewed` or `verified`, so doc-only evidence for an agreed record that declares either one is
refused, and an agreed record that maps code still needs commit or snapshot evidence of that code.
An `agreed` that is not an object with a non-empty `by` and a valid date `at`, or that sits on a
note or section, is refused at evidence and at promotion. `agreed` is a record field, not a label
value, so a core that predates it still loads a manifest carrying it.

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
detailed inventory independently, and `--part frame` the always-on frame (§tools.spec/frame); `--cursor` continues the chosen stream, and the budget may be
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

## §tools.spec/spec-map — `map` shows every area on one page

The read-only `map` command is an orientation view computed from the manifest and the claim files.
Without an argument it lists each namespace and, under it, each H1 area with its § id, its heading
title, its lede's first sentence (the contents view's **what**), its number of claims, its counts by
declared `authority` and `evidence` label, and how many `requires` edges leave it for other areas
and arrive from them. After the areas come the hubs, the ten code files the most records list, each
with that count, and the gap counts: behaviors with no `requires` key, records with no `code`,
passages with no prose sentence, and records with no interface token (as §tools.spec/where-lookup
defines one). `map <namespace>` limits all of it to one namespace; a namespace with no area is
refused. `map '§ns/name'` shows one area: its H1, then its H2s in declaration order, each with kind,
labels, code count, its declared `requires` count (or "uninvestigated" when it has no `requires` key)
and how many claims require it; then every `requires` edge that crosses the area's boundary, out and
in, by § id; then the interface tokens it defines, those in one of its claims' heading or first
sentence, with how many claims elsewhere use each. An H2 given to `map` shows its area, with a note
saying so. A count of agreed but unbuilt claims is printed only when the spec records agreement;
until then the map says "agreed-not-built: not available (no agreed field yet)", and the JSON
leaves the count out, so it never reads as zero.

`map`, `where` and `impact --near` are bounded and stateless like the contents view: compact JSON
with `--json` and readable text without, explicit budgets from 1,024 to 32,768 bytes (`map` defaults
to 32,768 so the whole map usually fits one call, the others to 12,000), lines that do not fit left
for a continuation cursor bound to every computed line, so a spec change makes it stale, exit 0 when
done, 1 when more remains or an unknown is named, and 2 for a refusal (usage, unknown id or
namespace, untrusted graph, a bad or stale cursor, a budget too small for one line) as small JSON.
The command may follow its flags. They store nothing and run no project code.

## §tools.spec/where-lookup — `where` finds the claims for a file or a name

The read-only `where <path|token>` command answers "which promises cover this?". A path is a file a
record's `code` lists or that exists under the project root; anything else is a token, and `--token`
forces that reading. A path-shaped argument that is neither is searched as a token with a line saying
so. For a path it lists every claim whose `code` names the file, ranked by the interface tokens in
the claim's own passage that also occur in the file, each shown with the tokens it shares. An
interface token is a backticked span, outside fenced code and HTML comments, of at least three
characters with a letter, that looks like a name the code uses: it contains `/`, `.`, `_`, `:`, `#`,
`-`, `$`, `=` or a bracket, or has a capital after its first letter, or is upper case; plain words
are not tokens. It occurs in a file when it appears there with no letter, digit, `_` or `$` on
either side. A token counts for more the fewer records use it (its score is the log of the record
count over the records using it), and a claim's score is the sum over the tokens it shares. Claims
sharing no token follow the ranked ones in id order, with their `code` list as the only link. The
first ten are shown with a line naming how many more there are and the `--all` flag that lists every
claim naming the file, none dropped. A file no record lists is reported as listed by no claim, exit
1, with up to ten claims whose interface tokens occur in it under a heading that calls them unmapped
candidates, a name match and not a mapping, and never as an empty success. The file is read only
through the core's own refusal rules (inside the root, no symlink on its path, a regular file), and
only the one file asked about; a file it cannot read is reported as not read, with why, exit 1, and
its claims are still listed, unranked. For a token it lists the claims whose backticked spans equal
it or contain it as a whole name: first those that use it in their heading or first sentence, as
defining it, then the rest, as mentioning it; none found is exit 1.

## §tools.spec/near-impact — `impact --near` lists what a change could reach, one hop at a time

`impact '§id' --near` is a narrowed impact view; `impact` without the flag keeps its output and
contract. It works on the seed's family: an H1 with its H2s, or an H2 alone together with the
claims that require its parent H1, which bring it with them (marked as reached through the parent).
It lists, in this order: the **consumers**, the claims outside the family whose `requires` names a
family member, one hop only, each with title, kind, labels, size, what and the family members it
requires, and the why of the first of those its text explains, as a contents line gives it; the
sections whose `members` name a family member; the **frontier**, the behaviors with no `requires`
key that belong to the family or whose text names a family member; the **next hop**, the claims that
require a consumer, by id only; the claims whose text names a family member, by id only; and the
**code neighbours**, one line per file the family lists that other records list too, fewest other
records first, with up to twelve of their ids and the count of the rest, named with `where` for the
whole list. A claim's text names a § in its prose, masked as in the contents view, or in its heading
after its own id. Behaviors with no `requires` key outside the frontier are counted on one line that
names plain `impact` as the command that lists them, so none reads as checked. Every group's count
is on each page.

## §tools.spec/graph-payload — `graph --json` is the one computed graph every view reads

The read-only `graph --json` command prints the spec graph as one deterministic payload, for
machine consumers such as a static page: a node per declared claim, in id order (id, kind, level,
namespace, area, title, what and its source, declared labels, passage bytes and, for an H1 with
H2s, the whole file's bytes, file and lines, the declared `requires` count or null when the key is
absent, and the number of `code` paths), then the edges, each with its kind: `requires`, `member`,
`contains` (an H1 to each of its H2s), `mentions` (a claim's text naming another §, as
§tools.spec/near-impact reads it) and `code` (a claim to a file it lists); an edge to an id with no
record or span is marked dangling. It is computed on each call from the manifest and the claim files
and never written into the spec. It is paged under a whole-response budget, 32,768 bytes by default
and 1,024 to 32,768 when given, with the nodes, then the edges, cut at item boundaries, the counts
per kind on every page, and a stateless cursor bound to the whole payload; concatenating every page's
`nodes` and `edges` in order rebuilds the same payload whatever the budget. Without `--json` it
prints only the counts.

## §tools.spec/contents-view — `toc` shows one hop of neighbours before anything is read

The read-only `toc '§id' --dir out|in|down|up|mentions` command is a contents view: it lists the
claims one hop from the requested one in a single direction, so the reader picks what to open
instead of receiving a whole dependency chain. `out` lists the claim's declared `requires`, then, in
a group of their own, the claims its prose names without requiring them; `in` lists the claims whose
`requires` name it, and for an H2, in a group of their own headed "required through its H1", the
claims that require its H1, since requiring an H1 brings all of its H2s; `down` lists an H1's H2
children, or a section's members, in declaration order; `up` gives the parent of an H2; `mentions`
lists the claims whose prose names it. Records carrying the optional `embeds` and `about` fields
add groups of their own to `out` and `in` (§tools.spec/record-fields); `in` lists both the claims
that embed it, or for an H2 its H1, and the notes about it or its H1, so a claim drawn inside another
or served by a note never reads as one nothing points at. It never follows a second hop and never
prints a neighbour's passage. On an H1 with H2s, `out` also says how many of its H2s require claims
outside it and how many distinct claims those are, pointing at `toc` on each H2 and at `map` on the
area, so an H1 whose own record requires nothing never reads as an area that needs nothing.

The output starts with the requested claim itself: its id, title, kind, labels, size, the number of
code files its record lists (which `read` names), and its own "what". Then each neighbour gets one line, grouped under a heading per kind of link and ordered by id
(`down` keeps declaration order, and notes about an H2 come before the notes about its H1): the § id and its heading title; **what**; for `out`, `in` and
`mentions`, **why**; and **size** in UTF-8 bytes, which is what reading it alone costs, and for an H1
its lede's bytes and its whole file's bytes. **What** is the passage's first prose sentence after its
heading, verbatim with whitespace collapsed: fenced code, HTML comments, tables, thematic breaks and
headings are skipped, list markers are dropped, a sentence ends at `.`, `?`, `!` or `:` followed by a space (never
inside a code span) and runs on until it has 20 characters, and anything past 200 characters is cut
with `…`. A blockquote is used only when the passage has no other prose; a passage with none says
"no prose sentence", with its code's size when it has code, and never quotes code. **Why** is the
first visible-prose sentence of the linking claim's text that names the other one (the requested
claim's for `out`, the neighbour's for `in` and `mentions`, naming the H1 for a line reached through
it); failing that, an HTML comment naming it, labelled as a comment; failing that, for a note linked
by its `about` field, "about §x (declared on the note)", since the field itself is the written reason;
failing that, exactly "not mentioned in this claim's text". The JSON says which (`whatSource`, and
`whySource` `prose`, `comment`, `declared` or `none`). A line, and the requested claim, whose record
carries `agreed` shows who made the decision and when, never that they read its current words, and
whether it is built (it maps `code` and its
`evidence` is `reviewed` or `verified`), as "agreed <at> by <by>, not built" or ", built", so an
agreed promise not yet built never reads like a built one.

Mentions are found in prose only: text inside fenced code, HTML comments and double-backtick spans
is masked; single backticks are not, and `§a.b` reads as `§a/b`. A claim never counts as mentioning
itself.

A contents line is never the passage, so the footer says what this one response delivered (no
passage), how many lines it listed and how many it left for a continuation, and the count of lines
each other direction would list, so a direction not asked never reads as empty. It names the
unknowns: a behavior with no `requires` key reads "dependencies uninvestigated", never as zero
requirements; for `in`, the count of behaviors with no `requires` key that could also require it; and
a declared edge to an id with no record or span, which is listed as unknown, never dropped. It says
nothing about earlier calls. The response is bounded like a packet: the default whole-response
budget is 12,000 UTF-8 bytes, and explicit budgets are integers from 1,024 to 32,768. Lines that do
not fit are left for a stateless continuation cursor, bound to the request and every computed line so
that a spec change altering them makes it stale, and counted, never silently dropped. `--json` prints compact JSON; without it the same lines print as readable
text under the same budget. Exit 0 means done with no unknowns, 1 that more lines remain or an
unknown is named, and 2 a refusal (usage, unknown id, untrusted graph, a bad or stale cursor, or a
budget too small for one line), always as small JSON within the budget. Nothing is stored, no
project code is run, and the `packet` and `scope` outputs are unchanged.

## §tools.spec/single-read — `read` returns one passage at its own size

The read-only `read '§id'` command returns exactly one declared passage and nothing it requires,
contains or mentions, except the surfaces its record `embeds`: those are drawn inside it, so each
follows as further passages, whole (lede and every H2), in the same stream, and so does each surface
those embed in turn; and its first page
carries the always-on frame outside the budget (§tools.spec/frame). For an H1 that passage
is its lede, the text before its first H2; `--whole`
returns the lede and then every H2 of the file in declaration order, each as its own passage. The
text is byte-for-byte the passage the `scope` API supplies, with its id, kind, title, file, lines,
any declared labels and any `agreed` record, shown as in the contents view, and the code files its
record lists: the first 12 paths, each marked when it is missing or refused, then how many more there
are, so a builder learns which files keep the promise without the whole closure's code list. A passage larger than the budget arrives as exact UTF-8 fragments,
as packet prose does, whose concatenation recovers it.

After the passage, a footer names the § it declares through `requires` and the § its prose names
(masked as in the contents view) that this read does not deliver on any of its pages, so a link
left unopened is still named; for an H1 read as its lede it also gives the number of H2s left out and the whole file's
size, with the flag that reads it. The default budget is 32,768 bytes, so any single passage of
ordinary size arrives in one call; explicit budgets are 1,024 to 32,768. The cursor and
stored-nothing rules are the contents view's, with compact JSON with `--json` and readable text
without; exit 0 when the stream is done, 1 when more remains, 2 on a refusal such as an unknown id
or an untrusted graph.

## §tools.spec/record-fields — Optional `embeds`, `core` and `about` record fields

A manifest record may carry three optional fields, each project flagging its own records; none is a
new kind, label value or top-level key, so a core that predates them reads the same manifest and
ignores them. `embeds: [§id]` names surfaces drawn inside this claim, which a reader of it needs
whole. `core: true` marks a claim, typically an H2, as part of the always-on frame (see
§tools.spec/frame). `about: [§id]` on a note names the surface or behavior the note serves, so the
note is written once and its target's record is never edited to link it.

An `embeds` edge is a dependency like `requires`: `scope` and `packet` follow it with the reason
`embeds`, reverse `impact` walks it back to the embedding claim, and the contents view lists it under
`out` in an "embeds" group of its own and under `in` as "embedded by". `read` of a claim also
delivers each surface it embeds, whole (see §tools.spec/single-read).

An `about` note shows in the contents view under `out` for its target, in an "about" group, and also
for each H2 of a target H1, marked as reached through that H1. `read` names the notes about the
passage it delivers, and `packet` adds to its prose the notes about the requested claim, its H1 and
the surfaces it embeds, each with the reason `about`. On a spec whose records carry none of these
fields, every existing output is unchanged except packet's help text and its new `frame` part.

`check` validates them. A value of the wrong shape is a record error, like a malformed `requires`:
`embeds` or `about` not an array of § ids, or `core` not a boolean. A misuse is a warning naming the
record, so one misplaced field never makes the whole graph untrusted: `about` on a record that is
not a note, a target with no record, an `embeds` target that is not a surface, and an `about` target
that is a note or section.

## §tools.spec/frame — The always-on frame is its own stream, at most 12,000 bytes

The frame is the passages of every record flagged `core: true`, in file and line order, each the
exact text `scope` supplies (an H1 gives its lede only, never its H2s). It is never mixed into what a
reader asked for, and the page budget of the requested claim is spent on that claim alone.
`packet '§id' --part frame` pages it as a stream of its own, and `read --frame`, with no § id, reads
it under read's budget and cursor rules. So that it arrives unasked, the first page of `read '§id'`
also carries the whole frame as items of their own, outside that page's budget, leaving out any
passage this read delivers, which arrives in the read's own stream instead; continuation pages
never carry it, and `--no-frame` drops it for a reader that already has it.

Whenever the spec flags at least one core record, every `packet`, `toc` and `read` page (refusals
aside) names the frame with its passage count, its byte count (the sum of its passages' UTF-8 bytes)
and the cap, packet's counts include the `frame` stream, and the readable text of `toc` and `read`
says how to read it, so the frame is always named even when it is not delivered. A
spec with no core record prints nothing about a frame, and its outputs are unchanged.

The cap is 12,000 decimal bytes. A frame over it is still delivered whole, never cut: the summary
marks it over the cap, and `check` and `packet` report a `frame-over-cap` warning with its size, so
the project moves a record out of the frame or accepts the cost in plain view.
