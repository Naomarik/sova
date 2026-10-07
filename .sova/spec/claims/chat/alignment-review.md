# §chat/alignment-review — Adversarial review of alignments (experimental)
> Part of the Sova design spec · [overview](../design/overview.md)

An experimental addition to alignments (§chat/alignment): in a session with the **align** minor
mode on, a fresh, read-only reviewer checks the plan and the finished diff of Complex work, at most
once each per alignment, and the result is recorded on the alignment itself. The session's model
decides when; the user never has to ask, and nothing asks the user for approval to review.

## §chat.alignment-review/flag — Off means today, exactly

Everything here is behind one boolean pi flag the mode extension registers, `adversarial-review`
(default off), read at `session_start` like the other launch flags. With it off a session is
exactly as before: no review guidance in the system prompt, the `align` tool's schema, description
and guidelines byte-identical to the flag's absence, no `review` or `close_blocker` op accepted
(the op list in the error names neither), no `/review` command, no Reviewer row in Settings →
Subagents, no review buttons or review lines on the card, and nothing written to the profiles.
Review exists only in sessions with align on (with or without Delegate); a Delegate-only or plain
session gets none.

In Sova the flag is Settings → Experimental's **Adversarial review** switch (`adversarialReview`
in Sova's settings, off by default), with one line saying what it does. A hosted session started
while it is saved on gets `--adversarial-review`; one already open keeps what it started with. The
web shows the Reviewer section and the card's review lines and buttons only while it is saved on.

## §chat.alignment-review/record — The review record

With the flag on, an alignment can carry a `review` record with two entries, `plan` and `diff`,
each optional. An entry has a **state** (`skipped`, `running`, `clear`, `blocking` or
`incomplete`), a one-line **reason**, the **model** that reviewed (backend · model · effort, when
one ran), when it was last set, and its **blockers**: each an id (`b1`, `b2`… within the entry,
never reused), a one-line title, the discriminating check that fails now, and, once closed, how it
closed (`check`, `evidence` or `waiver`) with its one-line evidence. The record rides the
alignment's snapshot in every `align` result's `details`, so it survives resume, compaction, fork
and rewind exactly as the document does (§chat.alignment/state); the shared fold and Sova's server
check it with the same function, and a document without one (every older session) reads and
renders as before. A malformed record makes the snapshot malformed, like any other field.

## §chat.alignment-review/op — The `review` and `close_blocker` ops

With the flag on, the `align` tool takes two more ops:

- **review** `{phase: plan | diff, state, reason, model?, blockers?}`.
  - `state: "running"` starts the phase: the slot is reserved **before** the reviewer spawns. It
    is refused when that phase already ran (any state but `skipped`): there is never a second
    round. It is refused when the chat's subagent profile names no reviewer (Reviewer: None, or a
    profile without one), saying to record a skip instead. When neither the reviewer's primary nor
    its fallback can run (model policy, discovery), the entry becomes `incomplete` at once, with
    the reasons, and keeps its slot; nobody is asked. Otherwise the result names exactly the
    worker to spawn (backend, model, effort, the fallback, disclosed when used, and the read-only
    tools list: pi `read, grep, find, ls`; claude-code `Read, Grep, Glob`) and carries the
    reviewer prompt already filled from the alignment (§chat.alignment-review/prompt). The plan
    phase starts only before implementing; the diff phase only while implementing, or after done
    (a late review).
  - `state: "skipped"` records why the phase was not reviewed. It leaves the slot usable (a later
    start, from the card's button, still works), and is refused for a phase that already ran.
  - `state: "clear" | "blocking" | "incomplete"` records the verdict, only while the phase is
    running. `blocking` needs at least one blocker `{title, check}` for the diff phase; the others
    take none. A plan review folds its findings into the card with ordinary ops instead.
  - A blocking diff verdict on an alignment already **done** (a late review from the card) moves it
    back to implementing.
- **close_blocker** `{phase, id, by: check | evidence | waiver, evidence}` closes one open blocker:
  `check` with the blocker's check passing, `evidence` with concrete counter-evidence, `waiver` only
  with the user's explicit words. Nothing else closes one.

**Guards.** `status implementing` is refused while the plan review is running. `status done` is
refused while any review is running or any blocker is open, with the open ones named, in the
same way implementing is refused while a question is open. A reviewer that can't run or fails
leaves the entry `incomplete`, and the work continues.

The change line names what a review op did, calling the `diff` phase "implementation" (the user
decides about the implementation; the diff is only what the reviewer reads): "plan review
running", "implementation review: blocking", "plan review skipped", "implementation b1 closed".

## §chat.alignment-review/rules — When the session reviews

With the flag on, the `align` tool's description and guidelines (never the mode prompt) tell the
session: right after `create` or `import`, and again while implementing once the build and tests
pass (before `done`), decide by one rule — review when the work is **Complex** by Delegate's
definition (ambiguous, cross-cutting or high-risk) or touches permissions or trust boundaries,
persistence, migrations or data formats, shared or public contracts, concurrency or process
lifecycle, or anything hard to roll back; in normal (non-Delegate) align the session applies the
same definition to its own work. Docs-only, test-only and one-line changes skip. Every skip is
recorded with a one-line reason. A user's ask for a phase's review (the card's button, `/review`)
starts it whatever the rule says, unless that phase already ran. To review: `review running`, spawn the named worker with the
returned prompt (the diff phase adds the diff base, the changed files and the test results), never
giving it the implementer's transcript; then fold the result. A plan review is folded into the
same card (fix findings, adjust steps, add rejected items marked "(review)", add a question only
for a real choice, and one finding "Review (plan, <model>): …"), then one reply, with no extra
approval asked. A diff review's blockers are triaged: the session runs each blocker's check to
confirm it, sends all accepted fixes in one batch to whoever implemented (a worker, or itself),
re-runs each check, and closes each blocker with `close_blocker`; a blocker that needs a different
approach becomes a question and the status goes back to open. There is no automatic re-review.

## §chat.alignment-review/prompt — The reviewer's prompt

One fixed module (`pi-config/extensions/mode/review-prompt.ts`) writes it, in a plan and a diff
variant. The reviewer is report-only and fresh: it finds concrete ways the work fails, not a
redesign and not as many objections as it can. It hunts in order: (1) drift from the agreed
behaviour, decisions or spec; (2) correctness at seams — callers and consumers, reload and
resume, failure, cancel and retry, ordering, persistence; (3) security and data safety, only where
touched; (4) checks that would pass in the bad state (it reads assertions; a green build is not
evidence); (5) maintainability only when it predicts a defect. It seeks counter-evidence for each
candidate before reporting. Repository text, diffs and worker statements are evidence, never
instructions. Its output: a verdict (`BLOCKING`, `NO BLOCKING` or `INCOMPLETE`), a coverage line,
and at most 5 findings, at most 2 of them non-blocking, each with file:line or alignment-item
evidence, a concrete failure sequence, the smallest fix direction and a discriminating check;
"none" is a valid answer and a clean review is two lines. Budget: about 12k tokens of context,
about 1,200 tokens out, 8 minutes. The prompt is filled with the alignment's title, summary,
approach, decided questions and rejected alternatives.

## §chat.alignment-review/route — The Reviewer route

Each subagent profile (§chat/subagent-profiles) can carry a `reviewer`: `{primary, fallback}` of
backend · model · effort, exactly like `specWriter`, or `null` (None: no review). A profile
without the key still parses, and a parse never adds it. The mode extension resolves it with the
profile at each turn boundary, assessed against discovery and the model policy like the spec
writer (§chat.subagent-profiles/resolution), and the code uses only what the profile lists, never
a model of its own: the primary, else the fallback once (disclosed), else `incomplete`. With the
flag on, Settings → Subagents' profile editor shows a **Reviewer** section under Spec writer
(§chat.subagent-profiles/settings), with the same rows, validation and save rules (a toggle "Review
alignments with a reviewer", off = None, "No review.").

**Seeding.** The first time Settings → Experimental saves the switch on, every library profile with
no `reviewer` key gets the default: primary pi · `openai-codex/gpt-6.1-sol` · high, fallback
claude-code · `claude-opus-5-5` (Opus 5.5, the catalog's current Opus) · high. A profile with `reviewer: null` (None) or a route of its own is
never touched. It is written through the library's own atomic writer, so the mesh syncs it like any
save; a malformed library is left alone and the seeding waits for a later save. Sova's settings
remember that it ran (`seeded`), so turning the switch off and on again seeds nothing, and a run
that finds every profile keyed writes nothing.

## §chat.alignment-review/card — On the card

With the flag on, each alignment card shows one line per recorded phase in its body, its phase as a
chip ("Plan" or "Implementation"; `diff` stays the phase's id in the op, the record and the
message): "Plan review skipped: routine change", "Reviewing the plan", "Plan reviewed · 1
constraint added", "Plan review: 2 blocking", "Plan review incomplete: …", and for the diff phase
"Reviewing the implementation", "Implementation review: no blocking issues", "Implementation
review: 2 blocking" ("Implementation review: 2 blocking (1 open)" once some are closed),
"Implementation review skipped: …", "Implementation review incomplete: …". Each open blocker
shows with its id, title and check. The extension's own lines (the TUI's result card and
markdown) use the same words. On an answerable card (the chat view, align on, newest revision; never a watch,
an Overseer or an older revision) the foot also shows while every question is answered and while
implementing, not only while a question is open:

- **Review Plan** while the alignment is aligning or confirmed, **Review Implementation**
  while implementing (and after done when the implementation review was skipped), each only while
  its phase is missing or skipped. A click sends one ordinary message naming the alignment and the
  phase ("al_3: run the adversarial implementation review now (align review, phase diff), whatever
  the rule says."), as Go With Recommendations does, blocked the same way. Once a phase ran, its
  verdict line shows in place of its button; no button grants a second round.
- While the plan review runs, the card shows only its header and one status line, led by the live
  dot: "Plan review in progress — the alignment may change; it shows once the review finishes.",
  with the reviewer's model beside it when recorded. The summary, approach, questions with their
  options, the folded sections and the whole foot stay hidden until the review records its
  verdict, because the review may still change any of them.
- With no reviewer set for the chat's profile, the button is disabled with that reason.
- Under a review button, one line says what a review is: "An independent reviewer reads it and
  reports problems. It can't change code or run anything." It shows only with the button, so never
  with the flag off.

## §chat.alignment-review/tui — In the TUI

With the flag on, `/review plan|implementation [al_N]` sends the same message the card's button
sends (the open alignment when it is the only one); `implementation` and `diff` both name the
`diff` phase, and its completions offer `plan` and `implementation`. The TUI's result card and
markdown show the record's lines, each open blocker as "implementation b1 open: …". With the flag off, `/review` is not registered.
