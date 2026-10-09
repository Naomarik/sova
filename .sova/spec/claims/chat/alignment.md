# §chat/alignment — Alignments
> Part of the Sova design spec · [overview](../design/overview.md)

While the **align** minor mode is on (§chat/mode-menu), the agent agrees with the user on what to
build before building it, and records each agreement as an **alignment**: a structured document it
keeps with one tool, `align`, from pi's `mode` extension (`pi-config/extensions/mode`). A session
can hold several alignments at once, one per concern. The user never edits one: they answer in
chat, and the agent records the answer. Sova shows each alignment as a card in the transcript, a
chip in the composer, and a count on the session's row. It works the same in the TUI and in Sova,
for sessions Sova holds and sessions it only watches, with one web-only shortcut: in a chat Sova
holds, the card can tick recommendations to take, pick an option as a question's answer, and go
with all of the recommendations (§chat.alignment/card).
Those only compose an ordinary message for the agent to record, exactly as if it were typed; the
TUI user types the same words. How the agent writes alignments — its writing style — and whether it
draws on the card (Visuals) are set in Settings → Alignment (§chat.alignment/settings-file,
§chat.alignment/style, §chat.alignment/visuals).

## §chat.alignment/document — What an alignment holds

An alignment has an id `al_N` (the next number on the branch), a title, a one-line **summary** of
the concern, findings, approach steps, rejected alternatives (each with why), and questions. Items
have ids that are never reused within the document: findings `fN`, approach steps `aN`, rejected
alternatives `xN`, questions `qN`. A question has a topic, the ask, optional context, optional
options (each a label and its trade-off), a **recommendation** (the choice and why), and, once
answered, a **decision**: its text, who made it (`user`, or `accepted-recommendation` when the user
took the recommendation), and when. A question can also be dropped, with why, and reopened.

An alignment can also hold **technical notes** (`tN`, never reused like the other ids): the files,
code and technical detail a plan written for a reader who doesn't read code leaves out of its other
fields (§chat.alignment/style). A document records the **writing style** in effect at its latest
change (`style`: `simplified` or `pm`; absent for Default). In a session started with Visuals on
(§chat.alignment/visuals), a question can carry a **visual** `{kind, source}` — a `vis` drawing's
kind and its source, the same text a `vis` fence would hold — and the document one of its own; at
most 3 per alignment. A document without technical notes, a style or visuals reads exactly as before:
each field is absent until something sets it.

**Options are lettered** a, b, c… in their order, wherever they are listed, so the user can answer
a question by its number and an option's letter ("3a": q3's option a). A recommendation **names an
option** when its choice equals the option's label (trimmed, case-insensitive, bold markers
ignored), or starts with it followed by a non-word character, the longest such label winning; it
then reads by that letter and label ("b — Parquet"), otherwise by its choice as written. The
extension and Sova's card apply the same rule.

**Status is derived from the data**, never typed: `dropped` or `done` when the document was dropped
or marked done; `implementing` when it was marked so; otherwise `aligning` while any question is
open or it has no questions yet, and `confirmed` once every question is decided or dropped. Only
the transitions no data can show are explicit: implementing, done, dropped, and back to open.
Done and dropped are terminal; everything else is **open** for the chip and the session's count.

## §chat.alignment/tool — The `align` tool

The tool is in the agent's loadout only while the align minor mode is on; turning align off removes
it. One call applies a batch of operations to one document, **atomically**: every op is checked
first, and one bad op (an unknown id, a missing field, a field the op doesn't take) fails the whole
call with a reason and changes nothing. With more than one open alignment, a call must name its
document.

The tool's schema has **one branch per op**, each listing exactly the fields that op takes, with the
ones it needs marked required and nothing else allowed; the checks the tool runs itself use the same
table, so a call that fails the schema would fail the tool too, and pi's own argument check refuses
a missing or unknown field before the tool runs. The ops (with the `adversarial-review` flag on,
also `review` and `close_blocker`, and their refusals of implementing and done,
§chat.alignment-review/op):

- **create** `{title, summary, findings?, approach?, rejected?, technical?, questions?}` — a new
  document, `al_N`. Every question needs a topic, an ask and a recommendation. In a session started
  with Visuals on, create also takes the document's `visual?` and each question a `visual?`
  (`{kind, source}`, §chat.alignment/visuals); without it neither field is in the schema or
  accepted.
- **import** `{path}` — a new document read from a JSON file (the create fields, `technical`
  included and `visual` never: the agent adds visuals after the import with edit_question or
  edit_doc; nothing else), at
  an **absolute** path (`~/` counts; a relative path is refused), so a planning worker can write the
  alignment and the agent imports it without retyping. The file's shape is described on the `path`
  field. Only a regular file up to 256 KB is read (a pipe, a device or a directory is refused before
  any read, so the server never blocks on one). The file is validated strictly: malformed JSON
  (named by position only, never quoting the file), an unknown key or a wrong type is refused with
  the path of the bad field. In a **remote session** (tools on a target) the file would be on the
  target, so `import` is refused with a reason, and the agent uses `create` with the file's fields.
  create or import comes first in its call, once.
- **add** `{findings?, approach?, rejected?, technical?, questions?}` (at least one); **edit**
  `{id, text}` replaces a finding's, step's or technical note's whole text; **edit_question** `{q,
  topic?, ask?, context?, options?, recommendation?}` (at least one; `context: ""` and `options: []`
  remove them; with Visuals on also `visual`, `null` removing it); **edit_rejected** `{id, option?,
  why?}`; **edit_doc** `{title?, summary?}` (with Visuals on also `visual`, `null` removing it);
  **remove** `{ids}` (findings, steps, rejected alternatives and technical notes; a question is
  dropped instead, so its id keeps its meaning). A fourth visual, counting the questions' and the
  document's, is refused.
- **decide** `{q, decision}` records the user's own answer; **accept** `{qs: [ids]}` takes the
  recommendation as the decision for exactly those questions, recorded as accepted, and
  **accept_all** `{}` for every open one — never over a decided question (the user's answer is not
  replaced; reopen it first) and never one id named twice; **reopen** `{q}` clears a decision or a
  drop; **drop_question** `{q, reason}` drops a question; **drop_alignment** `{reason}` drops the
  document.
- **status** `{to: implementing | done | open}` — the lifecycle moves the data can't show.
  Implementing and done need every question decided or dropped first (an `accept` earlier in the
  same call does it). A document that is done or dropped takes nothing but `status open`.
- **exempt** `{reason}` — alone in its call, touching no document: the agent records why a work
  request needs no alignment.
- **get** — the document (or, with none named, every open one) as markdown, read-only: each
  option a paragraph of its own, `a. **{label}** — {trade-off}`, and the recommendation
  `Recommended: b — **{label}** — {why}` when it names an option, else
  `Recommended: **{choice}** — {why}`. Technical notes follow the approach under
  "Technical notes", and a visual is its source in a `vis {kind}` code block, under its question
  or after the summary.

The tool's description and the ops' own descriptions tell the model how a reply maps onto ops:
decide what the user answered, accept only what they told it to take the recommendation on, leave
every other question open, and never set implementing while a question is open ("1 yes, 2 your
rec" is `decide q1` and `accept [q2]`, with q3 still open).

A name borrowed from elsewhere gets a hint at the one meant: a field (`newText` or `replacement`
for `text`, `file` or `fromFile` for `path`, `why` for `reason` and back, `id` for `q`, `q` for
`qs`, `status` for `to`), an op (`delete` → `remove`, `add_question` → `add {questions}`, `drop` →
`drop_question` or `drop_alignment`), an older shape of an op that kept its name (`create` with
`fromFile` → `import`, `accept` with `"open"` → `accept_all`, `edit` of a question, a rejected
alternative or the title → `edit_question`, `edit_rejected`, `edit_doc`), and a bare op without the
wrapper ("wrap ops in {ops: [...]}").

A session written with the older op names (before this schema) still reads the same: the state is
the results' snapshots (§chat.alignment/state), never the calls' arguments.

The tool's answer is a compact echo of what is still open: the touched document's id, title,
status and "k of n open", one line per open question with its recommendation (by letter and label
when it names an option), and one line naming the other open alignments. A call that sets a document implementing
while the spec minor mode is on also ends with the spec's Agree step (§tools.spec/align-agree).

## §chat.alignment/state — The state lives in the tool results

Every call that changes a document returns a **full snapshot** of that document in the tool
result's `details`, with the changes the call made (`created`, items added, edited or removed,
questions decided, accepted, reopened or dropped, a status move) and a one-line summary of them
("q3 decided · +q11"). The state is folded along the active branch: for each id, the newest
snapshot wins, in the order documents were last touched. So a rewind, `/tree`, a fork and a
compaction all land on the right state with nothing extra written, and a failed call (an error
result) is never state. Opening a session writes nothing. One fold function
(`pi-config/extensions/mode/align.ts`, node builtins only) is shared by the extension and Sova's
server.

**Older sessions** keep their `align-doc` entries from before the tool (a markdown document the
extension parsed from the agent's reply). They are read-only history: their card renders as it did
(the newest one on the branch, as one line that opens a read-only viewer), nothing parses markdown
any more, and they count toward no chip, row or digest.

## §chat.alignment/model — What keeps the agent on it

- **Instructions.** The align prompt block tells the agent to record every alignment with the tool
  and never as reply text (no freeform plan, no numbered list of decisions in prose), to have a
  planning worker write the alignment JSON for `import` at an absolute path outside
  the repository that the agent names (with Delegate on, the delegate block's no-edit rule for
  planning workers names this one file as its exception; in a remote session the worker reports the
  JSON and the agent creates inline), to change a document only
  through ops and never by re-creating it, to read "3a" as q3's option a and decide it with that
  option's label, to record answers with `decide` (what the user answered) and
  `accept` (only what they told it to take the recommendation on, leaving the rest open), to use
  `exempt` for a work request that needs no alignment, and to mark `implementing` before building —
  never while a question is open; a go-ahead with questions still open takes the recommendations for
  them first, an answer to only some is not a go-ahead — and `done` when finished. With Delegate on, the bridge paragraph says the same for the planning
  worker hand-off. The tool's own description and guidelines carry the core of it too, since they
  sit in pi's tools section.
- **Writing style and Visuals.** A non-Default writing style adds its paragraph to the align block
  (§chat.alignment/style), and Visuals on adds the visuals paragraph after it
  (§chat.alignment/visuals); with Default and Visuals off the block is exactly as before. With
  Delegate on, the bridge paragraph also tells the agent to copy the writing style paragraph, when the
  align block or a later note carries one, word for word into the planning worker's brief; the bridge's
  own words never depend on the style. The planning worker gets no `vis_guide` and writes no visuals.
- **A hidden note on each user prompt.** While align is on and an alignment is open, each prompt the
  user sends carries a hidden message (`align-state`, never shown in the transcript) listing the
  open alignments, their status and their open questions with ids, lettered option labels
  ("a. CSV · b. Parquet") and recommendations, so an answer like "q2 yes, your recs for the rest"
  or "3a" maps onto the right ids and options. Nothing about alignments goes into
  the system prompt: a prompt change restarts a Claude Code session's CLI.
- **A hidden note after a compaction.** A compaction summarizes the tool results away, and a run no
  user prompt starts (a worker's report, a team message) carries no note. So while align is on and an
  alignment is open, a compaction writes one more hidden `align-state` message right after its
  summary: the open alignments with their open questions, and also their decided and dropped ones,
  and a line saying the summary may describe them loosely and a recommendation is not a decision.
  Every later request reads it.
- **No gate.** Nothing blocks the agent from editing, spawning or creating worktrees while a
  question is open: a dead worker or a parallel concern must never leave the session stuck.
- **One nudge per run.** When a run is about to settle, align is on, the run made no `align` call,
  and its final reply reads like a plan that asks the user to decide, the extension adds one hidden
  message (`align-nudge`) telling the agent to record it with `align` (or `exempt` if it isn't a
  design decision) and continues the run once. It never nudges twice in one run (until the run
  settles). Only a successful call that changed a document or recorded an exemption counts as an
  align call here: a refused call or a bare `get` does not. The reply judged is the run's last
  assistant message, even one with no text. "Reads like a plan": an old markdown alignment block
  (its `## Alignment: <title>` heading; a heading or bold line that merely mentions alignment is
  not one); a last paragraph with a question that puts a decision to the user — labelled ("open
  questions"), a go-ahead ("should I go ahead", "take my recommendations") or a choice ("which do
  you prefer", except when the run's user prompt was itself a question the options answer), never a
  merge, push, restart or similar confirmation; a list of two or more items with such words, closed
  by a bare go-ahead ("Go?"); or, anywhere in the reply, a short line with such words ("Questions for
  you:") followed by a list with two or more questions that aren't such confirmations, since a reply
  can close on a statement after asking. Code blocks and the spec mode's closing "Also changes" line don't count.
  Calibrated on two real sessions: it caught every alignment block and freeform plan there, and one
  of about 80 other replies (none after the tightening); across 230 other sessions about 2 in 100
  final replies fire, nearly all prose plans asking for decisions.

## §chat.alignment/card — The card in the transcript

An `align` call that changed a document renders **where the call is**, as a card, instead of the
generic tool card; its tool-call row has no row of its own once the result is there. The **newest
revision of each document on the branch** is the full card; every earlier revision of the same
document collapses to one line built from its changes, which opens to show that revision in place.
A failed call keeps the generic tool card with its error, and a `get` its tool card with the
markdown; an `exempt` is one info row, "No alignment needed: {why}". "Hide tool calls" never folds
an `align` call: it is the message, not its working.

```html
<article class="card align-doc" aria-labelledby="align-doc-{n}">
  <header class="align-doc-head">
    <p class="align-doc-eyebrow"><span class="text-mono">al_3</span> · Alignment · v5</p>
    <div class="align-doc-titlerow">
      <h3 class="align-doc-title" id="align-doc-{n}">Autonomy settings</h3>
      <span class="chip chip-accent"><i class="chip-dot"></i>Implementing</span>
    </div>
    <p class="align-doc-meta">2 of 7 open · q3 decided · +q11</p>
  </header>
  <p class="align-doc-summary">How far the Overseer may act without asking.</p>
  <details class="disclosure align-section align-approach" open>
    <summary class="disclosure-summary align-approach-summary">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      <span class="align-approach-label">Approach</span> · <span class="text-num">2</span>
    </summary>
    <div class="disclosure-body">
      <ul class="align-list align-approach-list">
        <li><span class="text-mono align-item-id">a1</span><span class="align-approach-text">Measure a week of <strong>runs</strong> first.</span></li>
        <li><span class="text-mono align-item-id">a7</span><span class="align-approach-text">Then cap the rate per <code>project</code>, not per session.</span></li>
      </ul>
    </div>
  </details>
  <ol class="align-questions">
    <li class="align-q" data-state="open">
      <p class="align-q-head"><span class="text-mono">q3</span> <strong>Pace limit</strong>
        <span class="chip"><i class="chip-dot"></i>Open</span></p>
      <p class="align-q-ask">How often may it start a run on its own?</p>
      <p class="align-q-context">…context…</p>
      <ol class="align-q-options">
        <li><span class="text-mono align-q-letter">a</span> <span><strong class="align-q-line">1 per 10 min</strong>
          <span class="align-q-desc">trade-off</span></span></li>
        <li><span class="text-mono align-q-letter">b</span> <span><strong class="align-q-line">1 per hour</strong>
          <span class="align-q-desc">trade-off</span></span></li>
      </ol>
      <!-- or, answerable (below): each option's <li> holds a radio's label, the whole row the target:
      <li><label class="align-q-pick"><input type="radio" class="visually-hidden" name="align-q-{n}"
          aria-label="Answer q3 with b: 1 per hour"><span class="text-mono align-q-letter" aria-hidden="true">b</span>
        <span>…the same two lines…</span></label></li> -->
      <p class="align-q-rec"><span class="align-q-line"><span class="align-q-kicker">Recommended</span>
        <span class="align-q-letter">a</span> — <strong>1 per 10 min</strong></span>
        <span class="align-q-desc">why</span></p>
      <!-- or, answerable (below): the same line as a checkbox's label -->
      <label class="toggle align-q-rec align-q-take"><input type="checkbox"><span class="toggle-box"></span>
        <span><span class="visually-hidden">Take the recommendation for q3. </span>…the same two lines…</span></label>
    </li>
    <li class="align-q" data-state="decided|dropped">
      <details class="align-q-fold">
        <summary class="align-q-head align-q-summary">› <span class="text-mono">q2</span>
          <strong class="align-q-topic" title="{topic}">Budget</strong> <span class="chip">Decided</span>
          <span class="align-q-outcome" title="Decided: {text} · you">Decided: … · you</span></summary>
        <div class="align-q-body">…ask, context, options, recommendation…
          <p class="align-q-decision">Decided: … · you | accepted recommendation</p></div>
      </details>
    </li>
  </ol>
  <details class="align-section"><summary>Findings · 3</summary>…</details>
  <details class="align-section"><summary>Rejected · 2</summary>…</details>
  <!-- answerable only (below) -->
  <div class="card-foot align-doc-foot">
    <button type="button" class="button button-sm" aria-disabled="true|absent" aria-describedby="align-doc-{n}-hint"
            title="{reason}">Go With Recommendations</button>
    <span class="align-doc-foot-hint" id="align-doc-{n}-hint">Or pick some answers and type the rest below. | {reason}</span>
  </div>
</article>
<!-- an earlier revision -->
<details class="disclosure align-rev">
  <summary class="disclosure-summary"><span class="text-mono">al_3</span> v4 Autonomy settings · q3 decided · +q11</summary>
  <div class="disclosure-body">…that revision's card body…</div>
</details>
```

- **Card** is capped at `--measure`, `--space-3`/`--space-4` padding; the eyebrow is `micro`
  uppercase muted, the title `heading-s` semibold, the meta a muted caption. Questions are separated
  by a `--color-border` rule. The summary, ask, context, options, recommendation, decision and the
  sections are body text in full ink, for legibility, except a question's context, one
  level down (ink-2) so it sits below the options' trade-offs; a decided question's ask and
  recommendation, and a dropped question's ask, step down one level too. Inline code spans and bold runs in these fields
  render; no other markdown.

- **The approach reads first.** The approach sits between the summary and the questions, open when
  the card renders and still a disclosure (it folds, per card render, never remembered, like a
  question's fold). Its heading is stronger than the other section labels — heading-s, full ink,
  semibold — without accent colour, a panel or fill behind it. Its steps carry only their stable
  ids (a1, a2…: the document's own numbering, which edits and removals keep stable), each id in a
  narrow column of its own with no list marker or additional positional numbering. The entire
  step body, including inline code and bold runs, occupies one text column, so wrapped lines
  align under the step's text, never under its id. Findings and Rejected stay closed by default
  below the questions and can still be opened. The bodies of alignment sections and expanded
  earlier revisions draw no left guide rule, while keeping their indentation, like every disclosure
  (§chat.transcript/tokens). Earlier revisions
  still collapse to their one-line change summary and open to show that revision in place.
- **Technical notes.** A document with technical notes shows them right under the approach, as a
  closed disclosure "Technical notes · {n}", its notes listed by id like the approach steps (same
  id column, same text column, the same inline code and bold). Review lines and blockers are never
  folded into it, whatever the style.
- **Writing style.** A document written in a non-Default style says so at the end of its meta line:
  "· Simplified style" or "· Project manager style". Default adds nothing.
- **Visuals.** A question's visual is drawn under its context, before its options, and the
  document's under the summary, each with the chat's own `vis` drawing (the same figure, Source
  toggle and Copy a `vis` fence in a reply gets). A visual whose source doesn't parse shows its
  source as a code block with the chat's own one line saying it couldn't be drawn, as a reply's fence
  does. A folded question draws its visual only once opened.
- **Status chip**, dot and word, only once the document is past aligning: Confirmed (success),
  Implementing (accent), Done (success), Dropped (neutral). An aligning document shows none.
- **Questions** show their parts distinctly: the ask, the context, the options as a list lettered
  a, b, c… (the letter in the bullet's place, in its own column so a wrapped line aligns under the
  text), each its label in bold on one line and its trade-off on the next, set in slightly (no
  separator), then the recommendation after the options (no fill, no rule) in the same two lines:
  first, bold, a small-caps accent "Recommended" then "b — {label}" when it names an option
  (§chat.alignment/document), else "{choice}"; below it, set in the same, its why — and the decision (with "you"
  or "accepted recommendation") once there is one. Each
  question's head carries its state as a chip: Open, Decided, or Dropped with its why.
- **Only open questions are expanded.** A decided or dropped question is folded by default to
  **one line** that never wraps: a twist, the id, the topic, then its outcome
  ("Decided: … · you" / "· accepted recommendation", or "Dropped: …"), with the chip at the
  line's right end. The topic and the outcome
  truncate with an ellipsis (the outcome gives up more of the line) and carry their full text as a
  hover title. Folded rows take less vertical padding than open questions. The twist opens the
  question: the head wraps whole and drops its inline outcome, and below it come the ask,
  context, options and recommendation it was settled from, then the outcome line in full. The
  fold is per card render and is not remembered.
- **Nothing on the card writes alignment state.** Only the agent's `align` calls do
  (§chat.alignment/state). The card's controls below only compose an ordinary user message,
  which the agent records like any typed answer (§chat.alignment/model).
- **Answerable card.** Only in a chat Sova holds (the chat view, never a live watch, the Overseer's
  watch or a worker transcript), with the **align** minor mode on in that chat, and not in the
  Overseer, a project overseer or a baton session. Even there, only the **newest revision** of an
  **open** alignment (not done or dropped) with **at least one open question** answers; every
  earlier revision, an older session's `align-doc` card and a settled document stay read-only.
  With adversarial review switched on, the same newest card's foot also shows for its review
  button or verdict, with or without an open question (§chat.alignment-review/card).
- **Take a recommendation (tick).** Each open question's recommendation becomes the label
  of a checkbox (`label.toggle`, both lines the target; the box sits in the options' letter
  column), named "Take the recommendation for {qN}." for assistive tech.
- **Answer with an option (pick).** Each open question's options become rows to pick: the whole
  row is the target (at least `--tap-min` tall), a visually hidden radio named "Answer {qN} with
  {letter}: {label}". An unpicked row looks like a read-only option, the same plain letter in the
  same column and the same spacing; the picked row takes a faint selection tint, a thin accent edge
  at its left and its letter and label in accent, with nothing moving; a row shows a sunken fill on
  hover and the focus ring on the whole row. Picking an option answers the question with it; it does not change
  the recommendation. Clicking the picked row clears it. A question holds **one pick**: ticking
  its recommendation replaces an option picked for it, and picking an option replaces the tick.
  The option the recommendation names (§chat.alignment/document) **is** the recommendation: picking
  it ticks the recommendation, and ticking the recommendation shows that option picked, both ways.
- **Picks are staged, not sent.** A tick or a pick stages nothing on the server: picks live in
  memory per session, like the draft, until the next send. They show above the composer as one
  removable row (§chat.composer/anatomy) and go out with the next message. A pick whose question
  stops being open in a newer revision, or whose alignment ends, drops; so does an option pick
  whose option is gone or relabelled, and one the recommendation comes to name reads as the
  recommendation. Ticking and picking are disabled only where the composer is blocked because the
  chat is archived, with that reason as the hover title; a passing block (reconnecting, saving a
  turn) leaves them on, and during a turn they go with the next send like any draft.
- **The message the picks send**, one line per alignment, in the order the alignments were last
  touched and each's questions in card order: the ticked ones as `{al_N}: take your recommendation
  on {q1}, {q2} and {q3}.`, then the picked options as the user would type them, each with its
  label: `My answers: 2b — Parquet; 4a — 1 per 10 min.` (`{al_N}: my answers: …` when nothing is
  ticked). At Send, that line (or lines), a blank line, then the typed text make **one** message;
  Send works with picks and no text. A refused send keeps both. The agent reads the first part as
  `accept` of exactly those questions, and each option ("2b": q2's option b) and typed answer as a
  `decide`.
- **Go With Recommendations.** The card's foot has one button (secondary, `button-sm`; with
  adversarial review switched on, also Review Plan or Review Implementation, §chat.alignment-review/card), with the
  hint "Or pick some answers and type the rest below." beside it. It sends only its own message:
  `{al_N}: go with your recommendations for every open question, and go ahead.` — which the agent
  reads as `accept_all` then status `implementing`. It is `aria-disabled`, with the reason as its
  title and in place of the hint, while the composer's send is blocked (that reason,
  §chat.composer/disabled-states), while a turn runs ("Wait for the turn to end."), and while the
  composer holds a draft — typed text, an attachment or picks ("Send or clear your draft first.").
  After it sends, that alignment's picks clear and focus moves to the composer.
- While a run streams, the call's card appears as soon as its result arrives, from the result's
  own snapshot; the settled transcript renders the same card.

## §chat.alignment/chip — The chip in the composer

In a chat's composer, the run-status row carries an alignment chip **immediately left of the
Inputs trigger** (§chat/composer): "{n} aligns · {decided}/{total} decided" ("1 align · 5/7 decided"), where
`n` is the open alignments on the branch and `decided`/`total` count their decided and all their
live (not dropped) questions, the same counts the rows show. They count the whole branch, even
rows the thread hasn't fetched (§chat.transcript/rendering). It is omitted when no alignment is open, and the row shows for it alone. The
chip and the Inputs trigger sit together at the row's right end. In a narrow composer's run-status
row (§chat.transcript/streaming) it is the one control that may give way: when nothing else can,
its count ends in an ellipsis ("1 align · 0/8…"), and its accessible name keeps the whole count.

```html
<button type="button" class="run-status-link run-status-align" aria-haspopup="menu" aria-expanded="false"
        aria-label="2 open alignments, 10 of 15 questions decided — show alignments">
  <span class="icon icon-sm" style="--icon:url(/icons/chat.svg)" aria-hidden="true"></span>
  <span class="text-num">2 aligns · 10/15 decided</span>
  <span class="icon icon-sm" style="--icon:url(/icons/chevron-down.svg)" aria-hidden="true"></span>
</button>
<div class="model-menu action-menu align-menu" popover="auto" role="menu" aria-label="Open alignments">
  <div class="align-menu-item" role="menuitem" tabindex="0"
       aria-label="al_3 Autonomy settings: 5 of 7 questions decided — jump to its card">
    <span class="text-mono align-menu-id">al_3</span>
    <span class="align-menu-title" title="Autonomy settings">Autonomy settings</span>
    <span class="align-menu-bar" aria-hidden="true"><span class="align-menu-fill align-menu-fill-warn" style="width:71%"></span></span>
    <span class="chip chip-count chip-warn"><i class="chip-dot"></i>5/7</span>
  </div>
  <div class="align-menu-item" role="menuitem" tabindex="0"
       aria-label="al_1 Queue shape: implementing, no questions — jump to its card">
    <span class="text-mono align-menu-id">al_1</span>
    <span class="align-menu-title" title="Queue shape">Queue shape</span>
    <span class="chip chip-accent"><i class="chip-dot"></i>Implementing</span>
  </div>
</div>
```

- **Expanding** it (a menu button, `aria-expanded`; ↑/↓ move between rows, Home/End go to the
  first/last, Escape closes) lists each open alignment on one line: those with an open question
  first, each group the last touched first. A row reads left to right: its id (mono, muted), its
  title (one line, cut with an ellipsis, the whole title on hover), a thin progress bar of its
  decided questions out of its live ones, and a round count chip "{decided}/{live}" ("5/7"). The
  bar and the chip are warn while any question is open and success once all are decided. An
  alignment with no live questions shows its status word in the status chip's tone instead of
  the bar and count. The summary is not shown, nor any question. Rows are 44px tall at every
  width. The panel opens above the chip when it fits, 340px wide from 768px; under 768px it is
  the menus' bottom sheet.
- **Choosing one** jumps to that alignment's newest card in the transcript (the jump's highlight
  included), building older rows first when the thread hasn't reached it; if the card isn't on
  screen, a toast says so.
- The counts follow the transcript as it streams: a live `align` result updates the chip before
  the run settles.

## §chat.alignment/session-mark — The session's open questions

The session list knows, from the file and with no model, whether a session is waiting on the
user's answers: each summary carries `align: {openDocs, openQuestions}` (open alignments on the
active branch and their open questions) while an alignment is open, **align is on** (the newest
`mode` entry on the branch), and **the session waits**: the newest align result that changed a
document comes after the user's last prompt (a wake nudge, a partner's link message or a topic
batch, §chat.topics/row, is not one, and neither is a message an Overseer sent, the one its
`sova-overseer-sent` mark names, §app.overseer/sent-marker: alignment questions are the user's).
Once the user has spoken again and the agent moved on without touching an alignment, or align is
turned off (nothing could record an answer), the questions stay on the card and the chip but leave
the row mark, Needs you and push; the next align result that changes a document brings them back.
Files with no `align` tool result are only searched for it, never parsed; after the first one, each
change parses only the lines appended since (a file that shrank or was rewritten is read again).

- **Row mark.** A row whose session has open questions shows the needs-you mark on line 1 as a
  the count alone ("3") in the accent, semibold at caption size, with no glyph; the count itself
  is hidden from assistive tech, and the hidden words "3 open questions. " (1: "1 open question. ")
  carry it. The title is "3 open questions in 2 alignments", or, when one alignment asks,
  "3 open questions in al_4 {its title}". It takes precedence over the
  asks-you and looping marks, never clears on a visit (it is a fact of the session, not news), hides on the open
  session like every line-1 mark, and hides while this tab runs a turn there.
- **Needs you.** An idle, unarchived session with open questions is an act item of the attention
  digest, kind `open-questions` ("3 open questions in al_3 Autonomy settings" or "… in 2
  alignments"), dated by the session's last reply; so it lists in the sidebar's Needs you, counts
  in the Overseer's badge, and is a phone-notification kind ("Open questions", on by default).
  Once the session's branch is merged (its readiness badge merged or restart pending,
  §chat.worktrees/readiness), the questions are a decide item instead, "Merged with 3 open
  questions in al_3 Autonomy settings": they stay in the digest and the row mark, but leave Needs
  you, the badge, briefs and push.

## §chat.alignment/tui — In the TUI

The TUI draws each `align` call as one dim line naming the document and its ops, and its result as
a compact card: the id, title, status and open count, the change line, and the open questions with
their recommendations, by letter and label when one names an option (the whole document, options
lettered, with its technical notes and each visual as its source text, when the tool row is
expanded). The TUI reads the writing style and Visuals from `mode-align.json` like Sova
(§chat.alignment/settings-file); adversarial review stays `pi --adversarial-review` only. A widget above the editor
lists the open alignments ("◇ align · al_3 2/7 open · al_2 implementing · alt+a view") while align is
on. The viewer (`/align`, the viewer key) shows one document at a time as markdown, ←/→ switching
between them; `/align status` lists them and `/align export [path]` writes them as markdown. An
older session's `align-doc` entries keep their one-line transcript marker.

## §chat.alignment/settings-file — `mode-align.json`

The align mode's writing style and Visuals are one file, `<agent dir>/mode-align.json`, `{version:
1, style, visuals}`: `style` is `default`, `simplified` or `pm` (Project manager), `visuals` a
boolean. One module, `pi-config/extensions/mode/align-settings.ts` (node built-ins only, beside
`mode/spec.ts`), owns it: the shape, a strict parse (another version, an unknown key, a style outside
the three or a non-boolean `visuals` is malformed, with a sentence naming the field), a reader that
reads a missing or malformed file as Default with Visuals off, and an atomic writer. Settings →
Alignment writes it (§app.settings-dialog/alignment). The mode extension reads it, in the TUI and in
every runtime Sova hosts — the style at each turn boundary, Visuals at each session start — and
Sova's server reads Visuals at a chat's first start (§chat.alignment/visuals). With the mesh on it
syncs like `mode-spec.json`: whole file, newest edit wins, checked with the module's own parser
before it is written.

Which style and Visuals a chat uses: its subagent profile's `alignment` override, field by field
(§chat.subagent-profiles/file), else this file. A profile with no override reads exactly as this
file does.

## §chat.alignment/style — Writing style

The writing style shapes what the agent writes into an alignment the user reads; it never changes
the tool, the ops or what a review records.

- **Default** adds no text: the align block is today's.
- **Simplified** adds one paragraph: short sentences in everyday words; about 5 findings and 6
  approach steps at most; a file named only when the user must recognise it; and each question's
  context says what changes for the user with each answer.
- **Project manager** adds one paragraph: the fields the user reads describe only screens,
  controls, wording, states and flows — no file paths, function or component names, APIs or code;
  questions a project manager can answer; and a consequence rule: a technical choice with an effect
  a user would notice (speed, cost, data kept or lost, limits, something hard to undo) is asked as a
  product question. "Never leave a decision out because it is technical." The technical detail goes in
  the alignment's technical notes.

**How it reaches a chat.** The style is read at each turn boundary. Its paragraph joins the align
block when the prompt's head is built — the first run after the session's start or its last
compaction (§chat.mode-menu/minor-toggle-keeps-prompt) — and the block is never rewritten
mid-session. A later change reaches an open chat with align on as **one** hidden `mode-note` at its
next run, once per change: the new style's paragraph, or, back to Default, that the earlier style
paragraph no longer applies. The note's details record the style it told and the head's, so a
reopened chat neither tells it twice nor loses what its head was built with. A head built in a style
other than Default records that style when it is built; a chat with no such record whose head was
sent since its last compaction (an older one included) had a Default head. So a chat reopened after
the style changed, with no note yet, rebuilds its head byte for byte and gets the change as that one
note at its next run. Nothing about the
style rides the per-prompt `align-state` note. Align turned on later by a note carries the align
block with the style in effect then.

## §chat.alignment/visuals — Visuals

With **Visuals** on, the align mode may draw on the alignment card (§chat.alignment/card): a
question's or the document's `visual` (§chat.alignment/document).

- **Start only.** Visuals reach a chat at its first start and never change for it: Sova records
  them with the review flag in the chat's hidden `sova-align-launch` state entry
  (§chat.alignment-review/flag) and every later start reuses it, handing the mode extension the
  `align-visuals` flag (`on` or `off`); the TUI, with no such flag, reads `mode-align.json` (and the
  chat's profile override) at session start.
- **The prompt.** With align on, a paragraph after the align block (and after the style's): add a
  visual only when it explains faster than words — a wireframe for a question about a screen, a flow,
  state or steps for a change in behaviour; call `vis_guide` before the first visual of each kind;
  in the Project manager style never the code, tree or layers kinds; after importing a planning
  worker's file, add visuals with edit_question or edit_doc. Its words never depend on the style.
- **The schema.** The `visual` fields are in the align tool's schema exactly when Visuals were on at
  the start (§chat.alignment/tool); technical notes are in it whenever align is on.
- **The vis tools.** One rule decides whether the vis tools are wanted: vis on, or align on with the
  chat's Visuals. Every place that syncs them — the mode extension's `vis_guide` and, in Sova's hosted
  sessions, `vis_check` at session start, after a switch made between runs, when a run starts and
  when it settles — asks that rule, so the tool set changes only when its answer does, never each run.
  The repair of a reply's broken `vis` fences (Sova's vis retry) stays with vis alone. A worker gets
  neither tool.
