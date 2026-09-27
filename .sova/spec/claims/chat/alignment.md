# §chat/alignment — Alignments
> Part of the Sova design spec · [overview](../design/overview.md)

While the **align** minor mode is on (§chat/mode-menu), the agent agrees with the user on what to
build before building it, and records each agreement as an **alignment**: a structured document it
keeps with one tool, `align`, from pi's `mode` extension (`pi-config/extensions/mode`). A session
can hold several alignments at once, one per concern. The user never edits one: they answer in
chat, and the agent records the answer. Sova shows each alignment as a card in the transcript, a
chip in the composer, and a count on the session's row. It works the same in the TUI and in Sova,
for sessions Sova holds and sessions it only watches.

## §chat.alignment/document — What an alignment holds

An alignment has an id `al_N` (the next number on the branch), a title, a one-line **summary** of
the concern, findings, approach steps, rejected alternatives (each with why), and questions. Items
have ids that are never reused within the document: findings `fN`, approach steps `aN`, rejected
alternatives `xN`, questions `qN`. A question has a topic, the ask, optional context, optional
options (each a label and its trade-off), a **recommendation** (the choice and why), and, once
answered, a **decision**: its text, who made it (`user`, or `accepted-recommendation` when the user
took the recommendation), and when. A question can also be dropped, with why, and reopened.

**Status is derived from the data**, never typed: `dropped` or `done` when the document was dropped
or marked done; `implementing` when it was marked so; otherwise `aligning` while any question is
open or it has no questions yet, and `confirmed` once every question is decided or dropped. Only
the transitions no data can show are explicit: implementing, done, dropped, and back to open.
Done and dropped are terminal; everything else is **open** for the chip and the session's count.

## §chat.alignment/tool — The `align` tool

The tool is in the agent's loadout only while the align minor mode is on; turning align off removes
it. One call applies a batch of operations to one document, **atomically**: every op is checked
first, and one bad op (an unknown id, a missing field, a field the op doesn't take) fails the whole
call with a reason and changes nothing. A field name borrowed from another tool gets a hint at the
one meant (`newText`, pi's own edit field, on an `edit` op: "did you mean `text`?"). With more than
one open alignment, a call must name its document.

- **create** `{title, summary, findings?, approach?, rejected?, questions?}` — a new document,
  `al_N`. Every question needs a topic, an ask and a recommendation.
- **create** `{fromFile}` — the same document read from a JSON file (the create fields, nothing
  else), relative to the session's cwd, so a planning worker can write the alignment and the agent
  imports it without retyping. The file is validated strictly: malformed JSON, an unknown key or a
  wrong type is refused with the path of the bad field.
- **add** `{findings?, approach?, rejected?, questions?}`, **edit** `{id, …fields}` (a question's
  topic, ask, context, options or recommendation; a finding's or step's text; a rejected
  alternative's option or why; without `id`, the title or summary), **remove** `{ids}` (findings,
  steps and rejected alternatives; a question is dropped instead, so its id keeps its meaning).
- **decide** `{q, decision}` records the user's answer; **accept** `{q: "open" | [ids]}` takes the
  recommendation as the decision, recorded as accepted; **reopen** `{q}` clears a decision or a
  drop; **drop** `{q, why}` drops a question, and `{why}` alone drops the document.
- **status** `{to: implementing | done | open}` — the lifecycle moves the data can't show.
  Implementing and done need every question decided or dropped first (an `accept` earlier in the
  same call does it). A document that is done or dropped takes nothing but `status open`.
- **exempt** `{why}` — alone in its call, touching no document: the agent records why a work
  request needs no alignment.
- **get** — the document (or, with none named, every open one) as markdown, read-only.

The tool's answer is a compact echo of what is still open: the touched document's id, title,
status and "k of n open", one line per open question with its recommendation, and one line naming
the other open alignments.

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
  planning worker write the alignment JSON for `create` with `fromFile` (with Delegate on, at an
  absolute path outside the project's working tree, so the plan leaves no file in the user's
  repository), to change a document only
  through ops and never by re-creating it, to record answers with `decide`/`accept`, to use
  `exempt` for a work request that needs no alignment, and to mark `implementing` before building
  and `done` when finished. With Delegate on, the bridge paragraph says the same for the planning
  worker hand-off. The tool's own description and guidelines carry the core of it too, since they
  sit in pi's tools section.
- **A hidden note on each user prompt.** While align is on and an alignment is open, each prompt the
  user sends carries a hidden message (`align-state`, never shown in the transcript) listing the
  open alignments, their status and their open questions with ids and recommendations, so an answer
  like "q2 yes, your recs for the rest" maps onto the right ids. Nothing about alignments goes into
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
  settles). "Reads like a plan": an old markdown alignment block; a reply whose last paragraph
  ends in a question and either asks for a decision itself ("open questions", "should I go ahead",
  "which do you prefer", "take my recommendations", and the like) or follows a list of two or more
  items with such words above it; or, anywhere in the reply, a short line with such words ("Questions
  for you:") followed by a list with two or more questions, since a reply can close on a statement
  after asking. Code blocks and the spec mode's closing "Also changes" line don't count.
  Calibrated on two real sessions: it caught every alignment block and freeform plan there, and one
  of about 80 other replies; the labelled list adds about 1 in 100 final replies across 222 other
  sessions, nearly all prose plans asking for decisions.

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
      <span class="chip chip-warn"><i class="chip-dot"></i>Aligning</span>
    </div>
    <p class="align-doc-meta">2 of 7 open · q3 decided · +q11</p>
  </header>
  <p class="align-doc-summary">How far the Overseer may act without asking.</p>
  <ol class="align-questions">
    <li class="align-q" data-state="open|decided|dropped">
      <p class="align-q-head"><span class="text-mono">q3</span> <strong>Pace limit</strong>
        <span class="chip"><i class="chip-dot"></i>Open</span></p>
      <p class="align-q-ask">How often may it start a run on its own?</p>
      <p class="align-q-context">…context…</p>
      <ul class="align-q-options"><li><strong>1 per 10 min</strong> — trade-off</li></ul>
      <p class="align-q-rec">Recommended: <strong>1 per 10 min</strong> — why</p>
      <p class="align-q-decision">Decided: … · you | accepted recommendation</p>
    </li>
  </ol>
  <details class="align-section"><summary>Findings · 3</summary>…</details>
  <details class="align-section"><summary>Approach · 4</summary>…</details>
  <details class="align-section"><summary>Rejected · 2</summary>…</details>
</article>
<!-- an earlier revision -->
<details class="disclosure align-rev">
  <summary class="disclosure-summary"><span class="text-mono">al_3</span> v4 Autonomy settings · q3 decided · +q11</summary>
  <div class="disclosure-body">…that revision's card body…</div>
</details>
```

- **Card** is capped at `--measure`, `--space-3`/`--space-4` padding; the eyebrow is `micro`
  uppercase muted, the title `heading-s` semibold, the meta a muted caption. Questions are separated
  by a `--color-border` rule; the ask is ink body text, context, options, recommendation and
  decision are captions (context muted). Inline code spans and bold runs in these fields render;
  no other markdown.

- **Status chip**, dot and word: Aligning (warn), Confirmed (success), Implementing (accent), Done
  (success), Dropped (neutral).
- **Questions** show their parts distinctly: the ask in body text, context in muted caption,
  options as a list of label and trade-off, the recommendation on its own line, and the decision
  (with "you" or "accepted recommendation") once there is one. Open questions carry an Open chip;
  a decided one reads Decided, a dropped one Dropped with its why.
- **Nothing on the card writes.** There is no checkbox to tick and no button that answers, accepts
  or pre-fills an answer: the user answers in chat.
- While a run streams, the call's card appears as soon as its result arrives, from the result's
  own snapshot; the settled transcript renders the same card.

## §chat.alignment/chip — The chip in the composer

In a chat's composer, the run-status row carries an alignment chip **immediately left of the
Inputs trigger** (§chat/composer): "{n} aligns · {open}/{total}" ("1 align · 2/5"), where `n` is
the open alignments on the branch and `open`/`total` count their open and all their live (not
dropped) questions. It is omitted when no alignment is open, and the row shows for it alone. The
chip and the Inputs trigger sit together at the row's right end.

```html
<button type="button" class="run-status-link run-status-align" aria-haspopup="menu" aria-expanded="false"
        aria-label="2 open alignments, 5 of 15 questions open — show alignments">
  <span class="icon icon-sm" style="--icon:url(/icons/chat.svg)" aria-hidden="true"></span>
  <span class="text-num">2 aligns · 5/15</span>
  <span class="icon icon-sm" style="--icon:url(/icons/chevron-down.svg)" aria-hidden="true"></span>
</button>
<div class="model-menu action-menu align-menu" popover="auto" role="menu" aria-label="Open alignments">
  <div class="mode-option group-option align-menu-item" role="menuitem" tabindex="0">
    <span class="mode-option-text"><span class="mode-option-id"><span class="text-mono">al_3</span> Autonomy settings</span>
      <span class="mode-option-note">How far the Overseer may act alone. · 2 of 7 open</span></span>
  </div>
</div>
```

- **Expanding** it (a menu button, `aria-expanded`; ↑/↓ move between rows, Escape closes) lists
  each open alignment, the last touched first: its id and title, then its summary and "{k} of {m}
  open" (or its status word when nothing is open). The panel opens above the chip when it fits,
  340px wide from 768px.
- **Choosing one** jumps to that alignment's newest card in the transcript (the jump's highlight
  included), building older rows first when the thread hasn't reached it; if the card isn't on
  screen, a toast says so.
- The counts follow the transcript as it streams: a live `align` result updates the chip before
  the run settles.

## §chat.alignment/session-mark — The session's open questions

The session list knows, from the file and with no model, whether a session has open questions:
each summary carries `align: {openDocs, openQuestions}` (open alignments on the active branch and
their open questions) whenever an alignment is open. The fold reads the whole file only for
session files that contain an `align` tool result, and only when the file changed.

- **Row mark.** A row whose session has open questions shows the needs-you mark on line 1 as a
  speech bubble in the accent followed by the count ("3"), with the hidden words "3 open
  questions. " and the title "3 open questions in 2 alignments". It takes precedence over the
  looping mark, never clears on a visit (it is a fact of the session, not news), hides on the open
  session like every line-1 mark, and hides while this tab runs a turn there.
- **Needs you.** An idle, unarchived session with open questions is an act item of the attention
  digest, kind `open-questions` ("3 open questions in al_3 Autonomy settings" or "… in 2
  alignments"), dated by the session's last reply; so it lists in the sidebar's Needs you, counts
  in the Overseer's badge, and is a phone-notification kind ("Open questions", on by default).

## §chat.alignment/tui — In the TUI

The TUI draws each `align` call as one dim line naming the document and its ops, and its result as
a compact card: the id, title, status and open count, the change line, and the open questions with
their recommendations (the whole document when the tool row is expanded). A widget above the editor
lists the open alignments ("◇ align · al_3 2/7 open · al_2 implementing · alt+a view") while align is
on. The viewer (`/align`, the viewer key) shows one document at a time as markdown, ←/→ switching
between them; `/align status` lists them and `/align export [path]` writes them as markdown. An
older session's `align-doc` entries keep their one-line transcript marker.
