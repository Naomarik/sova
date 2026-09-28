# §app/requirements — Decisions, reconciliation and a project's spec
> Part of the Sova design spec · [overview](../design/overview.md)

What people decide in baton sessions (§app/baton) becomes their project's documentation, with who
said it, where, when and in which words. A **reconciler** compares the decisions of each area
before any of them is adopted, sends a contradiction to the person who decides that area (or to
the operator), and the operator promotes the reconciled ones into the project's own `.sova/spec`,
a few at a time.

Vocabulary: **decision** (one `record_decision` call), **area** (what a decision is about:
"payroll export"), **owner area** (which of the roster's decision areas decides it, or `none`:
§app.requirements/owner-area), **conflict** (two live decisions of one area that contradict), **promotion**
(a reconciled decision becoming current documentation of the client project).

It lives on the project, under `/api/orgs/:id/projects/:pid/` (the route list is in
`shared/decisions.ts`): `decisions`, `conflicts`, `reconcile`, `draft`, `promote`,
`conflicts/:cid/route`, `conflicts/:cid/resolve`, `spec`. Main listener only; never on the share
listener. Every write runs in the project's one-job-at-a-time queue.

## §app.requirements/decisions — The decision index

- The source is the transcripts: every `sova-baton-decision` entry of the project's baton
  sessions (`{area, ownerArea, statement, quote, by}`; `ownerArea` is absent from entries recorded
  before owner areas), read with Sova's own line parser. The index adds only
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
- **Who owns which field.** Of a record in the project's spec, the decisions layer owns its prose
  (the statement, each quote with who said it and when, the supersede line) and the manifest
  fields `decision`, `provenance` and `supersededBy`. It writes `kind: note` and `authority:
  accepted` only when it creates the record. Every other field (`evidence`, `code`, `requires`, a
  relabelled `authority` or `kind`, any other key) is the spec layer's, set by a builder or a
  reviewer: the reconciler never compares, drops or rewrites it.
- **Still promoted.** A promoted decision is `drafted` again (promotable) only when its record is
  missing from the current spec, or its decisions-owned fields differ from what the reconciler
  would write now (a restatement was folded in; a promoted decision it replaced doesn't say so
  yet). A builder adding `evidence` or `code`, or relabelling the record, leaves it `promoted`. A
  decision already `drafted` again for that reason reads `promoted` again with nothing migrated,
  and the stale project draft goes at the next Reconcile, promotion or Rewrite Draft.
- **Edited in the spec.** A promotion keeps, on each promoted decision's row, a hash of its
  record's prose as written (`promotedText`) and the promotion's commit (`promotedCommit`, when it
  made one). When the current prose differs from it (for a decision promoted before that was kept:
  from what the reconciler would write), the decision stays `promoted` and is marked `editedInSpec`;
  its row in the Decisions list says "Edited in the spec since it was promoted." with **Keep Spec's
  Words** (the row takes the current prose's hash, and records `{at, by, name}` as `textKept`) and
  **Restore Their Words** (the person's words are promoted again, prose only: the record's other
  fields stay, and it is committed like any promotion). Both are `POST …/decisions/:did/text
  {action: "keep" | "restore"}`, for a promoted decision marked edited only, else 409. The project
  overseer reports it and never keeps or restores.
- **Built or not built yet.** A promoted decision is **built** when its record in the current spec
  has `code` and `evidence` `reviewed` or `verified`, else **not built yet** (`build` on the row,
  derived on each read like its state). It repeats what the builder recorded, not proof: a branch
  not yet merged reads "not built yet". Each promoted decision's row shows a **Built** or **Not
  built yet** chip; the Requirements card's spec line adds "· {n} built, {m} not built yet" when any
  decision is promoted (`SpecStatus.built`, `notBuilt`). Only the operator and the project overseer
  see it; a share page never shows it.

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
  quote and provenance join that record, and so do those of anything already folded into it; it
  is superseded by it; no second record). Before
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

- **Who owns an area.** The active roster people whose `decides` has the area's key own it. When
  no active person has it, the project's main stakeholder (§app.organizations/stakeholder) owns
  it; with no stakeholder either, nobody does. The area is the decision's owner area
  (§app.requirements/owner-area); `none` is owned by the main stakeholder, else nobody. A decision
  recorded before owner areas has none, and its topic area's key is matched instead, exactly as
  before.
- A conflict goes to the area's owner, preferring one who wrote neither side; to the main
  stakeholder when they own it, even when they wrote one side or both (a person who contradicts
  their own earlier decision settles it); with no owner, to the operator. Any two live decisions of
  one area are compared, whoever wrote them, one author's included. A conflict is routed by the
  owner area its sides name; when they name two different ones, it goes to the operator. The
  conflict's reason says which: "{name} decides {area}.", "{name} is this project's main
  stakeholder.", "Nobody on the roster decides {area}.", "The two decisions name different owner
  areas: {area} and {area}."
- **Operator-set say.** A `decides` entry counts only when the operator set it: the change that
  introduced it (per `roster-history.jsonl`) is the operator's, or a referral's for a person the
  operator approved afterwards (approval is the review step; a project overseer's approval does
  not count). Any other say is **self-asserted**: the conflict goes to the operator instead and is
  marked so, and a person cannot talk themselves into deciding. It never falls to the main
  stakeholder instead: an area someone claims to own is not an area no one owns.
- Routing starts a **settle session**, a baton session (§app/baton) marked with its conflict (its id and area,
  kept on the registry row even after a re-route closes it), to that person, owned by the operator or the project
  overseer (the run the server starts by itself takes the owner of the settle session whose decision
  started it, so in a project the overseer runs it stays the overseer's), on the project's gathering model and thinking (`gatheringModel`/`gatheringThinking`,
  else the overseer's own setting, else the new-session default; the overseer's own reconcile
  also falls back to what its runtime runs, as in §app.project-overseer/tools "Models"), whoever
  routed it: the overseer's
  reconcile, the operator's Reconcile or re-route, or the run the server starts by itself when a decision
  is recorded in a conflict's settle session (§app.requirements/reconciler "When"). Its goal carries both statements with their authors and quotes, and the
  area and owner area to record the answer under (the owner area the sides name, else the model picks one), and its
  first question names both, each with its author. Routed to the operator, the baton is held by the
  operator from the start, so it is a Needs-you item; routed to a person, no link is minted at
  start (nobody could be shown it) and Needs-you asks the operator to send one. A fresh baton is
  listed and in Needs-you before anyone has written in it.
- The operator can re-route an open conflict to anyone active (or themselves); the earlier session
  is closed, so two people are never asked the same thing.

## §app.requirements/owner-area — Who decides a decision: its owner area

- **Two fields.** A decision's `area` is its topic, in the words it was recorded with ("site
  structure / pages"): it files the decision in the spec (`§requirements/<areaKey>`), and
  contradictions are looked for within it, as before. Its **owner area** (`ownerArea`) says who
  decides it: one of the roster's decision areas, as the roster spells it ("website"), or `none`.
  Authority reads only the owner area: `authorOwnsArea`, promotion's out-of-area rule and conflict
  routing (§app.requirements/routing, /promotion).
- **Picked when it is recorded.** `record_decision` requires it (§app.baton/hand-off). The choices
  are the decision areas of the roster's active people, plus `none`; the tool's schema lists them,
  refreshed at the start of a run whenever the roster changed them. The call is checked against
  the roster as it is then: another value is refused, and the refusal names every choice
  (`"site" is not an owner area. Use one of: "website", "branding" or "none".`). A choice with the
  same area key as a roster area (it differs only in case, spacing or punctuation) is that area, and is stored as the roster
  spells it. The model sees the choices, with every active person's name and job title
  (§app.baton/goal-and-loadout). Its prompt makes `none` the default: it gives an area only when
  the decision itself is about that area's subject, never because of who said it or whose area the
  conversation was started for (a page's layout, design or wording is not finance because a
  finance person asked for it). The project overseer questions an implausible owner area before
  promoting a decision as its author's own (§app.project-overseer/tools).
- **`none`**: no decision area on the roster covers it. The project's main stakeholder decides it
  (§app.organizations/stakeholder), else nobody: the operator.
- **Older decisions.** A decision recorded before owner areas has no `ownerArea` and keeps today's
  rule: its topic area's key is matched against the roster's `decides`. Nothing is backfilled.
- **A conflict's owner area** is the one its sides name (one side's, when only the other was
  recorded before owner areas), kept on the conflict as `ownerArea`. Two different owner areas
  route it to the operator; no owner area at all routes it by its topic area, as before. A
  settle session's goal names the owner area to record the answer under, and a decision the
  operator states to settle a conflict takes it.
- **The operator changes it.** In the project page's Decisions list, each live decision has an
  **Owner area** select: the roster's decision areas and **None**, and **Not set** for a decision
  recorded before owner areas, until someone picks one. A change sends `PATCH
  …/decisions/:did {ownerArea}` (a roster decision area or `none`, else 400 naming the choices; a
  superseded decision is refused, 409). The index row keeps the new `ownerArea` and appends
  `{at, by, name, from, to}` to `ownerAreaHistory` (`by` is `operator`; `from` is null for a
  decision that had none), and under the select the page says "Changed by {name} {time}.". The
  decision's `authorOwnsArea` and state are recomputed at once. When it is a side of an open
  conflict, that conflict is routed again by its new owner area; when that sends it to someone
  else, the settle session already asking is closed and a new one starts, as a re-route does, and
  the reason is the new route's.
- **Never shown to people.** The owner area is the operator's: the share page never shows it
  (§app.baton/outsider-view shows a decision's topic area and statement), and the model is told
  never to show the list or tell anyone which areas or job title a person has.
- `DecisionsInfo.ownerAreas` carries the choices for the page; each `DecisionRow` carries its
  `ownerArea` (absent: recorded before owner areas).

## §app.requirements/frozen-spec — Frozen

- A project can be marked **frozen** (`PATCH …/spec {frozen}`, stored on the project in
  `projects.json`): its documentation is written only by the reconciler's promotion.
- Sova cannot stop a coding session's own file tools from editing `claims/`; instead, a frozen
  project records a hash of its current spec after every promotion and reports `editedOutside`
  when the spec no longer matches it. The hash covers the whole spec, so a builder recording
  `evidence` or `code` reports it too: in a frozen project only promotion writes the spec.

## §app.requirements/promotion — Piecemeal, explicit promotion

- The operator selects drafted decisions (or a project overseer allowed to promote does);
  anything else is refused with its reason.
- **Out of area.** A decision whose author may not decide it (`authorOwnsArea` false: not
  the operator, not an owner of its owner area, or of its topic area for a decision recorded before
  owner areas, as §app.requirements/routing defines one, with an operator-set say, and not the
  main stakeholder of an area no one owns or of a decision whose owner area is `none`) is promoted
  only when the operator names it: `promote {ids}` by id. **Select All Ready** (`bulk: true`) and
  a project overseer's promotion refuse it with "outside <name>'s decision area: promote it
  explicitly by id", and promote the rest. A promotion builds a fresh draft holding exactly the
  selection (claim files move whole), plus, for a promoted decision the selection supersedes, its
  record rewritten with `Superseded by <record>.` and `supersededBy`. It writes only what it
  changes: a record already in the spec keeps every field the decisions layer doesn't own
  (§app.requirements/decisions), only a changed record's block of its claim file is rewritten,
  every other byte of the file (other records, the lede, blank lines) stays as it was, and a file
  with nothing to change isn't written, so records of other owners in the same file are never
  pulled into the selection (the project draft is written the same way). It records `--doc-only`
  evidence per changed record `--by reconciler`, with a verification naming the author, date,
  session, entry, quote and what it was reconciled against; previews the promotion and writes it
  with that preview's plan hash. The batch draft `sova-promote-<time>` is kept: its `draft.json`
  holds the evidence and the promotion record (local only, like every draft); one that promoted
  nothing is removed.
- Sova commits a promotion, and nothing else, in the client repo (§app.requirements/promotion-commit).
- A refusal of the spec tools (a conflicting hand edit, a pending transaction) is reported per
  decision and changes nothing; the index keeps them `drafted`.

## §app.requirements/promotion-commit — A promotion is committed

- **Why.** A coding session works in a worktree cut from the project root's `HEAD`
  (§app.project-overseer/coding-worktrees), so a decision reaches it only once it is committed.
- **What.** After a promotion that changed files, in a project root inside a Git work tree, Sova
  commits the files under `.sova/spec/` that the promotion changed (`manifest.json`, the
  `claims/` files, a `.gitignore` it added), by explicit path and nothing else, on the branch the
  root's checkout has checked out. Other staged or unstaged changes in the repo stay as they were.
  The message names the promoted decisions: "Promote 2 decisions: payroll export — Exports run on
  Fridays; approvals — Over $5,000 needs a second approver." (each area and statement, cut to 72
  characters, at most 10 then "and 3 more"). It is authored and committed as `Sova
  <sova@localhost>`, whatever git identity the host or the repo has, as the workspace repo's
  commits are.
- **Skipped, with the reason**, and the promotion itself still stands (its files stay written,
  uncommitted):
  - a file the promotion changed already differed from `HEAD` before it (a change Sova didn't make):
    "Not committed: .sova/spec/manifest.json had changes Sova didn't make. Commit or discard them,
    and later promotions are committed again.";
  - a merge, rebase, cherry-pick or revert in progress: "Not committed: the project root is in the
    middle of a merge.";
  - a detached `HEAD`: "Not committed: the project root's checkout is on a detached HEAD.";
  - git fails (a hook refuses): "Not committed: " and git's own first line.
- **Shown.** The promote answer carries `commit` (`{sha, branch, files, message}` or `{skipped}`), and the
  Decisions tab says it after a promotion: "Promoted 2. Committed a1b2c3d on main." or the skip
  reason. A project root that isn't inside a Git work tree gets no commit and no line, as before.
- Only a promotion commits. Drafting, reconciling, a frozen hash and the workspace repo's own
  commits (§app.organizations/workspace-repo) are unchanged; Sova never pushes the client repo.

## §app.requirements/rejected — Not done, and why

- **A model writing the records**: the statement and the quote already are the prose; a writer
  model would paraphrase what the person said.
- **One draft per session** (`gather-<sid>`): claim files move whole, so two session drafts
  touching one area would conflict at the second promotion; the project draft is rebuilt instead.
- **A `requirement` record kind**: a spec-core change; `note` + `provenance` promotes with
  `--doc-only` today.
- **A Settings switch for the reconciler**: it never runs unasked; the gate is the action itself,
  plus the folder exclusions.
