# §app/requirements — Decisions, reconciliation and a project's spec
> Part of the Sova design spec · [overview](../design/overview.md)

What people decide in baton sessions (§app/baton) becomes their project's documentation, with who
said it, where, when and in which words. A **reconciler** compares the decisions of each area
before any of them is adopted, sends a contradiction to the person who decides that area (or to
the operator), and the operator promotes the reconciled ones into the project's own `.sova/spec`,
a few at a time.

Vocabulary: **decision** (one `record_decision` call), **area** (what a decision is about:
"payroll export"), **conflict** (two live decisions of one area that contradict), **promotion**
(a reconciled decision becoming current documentation of the client project).

It lives on the project, under `/api/orgs/:id/projects/:pid/` (the route list is in
`shared/decisions.ts`): `decisions`, `conflicts`, `reconcile`, `draft`, `promote`,
`conflicts/:cid/route`, `conflicts/:cid/resolve`, `spec`. Main listener only; never on the share
listener. Every write runs in the project's one-job-at-a-time queue.

## §app.requirements/decisions — The decision index

- The source is the transcripts: every `sova-baton-decision` entry of the project's baton
  sessions (`{area, statement, quote, by}`), read with Sova's own line parser. The index adds only
  what the reconciler decided about each one and lives in the org's workspace repo at
  `projects/<projectId>/decisions.json` (conflicts beside it in `conflicts.json`), committed with the
  org's workspace commits. Listing the decisions syncs the index first; syncing never drops a row.
- A decision's id is `<sessionId>:<entry id of the decision>`, so two decisions stated in one
  message stay two. Its provenance is **who** (person id or `operator`, and their name when
  recorded), **session**, **entry** (the user message holding the quote: the nearest one up the
  tree from the decision entry), **time** and **quote**.
- States: `pending` (not compared yet, or the comparison failed), `drafted` (compared with every
  other live decision of its area, no open conflict, written to the project draft: promotable),
  `conflict`, `promoted`, `superseded` (a later decision replaced it; `supersededBy` names it).
  A state is recomputed from those facts on every read, never stored as a separate truth.

## §app.requirements/drafts-with-provenance — Records in the project's own spec

- The writer is deterministic: no model writes documentation. Each drafted decision becomes a
  `note` record `§requirements.<area>/<slug>` (letters and hyphens only, taken from the statement,
  `-b`, `-c`… on a clash) under an area lede `§requirements/<area>`, both `authority: accepted`. The
  record's prose is the statement, the quote as a block quote, and `— <name>, <date>`; its manifest
  record carries `provenance: [{by, name, sessionId, entryId, at, quote}]` and `decision` (the
  index id). The spec core ignores unknown record fields, so neither changes how the tools read it.
- Text from a conversation can never declare: a line that would start a heading or a fence is
  escaped before it is written.
- Everything is written through the spec tools this tree ships
  (`pi-config/extensions/spec/core/sova-spec-draft.mjs`, run as a child process with no shell)
  into the project root's `.sova/spec/drafts/`. The project draft `sova-decisions` holds every
  drafted decision not yet promoted and is rebuilt from current each time. `claims/` and
  `manifest.json` change only by promotion.
- **A client project needs no setup**: a folder with no spec (and no Git) starts from the tools'
  empty baseline, and the first promotion creates `.sova/spec/manifest.json` and
  `claims/requirements/<area>.md`. Sova adds `.sova/spec/.gitignore` (`drafts/`, `reviews/`,
  `pilot/`) when it is missing, so a client repo never commits a draft.

## §app.requirements/reconciler — Comparing, filing and settling

- **Switch.** Settings → Decisions **Reconcile decisions** (`features.reconcile`; on by default:
  `RECONCILE_DEFAULT`). It can be turned off there. While off, Reconcile and a project overseer's reconcile tool are refused
  with "Turn on Reconcile decisions in Settings → Decisions." (409), and the automatic run below is
  skipped with that reason as the run's error. Drafting, promoting, routing and settling by hand
  send nothing and work either way.
- **When.** Only when asked: **Reconcile** on the project page (or `POST …/reconcile`), a project
  overseer's reconcile tool, or on its own right after a decision is recorded in a routed
  conflict's own baton session, open or already settled (a 2-second debounce). Nothing runs on a
  timer.
- **What is sent.** Decision text only: statements, quotes, the authors' names, dates and area
  names, through the same redacting provider as every decision (§app.decisions/privacy); never a
  transcript, a goal, a briefing, ids, paths or any profile field. A project whose root is in the
  excluded folders is never sent.
- **Areas.** A new area (no record yet) whose words all appear in an earlier area's
  ("payroll export" / "payroll export format") files under it. Otherwise the decide seam
  (§app.decisions/interface, purpose `reconcile`) is asked, per new area, whether it is the same
  subject as an existing one; a new area may join only a settled area or one first used before it,
  so two new spellings never swap. A decision is filed once, by the first successful run that sees
  it, and never moves after.
- **Contradictions.** Every live pair of one area not yet compared, with at least one side not yet
  reconciled, is asked as a three-way choice, up to 12 pairs per request: **conflict** (both
  answer the same question, incompatibly), **same** (the same rule said again) or **different**
  (different questions, or one only adds a detail). The question first asks which single
  question each decision answers, so two rules merely filed under one area (a payment weekday
  and an approval threshold) are "different", not a low "yes". P(conflict) ≥ 0.7 is a conflict;
  P(same) ≥ 0.7 is a restatement (below); otherwise the pair is marked compared and never asked
  again. A pair with a side already in an open conflict waits for that conflict's resolution. A
  promoted decision is compared like any other and can be in conflict. Reconciling again asks
  nothing that was already answered, and never opens a second conflict or session for the same
  pair.
- **Restatements.** A restatement or confirmation is **folded** into the earlier decision (its
  quote and provenance join that record; it is superseded by it; no second record). Before
  pairing, each pending decision is compared with its own author's earlier decisions of the area,
  superseded ones included (the same words need no question): a restatement of a superseded rule
  is superseded with it, by what replaced it, so a losing author repeating their rule never
  reopens a settled conflict.
- **Settling.** The first decision recorded in a conflict's baton session is its resolution: the
  decide seam says whether it keeps A, keeps B, replaces both or says both stand, and whether the
  resolution states A's or B's rule again. Keeping a side: the other side is superseded by the
  kept one, and a resolution that restates it is **folded** into the kept decision; one that says
  something else stays a decision of its own (compared like any other), never evidence for the
  kept rule. A later decision in the same session (a second confirmation) runs the reconciler on
  its own too, and is folded like any restatement.
  Replacing both: both are superseded by the resolution. The operator can settle by hand instead:
  keep A, keep B, keep both (not a contradiction), or state the decision (it supersedes both; its
  provenance is the operator on the project page, with an empty session).
- A decide failure, no ready provider or an excluded project folder stops the run: new decisions
  stay `pending` and the reason is the run's `error`; nothing is guessed.

## §app.requirements/routing — Who settles a conflict

- To the active roster person whose `decides` covers the area (same key), preferring one who wrote
  neither side; with no such person, to the operator.
- **Operator-set say.** A `decides` entry counts only when the operator set it: the change that
  introduced it (per `roster-history.jsonl`) is the operator's, or a referral's for a person the
  operator approved afterwards (approval is the review step; a project overseer's approval does
  not count). Any other say is **self-asserted**: the conflict goes to the operator instead and is
  marked so, and a person cannot talk themselves into deciding.
- Routing starts a baton session (§app/baton) to that person, owned by the operator or the project
  overseer, whose goal carries both statements with their authors and quotes and whose first
  question names both, each with its author. Routed to the operator, the baton is held by the
  operator from the start, so it is a Needs-you item; routed to a person, no link is minted at
  start (nobody could be shown it) and Needs-you asks the operator to send one. A fresh baton is
  listed and in Needs-you before anyone has written in it.
- The operator can re-route an open conflict to anyone active (or themselves); the earlier session
  is closed, so two people are never asked the same thing.

## §app.requirements/frozen-spec — Frozen

- A project can be marked **frozen** (`PATCH …/spec {frozen}`, stored on the project in
  `projects.json`): its documentation is written only by the reconciler's promotion.
- Sova cannot stop a coding session's own file tools from editing `claims/`; instead, a frozen
  project records a hash of its current spec after every promotion and reports `editedOutside`
  when the spec no longer matches it.

## §app.requirements/promotion — Piecemeal, explicit promotion

- The operator selects drafted decisions (or a project overseer allowed to promote does);
  anything else is refused with its reason.
- **Out of area.** A decision whose author may not decide its area (`authorOwnsArea` false: not
  the operator, and no operator-set say over the area, as in §app.requirements/routing) is promoted
  only when the operator names it: `promote {ids}` by id. **Select All Ready** (`bulk: true`) and
  a project overseer's promotion refuse it with "outside <name>'s decision area: promote it
  explicitly by id", and promote the rest. A promotion builds a fresh draft holding exactly the
  selection (claim files move whole), plus, for a promoted decision the selection supersedes, its
  record rewritten with `Superseded by <record>.` and `supersededBy`; records `--doc-only`
  evidence per changed record `--by reconciler`, with a verification naming the author, date,
  session, entry, quote and what it was reconciled against; previews the promotion and writes it
  with that preview's plan hash. The batch draft `sova-promote-<time>` is kept: its `draft.json`
  holds the evidence and the promotion record (local only, like every draft); one that promoted
  nothing is removed.
- Sova never commits the client repo: promoted files are left for the project's owner (or a coding
  session) to commit.
- A refusal of the spec tools (a conflicting hand edit, a pending transaction) is reported per
  decision and changes nothing; the index keeps them `drafted`.

## §app.requirements/rejected — Not done, and why

- **A model writing the records**: the statement and the quote already are the prose; a writer
  model would paraphrase what the person said.
- **One draft per session** (`gather-<sid>`): claim files move whole, so two session drafts
  touching one area would conflict at the second promotion; the project draft is rebuilt instead.
- **A `requirement` record kind**: a spec-core change; `note` + `provenance` promotes with
  `--doc-only` today.
- **A Settings switch for the reconciler**: it never runs unasked; the gate is the action itself,
  plus the folder exclusions.
