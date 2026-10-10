# §tools/spec — The spec tooling's notes to the agent
> Part of the Sova design spec · [overview](../design/overview.md)

The spec tools preserve declared requirements, keep proposed changes separate, and report what
was checked against particular inputs. Their checks establish structure and applicability, not
semantic correctness. The minor mode adds task reminders and the census note, names once after a
session's last edit the foreign § its change landed in that it hasn't read, names in a finished
code-writing worker's summary the § its changes landed in, and never holds a turn's end; response wording is not proof that implementation and requirements agree.

Complete graph queries remain available to machine consumers. Bounded packets deliver exact
requirements within an explicit whole-response budget, with continuation and unknowns kept visible.
Beside the full-closure packet, a contents view (`toc`) lists a claim's one-hop neighbours with what
each is and why it is linked, and single-passage reads (`read`) return one claim without its chain,
so the agent chooses what it reads.
A map (`map`) shows every area on one page, and `where` finds the claims for a source file or a name.
Draft commands say what a draft introduced apart from what the spec already had, and a spec conflict
a Git merge leaves has one recovery, given in the same words by the docs and the refusals.
A report names the drafts left behind, and a prune deletes only the drafts on a list the user approved.
Records may also declare `embeds` (surfaces drawn inside a claim), `core` and `about` (the target a
note serves), and an `agreed` decision (who decided and when); the claims flagged `core` form an
always-on frame that arrives with the first page of a `read`.
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
after any tool call, when a turn ends or when a session reopens, with spec on or off. Sessions and
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
observed or unknown, a read budget bounds only the bytes of the page it returns, apart from the
always-on frame the first read carries (§tools.spec/frame), and while token
use is unknown the run asks before any further model run.

A run writes nothing beyond its chat: no files, no assessment receipts, no workers, no cleanup. It
reads with git, with the helpers known to apply turned off (fsmonitor, external diff, textconv;
not a sandbox), with the trusted spec tools at the declared base, and with the agent's own file
reading. Each published command re-establishes the tools' location, root and base itself, never
relying on an earlier call. It reads a claim as spec mode does (§tools.spec/mode-reading): `toc`
for the claim's neighbours, then `read` for one exact passage at a time, the first read bringing the frame and every later one
adding `--no-frame`, keeping whole-chain `packet` and `scope` out of its reading step. A request for a durable assessment receipt is reported as needing a
separate opt-in method, since the companion has no bounded view of its capture. The report has
fixed sections within the report length and keeps observed, inferred and proposed apart; changes to
the playbook's own method appear there only as proposed diffs, never applied by the run.

## §tools.spec/census-note — The `[spec census]` note stays short

After a tool call that brings new changed files, and only then, the `[spec census]` note says what
the census found (the one exception is the unread line, §tools.spec/unread-landed), the same in pi sessions, pi workers and Claude Code workers. Only what changes
while one of the session's own tool calls runs is the session's: a file changed, or a commit made,
between its calls (another process sharing the work tree, a worker, the user's editor) is taken in
silently before the next call and left out of every count and line, so a session that changes
nothing itself never gets a note or `No draft yet`. Such a file the session then changes itself is
its own from that call on. A call that fails (a shell command that exits non-zero; in Claude Code,
a call that ends in `PostToolUseFailure` instead of `PostToolUse`) is closed exactly like one that
succeeds: what changed while it ran is its own and gets the same note, and no later change between
calls counts as the session's because of it. A call that never ran is closed without a census
where the host says so (in pi, a call blocked or aborted before it started; in Claude Code, a
denied call, `PermissionDenied`); any other call left open stops counting as running when the
next prompt starts a run (in Claude Code, also after 15 minutes). A worker's changes reach the worker's own census note, never
its parent's; when the worker settles, its parent gets one line naming where they landed
(§tools.spec/worker-landed).

- a header, "N changed file(s) in the boundary, M unclaimed", followed by "; K mapped outside the
  boundary" when K is above 0; it gives no foreign count;
- `No draft yet`, printed once in a session per work tree, on the first note that has it;
- `New: <file> → §a, §b, §c (+N more)` for the new files: at most 3 § per file and at most 8 files;
  a file no claim maps still reads `unclaimed`;
- one line for the new files outside the boundary that no claim maps: "Outside the boundary, no
  claim maps: a, b (+N more): spec any whose change a user sees";
- the write guard, orphaned-evidence, spec-conflict and promote drift notes, when they apply;
- at the first call after the session's last edit, the one `Unread § your change landed in` line
  (§tools.spec/unread-landed).

The spec-conflict note comes first, once per conflict, when Git holds spec files unmerged. A
conflicted `manifest.json` gets the `merge-manifest --write` command to run first and, if it
refuses, §tools.spec/conflict-recovery's recovery; claim files in conflict with the manifest merged
get that recovery alone (from "take"). Both name the project's default branch where the recovery says
`master`. When a claim file conflicts and the `merge-claims` driver (§tools.spec/git-merge) isn't
set up for it in that clone, the note ends with the one-time setup. During a rebase it says to abort
the rebase instead.

It has no `Foreign §:` line, no `Rule:` line and no `New claims under a foreign §` pairs, and a newly
touched foreign § alone never fires it (the unread line alone lists foreign § to read). Returning to a work tree retains its census state. When the
census can't run, the model gets one line, "[spec census] incomplete: <why>; run census by hand",
once per cause per work tree until a census there succeeds again; there is no toast. When the
census printed nothing, <why> carries the first error line it wrote to stderr (else its first
stderr line), else that it timed out or its exit status. The census runs on the node the hook
itself runs on, by absolute path, so a version manager's `node` shim on PATH that refuses an
untrusted directory never stops it (under bun: the first `node` on PATH outside a shims directory).

The census is skipped after a tool that cannot write the repository, by an explicit list of tool
names: in pi, read, grep, find, ls, align, agent_list, agent_models, agent_transcript, agent_wait,
team_list, team_inbox, team_roster, link_inbox, link_members and link_offers; in Claude Code, its
own read-only tools and the team tools team_inbox, team_msg, team_ask, team_roster, team_report and
wake_nudge. A skipped call neither looks at the tree nor moves the census's baseline; what changed
while it ran is taken in before the next call that can write, like any change between calls. Shell
commands are never skipped.

## §tools.spec/worker-landed — A finished worker names the § its changes landed in

When a code-writing worker that a spec-on session started (pi or Claude Code, plain, sandboxed,
hosted or a team member) settles, its summary carries one line after the worker's answer (after the preview, before the
notice, when the answer is cut), so the answer's first line still opens the report: "Spec: this
worker's changes landed in §a, §b (+N more)", with at most 5 §, followed by "; unclaimed: x, y
(+N more)" (at most 3 files) when some of its changed files in the boundary have no claim (with
none mapped: "Spec: this worker's changes landed in no claim; unclaimed: …"). The summary is the
same text everywhere a settle reaches: the parent's `subagent-complete` message, `agent_wait`'s
result, and a team member's completion routed to its coordinator. Its changes are the files its
own census counted (§tools.spec/census-note) since it started: what another process changed
between its calls is not among them, and a file it changed back drops out at its next census. The § are those its
census mapped them to, with the draft it worked in when it had one. No line when none of its own
changes is in the boundary or mapped by a claim, when its census never ran, and for a worker
without the census (read-only, remote, or started before this change). It is the same line at
every settle of that worker, never a per-call note, and nothing checks or acts on it.

## §tools.spec/unread-landed — Once after the last edit, one line names the unread § the change landed in

At the first tool call after a session's last edit (a call that can write but changed nothing of
the session's own, after one or more that did), the `[spec census]` note carries one line naming the
foreign § the session's own changed files landed in that the session hasn't read: "Unread § your
change landed in: read first §a, §b; +N more: <command>". It is the same in pi sessions, pi workers and
Claude Code workers. The § come from `census --changed --related` (with the task's draft when it
has one), in census-rank order (§tools.spec/census-rank), keeping only those a session's own
changed file lands in: at most 5 are marked read first, the first of that order that score above
zero or have a stale literal. Every other one is counted, never dropped: "+N more:" is followed by
the exact census command the line came from (`node "$core/sova-spec.mjs" census --changed
--related` with the same `--root`, `--base`, `--own-base` and `--spec`), whose output names each
of them, so the line stays short however many § the change touched (under 300 characters for 25
touched § with short ids). With none marked read first, it reads "N unread: <command>".
A § with a stale literal says so beside its id: "(still states 12)". A § the session ran
`sova-spec.mjs read` on, by its literal id in any of its shell commands so far (a read of a shell
variable counts every § that command spells), counts as read; a §
the task created is never listed, nor one only another process's changes landed in. The line is
said once per set of landed §: it stays quiet until a later edit changes that set, and says nothing
when every one of them was read. A call that edits never carries it; a tool the census skips
(§tools.spec/census-note) is not the call after the edit, so the line comes with the next call that
can write. Like every census note it checks nothing and holds nothing: the turn still ends when the
model stops (§tools.spec/no-turn-end-check).

## §tools.spec/write-guard — The direct-write note judges the files, not the command

The census note's write guard says "you wrote the current spec directly (<files>): undo it" for a
current-spec file (`manifest.json` or a file under `claims/`) that a tool call changed by hand, the
same in pi sessions, pi workers and Claude Code workers. An edit or write tool on such a file is
always one. For a shell command, the guard looks at each current-spec file the call changed and
never at the command's text, so a wrapper script, an alias or a shell function is judged like the
tool it runs. A changed file is not a hand write when:

- its bytes are what a promotion wrote: their SHA-256 matches the hash a promotion receipt
  (`promotions[]` in a draft's `draft.json`) records for that file;
- a merge, rebase, cherry-pick or revert is in progress in that work tree;
- its bytes equal the file at HEAD or at the default branch's tip.

Any other change, `sed -i` on a claim file for one, still gets the note. Each promotion receipt
records, beside the files it wrote, each file's SHA-256 after the write (null for a file it removed).

## §tools.spec/census-created — `census --changed` counts § created since its base as the task's own

`census --changed --base <rev>` (the base is `HEAD` without the flag) treats a § the spec lacks at
`<rev>` and has now as one the task created: the same set `foreign --base <rev>` reports as
`created`. "Now" is the `--spec` draft when one is given, otherwise the working tree's
`.sova/spec`, so a § the task promoted and committed after `<rev>` counts as its own just like one
still in its draft. Such a § is never in `census.foreign` or the `foreign-summary` note, gets no
`touched-foreign` note, and its `touched` entry (with `--related`) says `created: true`. A § that
existed at `<rev>` stays foreign however the task changed it. With `--own-base` revisions, a §
absent at every one of them is the task's own as well.

## §tools.spec/census-rank — `census --changed --related` ranks touched § by the changed lines

`census --changed --related` ranks the foreign § the changed files land in by the change's own
lines. From the added and removed lines of each changed file a claim maps (`git diff -U0` against
the base; an untracked file's lines all count as added) it takes code-shaped names (with an inner
capital, `_`, `-`, `.` or `$`, or all capitals), the text of short string literals, and numbers of
two or more digits. A § scores the sum of the weights of the distinct ones its passage (heading,
prose, backticked tokens and fenced examples) contains as whole names, each weighing more the fewer
of the spec's passages contain it, as `where` weighs a file's tokens (§tools.spec/where-lookup). A
string or number the change removed and didn't add back that a § still states is a `stale` literal
of that §; a § with one ranks above every § without. `census.rank` lists each foreign touched §
once, best first (an equal score puts the § mapping fewer code files first, then goes by id), with its `score`, `reason` (the matched names, heaviest first) and
`stale` literals; `census.readFirst` is its first 5 that score above zero or have a stale literal,
and `census.named` every other one, so each is in exactly one of the two. The text output prints a
`read first (ranked by the changed lines):` line, each § with its heaviest names and stale
literals, and a `named:` line. Nothing in the ranking knows a project: the names come from
the diff and the spec. A rank is a literal match, never proof that a § is or isn't affected; without
`--related` the census does not rank.

## §tools.spec/mode-reading — Spec mode teaches contents first, then one passage

The spec minor mode's guide teaches the pull path. The agent finds its roots with `map` and `where`,
looks at a root's neighbours with `toc` (`--dir out`, or `--dir down` for an area) before reading
them, and runs `impact --near` on any claim it will change. It then reads each root, and each passage it
needs, with `read`: every `requires` line whose "what" doesn't rule it out, and any other line
touching the task. The first `read` brings the frame; later reads add `--no-frame`. A link it didn't read is
unread, never absent, and "uninvestigated" is unknown, not none. A foreign § its change touched is
read with `read`. `packet` and `scope` stay listed for whole-chain machine inspection, not as a
reading step. Every command the guide spells is one the shipped tools parse, with the flags the
guide pairs with it.

The guide's promotion lines agree with the draft tool: doc-only evidence covers notes, sections,
agreed records without code (§tools.spec/agreed-promotion) and a change to `embeds`, `about` or
`core` alone (§tools.spec/field-promotion); a test drives the draft tool's doc-only rule, so the
guide fails its test when that rule gains a case the guide doesn't name or drops one it does. For a
`manifest.json` conflict it sends the agent to the census note. For a decision the user agreed to, it points to `agree`
(§tools.spec/agree-command) in one line, and to PROMOTE.md for when that lands. The exemption from drafts is decided from passages read, and the
census note's `No draft yet` line says the same. While coding, the guide relies on the census note
(§tools.spec/census-note), with no rule of one file per edit and no census run by hand. Before
finishing it reads each § the census note's unread line (§tools.spec/unread-landed) marks read
first; the census command that line gives lists the rest. A worker's spec brief lists `toc`, `read` and
`impact --near` among its read-only commands. The guide rides every turn, so a test caps its word
count a few words above its length, and growing it is a deliberate change.

## §tools.spec/no-turn-end-check — A turn ends when the model stops

Replies carry no spec lines but one, "Also updates §X: <what>" (below), which nothing checks;
no `Also changes:`, `Plumbing:`, `Deferred:` or `Spec check override:` line is asked for or checked. A turn with spec on ends when the model stops, as one
with spec off does: nothing re-prompts it, and no warning, toast, hidden note, session record or
card about the turn's spec changes is added, in a pi session, a pi worker or a Claude Code worker.
A worker writes no spec ledger, and its parent reads none; the one line a finished worker's
summary carries naming where its changes landed (§tools.spec/worker-landed) is read from the
worker's census state, checks nothing and asks for nothing. A Claude Code worker started before
this change that still calls the hook's `stop` step or passes `--ledger` gets nothing: the hook
prints nothing and exits 0. A foreign § (one that existed before the task
started) whose text the task's change contradicts, or where it changes what a user sees beyond
that text, is updated in the task's draft without asking, the task's go-ahead covering it, and
listed in the reply or report as "Also updates §X: <what>"; it is never asked about. Spec mode stands alone: its guide, notes and
tools never rely on the merge round or a merge captain, and a session promotes its own drafts.
In the web app, an older reply shows any closing lines it was written with, as written, and an
older session's spec-turn records draw nothing.

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

## §tools.spec/git-merge — A Git merge of spec changes conflicts only on the same promise

Two Git branches that each promoted spec changes merge without a conflict unless they changed the
same promise. `.gitattributes` routes the claim files through the draft tool's `merge-claims`
driver and `manifest.json` through `merge-manifest`; Git needs each defined once per clone, and the
setup names no project path but the tools' own. `merge-claims` merges a claim file per declaration
the same way promotion does (§tools.spec/span-promotion), with the merge base, ours and theirs in
the roles of base, current and draft, so the merged file has the bytes the two promotions give when
landed one after the other in one tree, in either order. The driver finds declarations from the
file's own H1 and H2 headings, without loading the graph. When a declaration or a gap changed
differently on both sides, a declaration was deleted on one side and changed on the other, the file
can't be cut per declaration (no declarations, a carriage return, kept declarations reordered), or
the merged file doesn't read back as the declarations it was merged from, the driver writes Git's
own line merge with its conflict markers, so both sides' prose stays in the file, and Git reports
the file as conflicted; its refusal (`claims-conflict`) then gives §tools.spec/conflict-recovery's
recovery in the same words, with the project's default branch.

A record's place in `manifest.json` doesn't depend on the order changes landed in. Promotion and
`merge-manifest` put a record that is new to the manifest right before the first record of its own
area (its identifier up to the `/`) that sorts after it, or else right after that area's last
record; the first record of an area goes right before the first record whose area sorts after its
own, or last. Records already in the manifest keep their place.

## §tools.spec/conflict-recovery — A spec conflict has one recovery, said the same way everywhere

A promotion conflict within one tree (current changed a declaration the draft changed too) is
refused with what PROMOTE.md says: revert those declarations in the draft's `spec/` to their
`base/` text and promote the rest, or start a new draft from current; it never says to fix the
draft by hand. A Git merge that leaves the spec conflicted (a `claims/*.md` file, or a manifest key
`merge-manifest` refuses), whether or not the manifest merge driver already merged the manifest,
has one recovery, given in the same words by PROMOTE.md and by the draft tool's refusals: take the
default branch's whole spec with `git checkout --no-overlay master -- .sova/spec/manifest.json
.sova/spec/claims` (never `--ours` and never one file at a time: the driver may already have
merged the manifest, and the branch's other claim files would then lack their records), commit the
merge, promote the branch's drafts again with the same `--id`s (re-recording evidence that `status`
calls stale; a draft that is gone is re-applied in a new draft from current), then commit the
claims. Followed literally, it leaves a spec whose graph loads and a re-promotion that lands on the
first try. The refusal names the project's own default branch where PROMOTE.md says `master`.
`merge-manifest`'s `manifest-conflict` refusal carries it, so does `merge-claims`' `claims-conflict`
(§tools.spec/git-merge), and so does a promotion refused because
spec files are still unmerged in Git's index (`spec-merge-conflict`) or because the current spec's
graph does not load (`current-invalid`).

## §tools.spec/agreed-promotion — An agreed promise lands in the main spec before it is built

A behavior or surface record may carry `agreed: {by, at}`: who made the decision it records, and
when (an ISO date, optionally with a time). It names who decided and when, not that they read the
record's current words; no tool checks what the prose means. A later promotion may reword the prose
and keep `agreed`. A change of meaning needs a new agreement: the go-ahead of the task that changes it
is that agreement, with `by` set to whoever gave it, and it replaces `agreed`: a promotion may replace the `agreed` of a record current already has only when
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
When a promotion changes an agreed record's prose but keeps the `agreed` current has, and a number
or a backticked token in that prose was added or removed, the promotion carries a note
(`agreed-kept-on-change`, never a refusal) naming who the kept `agreed` credits, and when, and the
changed tokens: a change of meaning needs a new agreement (§tools.spec/agree-command), while a
rewording that changes no number or token gets no note.

## §tools.spec/agree-command — One command agrees, and lands what isn't built

`agree <draft> --id '<§id>'… --by <who> --verification <text>` writes the decision into the draft:
on each named behavior or surface it sets `agreed: {by, at}`, with `at` the current UTC time to the
minute unless `--at` gives an ISO date or time, and `authority: "accepted"`. A promise with prose in
the draft but no record gets one (an H1 is a surface, an H2 a behavior). An `agreed` this draft
already gave, by the same person, is kept, so a second run changes nothing. It refuses what
promotion would: a note or section, an id with no prose in the draft, a record current already has
agreed whose prose the draft leaves unchanged, and an `at` earlier than current's.

For each record that maps no code and is not labelled built, the same call records doc-only
evidence with `--by` and `--verification` as given, then runs promotion's own plan for those
records and applies it only when that plan is clean: no refusal, no drift warning, no note, and no
foreign § beyond a parent gaining the new claim. Its output then names what it promoted, the plan
hash and the files written. Otherwise it writes nothing to the main spec, exits 1
(`agree-not-promoted`) with the plan's findings, and the agent takes the ordinary path. A record
that maps code is only stamped, never promoted by `agree`: its build records commit or snapshot
evidence and promotes with a preview. Without `--write` it only previews and writes nothing.

## §tools.spec/align-agree — With align on too, the go-ahead is the Agree step

With the align minor mode also on, agreeing in align and changing the spec are one act. When an
`align` call sets an alignment implementing while the spec minor mode is on, its result text (never
its `details`) ends with a paragraph telling the agent that this go-ahead is the Agree step: before
building, it writes each decision that changes behavior as a promise in a spec draft (a new claim,
or the claim the decision changes) and runs `agree` with `--by` the person who gave the go-ahead and
the alignment's id in `--verification`, which lands the records that map no code in the main spec,
so it says who decided before any code exists. If `agree` reports the promotion not clean, the
agent resolves what it lists and promotes. A changed claim that already maps code keeps its new
`agreed` in the draft and lands with the build, and the build updates those same records. With
spec off, or align off, nothing is added, and neither mode's prompt block carries this step: it
rides only that one result. What the align tool records is unchanged.

## §tools.spec/field-promotion — A record-field-only change lands on doc-only evidence

A promotion whose only change to an existing behavior or surface record is adding, changing or
removing its `embeds` or `core` field may use doc-only evidence: such a change rewires what a reader
is handed, not what the code does. `about` belongs on notes (`check` warns when it sits elsewhere),
and a note's `about` change takes doc-only evidence as any note change does; a misplaced `about` on
a behavior or surface counts like the other two fields. Only means the record's prose (its span, and any bytes
outside spans attributed to it), its `code` list, its labels (`authority`, `evidence`) and every
other field read the same in the draft as in its base. The `--verification` text must say what was
read to decide the field: for an embed, both passages and the code that renders the embedded surface
inside the embedding one; for `about`, the note and its target; for `core`, the passage and why
every task needs it. The tool enforces only that the text is not empty, never what it says. A field
change bundled with any other change to the same record is refused for doc-only evidence
(`doc-only-bundled`, naming what else changed) and needs commit or snapshot evidence, as any other
behavior or surface change does. A record that carries `agreed` follows §tools.spec/agreed-promotion
alone: a field-only change to an agreed record that maps code is refused for doc-only evidence
(`doc-only-refused`) and needs commit or snapshot evidence. Notes and sections take doc-only
evidence as before. Doc-only eligibility is judged by
the record's kind both in current (the draft's base) and in the draft: a record whose kind changes
qualifies only if both kinds allow it, so turning a behavior or surface into a note or section while
rewriting its prose still needs commit or snapshot evidence, as deleting it would.

## §tools.spec/draft-output — Draft commands say what the draft introduced, apart from what was there

`draft check` splits the core's findings on the draft graph in two: those the draft introduced
(absent from the core's findings on the draft's own base) are listed one by one (`introduced`, and
`coreFindings` and `frontier` hold only those), and those the base already had are counted by code
(`preexisting`); `--all` lists them too. A draft with no base, or whose base graph does not load,
counts every finding as introduced. So a draft that introduces nothing prints under 2 KB however
many findings the current spec already carries; the exit status is the same as before the split.
`new` reports the number of files it copied, their bytes and one hash over the copied tree; the
per-file list appears only with `--all`. A promotion preview or write gives, beside the merged
graph's warning count, how many of those warnings current does not already have
(`warningsIntroduced`), and names at most five claims whose mapped code changed under unchanged
prose, with their total count and the core `foreign --landing` command that lists every one.

## §tools.spec/draft-hygiene — Drafts left behind are reported, and only an approved list is pruned

`draft drafts` reads every draft of the project (`--worktrees`: of every Git work tree of its
repository too) and writes nothing. Each draft gets its age (days since its last activity: made,
evidence recorded or promoted), one state with the reasons for it, and a suggested action:
`landed` (an id is still pending while its implementation is on the default branch: a commit its
evidence names is in that branch, or the work tree's own branch was merged into it after the draft
was made) suggests promote; `promoted` (every id is already current, was promoted by this draft
before current moved on, or is on the default branch exactly as the draft says it), `superseded` (nothing pending, and an id current changed differently) and
`empty` (it changes nothing and is older than the age limit) suggest delete; `old` (pending, older
than the limit, 7 days unless `--days N`), `active` and `unreadable` suggest keep, `landed` with
the ids whose evidence must be re-recorded first. The default branch is the one
`promote` names (origin's HEAD, else `master`, else `main`); a project without Git gets no `landed`.
It exits 1 when any draft is other than `active`.

`draft prune --approved FILE` deletes only drafts the file names, one per line, each optionally
followed by the `draftSha256` the report printed (one hash over its `draft.json` and `spec/`); without `--write` it only lists them. A name with
no draft, a hash that no longer matches (the draft changed after it was approved), or an
interrupted promotion refuses the whole prune, and nothing is deleted. No other command deletes a
draft, and none suggests deleting one that still has a pending id.

A promotion preview or write names, once, how many other drafts in its project are older than the
age limit, with the `drafts` command that says which are left behind.

## §tools.spec/inspection-safety — Refused inputs are not inspected

The core, draft, and review commands validate path configuration before traversing it. Invalid
boundaries are rejected consistently by full and changed census. Review refusal policy applies
before incumbent contents are read. Log paths receive the same ancestor-symlink checks as other
evidence. Git-backed inspection must not execute configured clean/process filters; unsupported
configurations are explicitly refused rather than weakening the read-only contract. Partial or
unreadable draft inventories remain explicitly incomplete, not an exact empty result.

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

The minor-mode guide lists packets beside `scope` for whole-chain machine inspection; its reading
path is contents first, then one passage (§tools.spec/mode-reading). Full graph tools remain available for deliberate
machine inspection and review. No new mandatory assessment or release gate is introduced here.

### Reading a packet

`packet '§ns/name'` starts the prose stream. `--part inventory|frontier|code|findings` starts a
detailed inventory independently, and `--part frame` the always-on frame (§tools.spec/frame); `--cursor` continues the chosen stream, and the budget may be
changed between pages. Counts name the whole streams; `remaining` and `next` describe only the
selected stream. An empty stream terminates without a cursor. `packet --help` also returns small
bounded JSON. The global help (`sova-spec --help`) is one usage line naming every command the core
runs, the reading commands (`map`, `where`, `toc`, `read`, `impact --near`, `graph`) included, and
every `--part` of `packet`. The usage errors of `check`, `census`, `scope`, `impact` without
`--near` and `foreign`, and of an unknown or missing command, end with that same line; `packet`,
`toc`, `read`, `map`, `where`, `graph` and `impact --near` keep their own small bounded refusals,
which don't carry it (`packet`'s carries no message). The existing graph commands keep their
existing formats.

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
declared `authority` and `evidence` label, and how many `requires` and `embeds` edges leave it for
other areas and arrive from them. After the areas come the hubs, the ten code files the most records list, each
with that count, and the gap counts: behaviors with no `requires` key, records with no `code`,
passages with no prose sentence, and records with no interface token (as §tools.spec/where-lookup
defines one). `map <namespace>` limits all of it to one namespace; a namespace with no area is
refused. `map '§ns/name'` shows one area: its H1, then its H2s in declaration order, each with kind,
labels, code count, its declared `requires` count (or "uninvestigated" when it has no `requires` key)
and how many claims require or embed it, with its agreement when it has one, as "agreed (decision) <at>
by <by>", and whether it is built; then every `requires` or `embeds` edge that crosses the area's
boundary, out and in, by § id with its kind; then the interface tokens it defines, those in one of its claims' heading or first
sentence, with how many claims elsewhere use each. An H2 given to `map` shows its area, with a note
saying so. Every view counts its claims whose record carries `agreed` and that are not built, built
meaning a `code` list plus the `evidence` label `reviewed` or `verified` (the draft tool's rule), with
the earliest and latest `agreed.at` among them as dates, never as ages, and how many claims carry
`agreed` in all. `agreed` records who made the decision and when, never that anyone read the
current words. When no record in view carries `agreed`, the map says so and the JSON has no count, so
an absent count never reads as zero.

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
forces that reading. A path-shaped argument that is neither is searched as a token, and both the
text and the JSON form say that no such file exists under the root and no record lists it (JSON:
`file.state` `absent` and a `note`), exit 1. For a path it lists every claim whose `code` names the file, ranked by the interface tokens in
the claim's own passage that also occur in the file, each shown with the tokens it shares. An
interface token is a backticked span, outside fenced code and HTML comments, of at least three
characters with a letter, that looks like a name the code uses: it contains `/`, `.`, `_`, `:`, `#`,
`-`, `$`, `=` or a bracket, or has a capital after its first letter, or is upper case; plain words
are not tokens. It occurs in a file when it appears there with no letter, digit, `_` or `$` on
either side. A token counts for more the fewer records use it (its score is the log of the record
count over the records using it), and a claim's score is the sum over the tokens it shares. Claims
sharing no token follow the ranked ones in id order, with their `code` list as the only link. The
first ten are shown; how many more there are and the `--all` flag that lists every one, none
dropped, are named in the text and in the JSON form alike (`notShown`, `hint`), and a cut list exits
1, never a complete answer. A file no record lists is reported as listed by no claim, exit
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
claims that require or embed its parent H1, which bring it with them (marked as reached through the
parent).
It lists, in this order: the **consumers**, the claims outside the family whose `requires` or
`embeds` names a family member, one hop only, each with title, kind, labels, size, what, the family
members it requires or embeds with the edge's kind, and the why of the first of those its text
explains, as a contents line gives it; the sections whose `members` name a family member; the notes
whose `about` names a family member (or, for an H2 seed, its parent H1, marked as reached through
it), by id with the claim each serves; the **frontier**, the behaviors with no `requires` key that
belong to the family or whose text names a family member; the **next hop**, the claims that require
or embed a consumer, by id only; the claims whose text names a family member and that are not on
the frontier, by id only, so no claim is listed twice; and the
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
absent, the number of `code` paths, `core: true` when the record sets it, and the record's
`agreed` (who made the decision and when) when it has one), then the edges, each with its kind:
`requires`, `embeds` (a claim to a surface drawn inside it), `member`, `contains` (an H1 to each of
its H2s), `about` (a note to the claim it serves), `mentions` (a claim's text naming another §, as
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
children, or a section's members, in declaration order, and for an H1, in a group of their own
headed "notes about its H2s", the notes whose `about` names one of those H2s, one hop only (never
what a note names in turn, and on no other direction), each note once, ordered by the first, in declaration
order, of the H2s it serves and then by id, a note that is itself one of the H2s left out, its why
found as for any note linked by `about`, the H2 it serves standing for the requested claim and,
failing that, the H1; `up` gives the parent of an H2; `mentions`
lists the claims whose prose names it. Records carrying the optional `embeds` and `about` fields
add groups of their own to `out` and `in` (§tools.spec/record-fields); `in` lists both the claims
that embed it, or for an H2 its H1, and the notes about it or its H1, so a claim drawn inside another
or served by a note never reads as one nothing points at. It never follows a second hop and never
prints a neighbour's passage. On an H1 with H2s, `out` also says how many of its H2s require or embed
claims outside it and how many distinct claims those are, pointing at `toc` on each H2 and at `map` on
the area, so an H1 whose own record requires nothing never reads as an area that needs nothing. When
none does, it says "none of its N H2s requires or embeds a claim outside it"; either way it counts the
H2s that are behaviors with no `requires` key, whose dependencies are unknown, not none, and counts
them among the unknowns, so an area whose H2s were never investigated never reads as needing nothing.

The output starts with the requested claim itself: its id, title, kind, labels, size, the number of
code files its record lists (which `read` names), and its own "what". Then each neighbour gets one line, grouped under a heading per kind of link and ordered by id
(`down` keeps declaration order, and notes about an H2 come before the notes about its H1): the § id and its heading title; **what**; for `out`, `in` and
`mentions`, **why**; and **size** in UTF-8 bytes, which is what reading it alone costs, and for an H1
its lede's bytes and its whole file's bytes. **What** is the passage's first prose sentence after its
heading, verbatim with whitespace collapsed: fenced code, HTML comments, tables, thematic breaks and
headings are skipped, list markers are dropped, a sentence ends at `.`, `?`, `!` or `:` followed by a space (never
inside a code span or an open quote, nor at a closing quote the sentence runs on past in lowercase,
and a `:` never inside open parentheses or brackets) and runs on until it
has 20 characters, not counting the list marker, and anything past 200 characters is cut
with `…`. A blockquote is used only when the passage has no other prose; a passage with none says
"no prose sentence", with its code's size when it has code, and never quotes code. **Why** is the
first visible-prose sentence of the linking claim's text that names the other one (the requested
claim's for `out`, the neighbour's for `in` and `mentions`, naming the H1 for a line reached through
it; for a note linked by its `about` field, the note's text naming the claim it serves, and failing
that the requested claim's text naming the note), led by the short run-in label that directly
precedes it in the same paragraph or list item when there is one (at most three plain words, no code
or brackets, ending in a colon, such as "Not here:"), its emphasis kept as written. The label is
always shown whole; the sentence is cut to fit what is left of 240 characters, around its own
mention of the link, at word boundaries, with `…` where it is cut; failing that, an HTML comment naming it, labelled as a comment;
failing that, for a note linked by its `about` field, "about §x (declared on the note)", since the
field itself is the written reason;
failing that, exactly "not mentioned in this claim's text". The JSON says which (`whatSource`, and
`whySource` `prose`, `comment`, `declared` or `none`). A line, and the requested claim, whose record
carries `agreed` shows who made the decision and when, never that they read its current words, and
whether it is built (it maps `code` and its
`evidence` is `reviewed` or `verified`), as "agreed (decision) <at> by <by>, not built" or ", built", the wording `map` uses, so an
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
for each H2 of a target H1, marked as reached through that H1; it shows the same way under `in`, as a
note about the claim or about its H1; and under `down` for the H1 of an H2 it serves
(§tools.spec/contents-view). Its why is found as §tools.spec/contents-view says; when neither prose
nor a comment names the link, it is the declared field itself ("about §x (declared on the note)"),
never "not mentioned". `read` names the notes about the
passage it delivers, and `packet` adds to its prose, after the closure, the notes about any claim
the packet delivers (the requested claim, its H1, the surfaces it embeds and every other claim its
closure reaches), each once, in note id order, with the reason `about` naming each delivered claim
it serves. On a spec whose records carry none of these
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
spec with no core record prints nothing about a frame, and its outputs are unchanged, except that
`read --frame`, which asks for the frame itself, says it is empty ("frame: no core records in this
spec (empty)", and `frame: {passages: 0, empty: true}` in its JSON) with exit 0, so an empty frame
never reads as one that went unread.

The cap is 12,000 decimal bytes. A frame over it is still delivered whole, never cut: the summary
marks it over the cap, and `check` and `packet` report a `frame-over-cap` warning with its size, so
the project moves a record out of the frame or accepts the cost in plain view.
