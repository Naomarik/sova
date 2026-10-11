# §app/org-history — Organization history: what happened, who did it, and why
> Part of the Sova design spec · [overview](../design/overview.md)

An organization's history is one durable record of what happened in its work: each request, gap,
gathering, decision (including a decision **not** to do something), hold, refusal, promotion,
build and delivery milestone, with who started, decided, recorded and carried it out, the reason
recorded when it happened, and the explicit links between events. It sits beside the statecharts
(§app.project-overseer/statecharts), which stay the state of every lifecycle; the history records
occurrences and their recorded explanations and never decides one. The operator reads it on the
org page's History tab; the overseers read it through bounded, cited reads.

## §app.org-history/ledger — One event record per captured happening, in the workspace repo

- **Where.** Each event is one line of `history/events/<yyyy-mm>.jsonl` (the UTC month it was
  recorded) in the org's workspace repo (§app.organizations/workspace-repo), so it travels with a
  clone and attach (§app.organizations/portability). The files are only ever appended to.
- **What a record holds.** A schema version; an opaque id (`he_` and 32 hex characters) minted once when the
  event is recorded and never derived from a time, a title or a host; the org; the project it belongs to (none for an org-level event)
  and any other projects it affects, as they were placed when the event happened; the
  entities it is about (a gap, a gathering session, a decision, a conflict, a hold, a coding
  session, a person by id), each by its own id; its kind (from the capture matrix, §app.org-history/capture) and
  outcome; `recordedAt`, and `occurredAt` when the source knows when it happened (absent when it
  doesn't); its source (the capture adapter, its version and a key that makes recording the same
  happening twice record it once); the writer's epoch and sequence; its actors
  (§app.org-history/actors); its links (§app.org-history/links); its evidence references
  (§app.org-history/evidence); and how it was captured (live, imported, or a capture gap; a reason or link given afterwards
  is its own "Added later" event naming this one).
- **Structural, not words.** A record carries ids, kinds, outcomes and references, never a
  person's words, a prompt, a link token or its hash, a contact value, or the About text. The
  words recorded for it (what, the reason, the options' labels, a quote) live in its private
  rationale file (§app.org-history/rationale).
- **The statecharts are the state.** The history never stores a lifecycle's current state and no
  guard, route or tool decides an act from it. An event says what was recorded at the time; what
  is true now is read from the statecharts, as before. A history read that shows a current status
  says it is the current status, apart from the event.
- **Its headline.** A live event's headline is a verb and an object ("Gathering started: Q1
  investor reporting, with Priya Shah"), written by its capture only from the names and titles its
  step already holds (a commit as its 7-character short sha), never from contact, a prompt, a question, a briefing, a goal, a note, a link
  or anyone's message. The acts carry their object's title when they are made, from what the caller
  already holds: a gap filed, its idea's title ("Gap filed: Nobody decided hosting"); a decision
  superseded, the superseding decision's statement; a conflict settled, the decision the operator
  stated or the side kept (its statement), or the decision area when both are kept; a coding
  session's turn finished, the session's given title (an untitled session's prompt line is not its
  title, so it says "Coding session turn finished"). A decision's statement is already its own event's
  headline. A decision's statement, or a refusal's or a held act's sentence, takes its
  place where there is one. It is the event's private `what` (§app.org-history/rationale); a reader who may
  not read that, and an event without one, sees the kind's own wording.
- **Time is not identity.** Events are ordered by their writer's epoch and sequence on the host that
  recorded them, never by comparing clocks across hosts, and no id or link is made from a time.
- **A record that doesn't read** (malformed, an unknown kind, a newer schema version) is kept as it
  is, never rewritten or dropped, and reads as "This event can't be read by this version." in its
  place; the rest of the history reads.

## §app.org-history/actors — Who is not one field

- Each event names, separately: who **initiated** it (the request or act it came from), who
  **decided** it (a person, the operator, an overseer, a model), who **recorded** it (the tool,
  route or model that wrote it), who **executed** it (Sova, a worker, a session, an outside
  service), and the **authorization** it went through (the autonomy level in force, attended or
  unattended as evaluated for that act, and the hold, grant or confirm card it rests on with the
  targets that covered, by id only where the runtime knew it; an id it didn't know reads unknown,
  never a made-up one).
- **A confirm card authorizes its targets, not the act's choices.** When the global Overseer acts
  after the operator confirmed a card, the Overseer is still who decided the tool and its
  arguments; the operator's confirmation is recorded as the authorization for the card's targets
  only, never as the operator deciding or approving the operation. An operator's own direct act
  (a click, a route call of theirs) is decided by the operator.
- Each value is as the runtime knew it when the event was recorded: a model, a session or a
  worker is named only when the runtime supplied it. One it didn't know is `unknown`, never filled
  in with the operator or anyone else.
- **Initiation doesn't spread.** An operator's Run Now initiates a look; what the overseer then
  chooses in that unattended run is decided by the overseer, and reads as unattended, not as the
  operator's approval. An act in a turn the operator started is attended only as Sova evaluated it
  for that act (§app.project-overseer/autonomy-levels).
- **A conflict opened** is initiated by whoever called the reconcile run that found it, as that call's
  act carried it (the operator's Reconcile, the global Overseer's call through it, a project overseer's
  reconcile tool), under that call's authorization, and decided by the reconciler (the system); Sova
  records and carries it out. One an automatic run found (Sova's own, the statechart's) carries no
  caller, so its initiator and authorization read "Not recorded".
- A decision is **decided by** the person whose sender-marked message holds the quote only when
  its quote check passes, and the page may say so; by the operator when the operator recorded it
  directly; otherwise by the model that recorded it, with no person's authority. The model that
  called the tool is always its recorder.
- **A quote check verifies a citation, nothing more.** A quote is **checked** only when, read
  through the neutral reader, its words are a span of that message on Unicode word boundaries (punctuation, case and
  spacing aside; any length or script: a whole-message "Yes", "A", a CJK span or an emoji counts;
  punctuation alone or a piece of a word does not) and the sender that message's own sender marker
  records is the named person. The sender is never taken from the decision's claimed author or the
  holder, live or at recovery: a message with no sender marker is unchecked ("The message's sender
  wasn't recorded."), and its decision is the model's, with no speaker and no person's authority. Otherwise it is stored as quote not found,
  speaker mismatch, source unavailable or unchecked. On the page each transcript citation reads
  "Attributed to {speaker} · recorded by {recorder} · {state}", the state one of "Quote found in
  source; sender is the person named", "Quote not found in source", "Quote's sender is not the
  person named", "Source unavailable; quote not compared" or "Quote not compared with source" ("Not checked: {why}" when the record says why),
  and under the evidence: "A found quote shows those words are in the message. It doesn't show the
  person approved the record." A check never says the person confirmed the model's
  reading: the decision's statement is the recording model's wording and is shown as the model's ("Worded by {recorder}" under it whenever the recorder isn't the
  decider; the operator's own decision, a settle's statement included, is worded and recorded by the operator, so it has none;
  only a model, an overseer, a person or the operator words anything, so a template headline Sova, the statechart or the system
  composed, as a conflict opened, a decision superseded, a branch merged, a preview made or a settle gathering started, has none, and
  neither has a reason Sova stored for its author; one rule for every read),
  and only the cited quote is the person's own words. Nothing in the history says a person
  approved what a model wrote unless that person or the operator recorded it themselves.

## §app.org-history/links — Links are recorded, never inferred

- **Links are set when they are made, never inferred.** An event's links are written with it, by
  the code that knows them: its causal parents (each the event it actually came from, and how:
  a request, a timer, an invocation, an effect, a spawn, a notification, a tool call or an
  operator's act; one or more), and its other relations, each typed: `supports`, `related`,
  `supersedes`, `amends`, `revokes`, `corrects`, `adopts`, `context-of`, `source-for`,
  `named-target`, `depends-on`, `member-of`, `recorded-in`, `about` (a note or a correction about the
  event it names, read from its recorded `about`). A relation on X with target Y reads "X {type} Y".
  Nothing is linked because two events share a time, a transaction,
  an ancestor, a gap, a title or similar words.
- Only a causal parent is a cause. A trace (§app.org-history/reads) follows causal parents and the
  other recorded relations both, and marks each edge and each event it reached as a cause (only
  causal parents all the way) or a relation with its type; Triggered By and Resulted In list causes
  only, and a relation is never shown, counted or worded as a cause, in any read or tool.
- A causal parent must already be recorded in the same org (or earlier in the same step). One that
  isn't, or that would make a cause cycle, is refused and the event is recorded without it, noted
  "Trigger link refused: {why}." ("it would make a cycle", "no such event in this
  organization"). Entity relations may form a cycle and show as one.
- A link is never edited. A relink, a correction or a later-found connection is a new event that
  says so (`corrects` or `supersedes`, who recorded it and on what evidence), marked "Added
  later"; the original stays as it was recorded. A proposed connection that no one recorded a basis
  for is not a link and is never shown as one.
- A link may cross projects of the same org. A project's view keeps the link and shows the other
  project's event as a labelled boundary card, "Outside project filter", with only what that
  reader may see of it (§app.org-history/readers).
- An event with no recorded trigger reads "Trigger not recorded"; one with no recorded reason
  reads "Reason not recorded". Neither is ever filled in.

## §app.org-history/negatives — Decisions not to act are events

- A recorded decision has a **disposition**: `choose`, `reject`, `defer` or `do-not-do`; its
  options, each with a stable id and its outcome (selected, rejected, deferred); the reason
  recorded for each where one was given; the scope it covers (projects, gap, area); who decided it
  and on whose authority; and, for `defer`, the condition or date it waits for. A defer is a
  postponement, never a rejection.
- **Where they come from.** In a gathering, `record_decision` takes an optional `disposition`
  (default `choose`), `options` (`{label, outcome, reason?}`, outcome `selected`, `rejected`,
  `deferred` or `do-not-do`; each gets a stable id `o1`…`oN`, never words), `reason` and
  `review` (a condition, or a date) beside its statement and quote (§app.baton/hand-off). A project overseer
  records its own deliberate choice, an abstention included (deciding not to start, not to build,
  not to send), with `sova_decide {disposition, what, reason, options?, gap?, review?,
  supersedes?}` (L0, any turn; `reason` always required, `review` required for `defer`): it records a decision event decided by the overseer, with its
  attendance as evaluated, and changes no statechart. Sova never manufactures a decision for a
  guard that simply didn't fire, and never records thoughts.
- These stay distinct outcomes, each with its own word: **Rejected** / **Deferred** / **Won't do**
  (a decision), **Refused** (a guard's refusal, with its sentence), **Cancelled** (a held act
  cancelled), **Failed** (an effect that failed), **Unknown** (an outside act whose result never
  came back) and, for a read with nothing, "No recorded event in this scope". A refusal or a
  failure is never shown as a decision, and silence is never one.
- **Supersession.** A later decision supersedes, revokes or amends an earlier one by naming it;
  the earlier one keeps its scope, options and reasons and reads "Superseded {when} — Open New
  Decision". A read can ask what was in force as of a time, and answers from the decisions
  recorded by then.
- **Who may supersede whom.** `sova_decide`'s `supersedes` may name only a decision recorded
  with `sova_decide` (an overseer's own); naming a gathering's decision, a person's or the
  operator's, is refused, changing nothing, even when its quote didn't check: "That decision was
  made by a person or the operator: only they change it. Record your own decision without
  superseding it, and raise a card if theirs should change." A
  `record_decision` quoting that person, or the operator's own decision, can supersede it. Every
  superseding event carries its own decider and authorization; the superseded event keeps its
  decider and reasons untouched, and a packet states the supersession explicitly.

## §app.org-history/rationale — The recorded words are private and kept until purged

- An event's words, when any were given, are written with it to
  `history/rationale/<event id>.json` in the workspace repo: what was decided or done, a short
  contemporaneous reason with its author, the options' labels and reasons, and for a person's
  decision the cited quote (its message reference is in the event's evidence). It is never a
  transcript, a chain of thought or a whole message.
- **Who reads it** is who may read that event (§app.org-history/readers); a share page, the
  owner page, a hand-off session, a wrap-up and a coding session never do.
- **Added later.** A reason given afterwards is a new event marked "Added later" with its author;
  it never replaces the reason recorded at the time. It is that event's own reason, never the one it is
  about: that event reads its own recorded reason, or "Reason not recorded", in its detail, its row and
  its packet, and lists the note under it as "Added later, {date}: {the note's headline}".
- **The operator's notes and corrections.** The operator may append a note or a correction to an
  event of the same org: it names the event, says what it covers and gives a reason, and is
  recorded as a new event marked "Added later" and attributed to the operator, acknowledged only
  once it is saved; sending the same request again records it once. It relates to that event
  (`about`), shown in both events' Related, the chain and every read. It is read exactly where the
  event it is about is read now: it belongs to that event's projects as corrected today (a correction's
  own included), so an event corrected into another project takes what was added about it along, in
  search, detail, trace, packet and counts. It never rewrites the original
  event, its state or who did it, and it starts or authorizes nothing. In the event detail it is chipped "Operator
  note" or "Operator correction" ("{recorder} note|correction" for another recorder, "Note" or
  "Correction" for a reader who may not see actors), with no decider chip and no Decided by or
  Authority row, and its reason reads "Operator · Added later". The routes (the operator's, main listener only)
  are `POST /api/orgs/:id/history/events/:eid/annotate {requestId, what, reason}` and `POST
  …/correct {requestId, what, reason, projects?}` (a correction's `projects` must be this org's),
  each answering `{event, replayed}` only once the note is saved in the journal. `requestId` is 8–64
  letters, digits, `-` or `_`: the same request again answers the same event with `replayed: true`
  (a correction's too, though the event already has the projects it sets), and the same id with
  another target or body, or once the earlier note's words were purged, is refused (409, "That
  requestId was already used for another note; send a new one."). A note or a correction without `what` or a reason is refused
  (400), one sent by the Overseer is refused (403), a capture gap or a purge can't be annotated or
  corrected (409), and one saved but not yet applied answers 409 `pending-apply`.
- **Kept until purged.** A rationale stays with the org until the operator purges it: **Purge
  Reason…** on the event's detail, confirmed, removes this history's stored explanation (the rationale
  file) and every index copy of its words, and records a purge event that holds no words. It removes
  nothing else: the conversation's own messages, the decision's records and the project's spec keep
  their words, and earlier workspace commits, the remote and any backups may still hold the
  explanation. The confirm says: "Removes this reason and its search words from the history. The
  event, its links and who did it stay, and the original messages, decisions and spec keep their
  own text. Earlier workspace commits, the remote and backups may still hold it." The History tab's
  footer says: "A purge removes a stored reason here, not from earlier commits, the remote or
  backups." A purged reason reads "Reason purged {when}".

## §app.org-history/capture — What is captured, from when

- **The first release captures the org's own workflows and its delivery milestones**: an
  operator's Run Now; a gap filed, planned or dropped; a gathering started, handed off, offered or
  closed; a decision recorded, with its disposition and options, and an overseer's deliberate
  decision (§app.org-history/negatives); a conflict opened or settled; a hold created, released or
  cancelled; a managed act refused; a promotion, and its result as Sova observed it (the commit it made,
  "Decisions promoted: {short sha}" with that commit as its evidence, or the failure); a build started or finished; a merge asked for, and its
  result as Sova observed it (the commit, or the failure); a validation result (an instance's conform); a WhatsApp send; an owner update posted;
  a project setting changed; and a change of membership (a project placed, archived or
  unarchived, a person's status). A coding session's individual tool calls are not captured; they
  stay in its transcript.
- **Links the acts carry.** A conflict opened names its two decisions (`named-target`, from its
  start data's sides). Its settle gathering's start is captured as `gathering.started` ("Gathering
  started: Settle: {area}, with {name}", decided by Sova on its own), triggered (spawn) by the
  conflict's opening when that start declared the session, else naming its conflict; the settle's
  close then names that start. The operator's **Take Back** is captured as a hand-off back to them,
  "Gathering taken back by the operator". A build started on a gap's statechart names its gap and the
  decisions its start data lists; a plain coding session started from a `§gap/…` idea (the gap's own
  build wouldn't take it) names that gap from the gap item its act carries. A gathering started with
  a `preview` id (`sova_start_gathering`, `sova_offer`, §app.project-overseer/tools) names that
  preview's `preview.made`. Each is a relation, never a cause, and none is inferred: a link an act
  doesn't carry (a plain build's decisions, the promotion it follows) is not recorded.
- **A preview link made and shared.** The project statechart's `preview/start` (a preview of a coding
  session's app) and `services/share` (a link to a running copy) are each captured when taken as
  `preview.started` (outcome Started), with the actors of its own envelope like every act: the
  project overseer decides it, initiated by the operator in an attended turn; unattended it is a
  hold created and, once a review releases it (a preview's hold waits past its end for one),
  `preview.started` under that release. Its effect's answer is `preview.made`, triggered by that act through its effect: Done,
  naming the preview by its id (`pv_…`), or Failed. `preview.started` names the coding session it
  serves (and relates, `named-target`, to that session's build start when one is recorded) or the
  running copy by its instance id. A preview's link, its token or hash, its address and the
  effect's failure text are never recorded: not in an event's fields, its headline, its rationale
  or its evidence; the headline is the verb and object from ids and names ("Preview link
  requested", "Preview link made: pv_…", "Preview link not made"), and the purpose is not
  kept but in a held act's private description (its `hold.created` rationale). A WhatsApp send whose act
  carries a preview link (`sova_send_to_person` with `preview`) names that preview by its id and
  relates to its `preview.made` (`named-target`), from the act's own data. A preview the operator makes
  on the project page and the operator's share of a running copy take no statechart act, so they
  are not captured.
- **The capture matrix.** `shared/org-history.ts` lists every kind that can be captured
  (`HISTORY_KINDS`); each kind's row names the adapter and version that captures it, or none;
  each event names the capture adapter that wrote it and the adapter's version, and when capture
  started is the org's first captured event. A kind no adapter
  captures yet is not promised, and a read of a kind this version doesn't know shows it as
  unsupported.
- **Coverage is said, never implied.** The History tab's head says when capture started ("Captured
  since {date}") and, while any capture gap or imported partial period is in the shown range,
  "Earlier history partial" or the gap. A shell edit, work outside Sova and anything before capture
  started are outside it unless imported. An empty result reads "No recorded event in this scope",
  never "It never happened".

## §app.org-history/durability — Recorded with the act, or the act doesn't happen

- A managed act's event, its links and its rationale are written in the same journal step as the
  act's statechart change (§app.project-overseer/statecharts): both, or neither. The event is
  never written afterwards by a listener. A step counts as saved only once its journal is synced
  to disk, and an effect starts only after that; its result arrives as a later event whose causal
  parent is the act's event.
- **A failed save leaves nothing half done in memory.** When a step can't be saved, the act is
  refused, the org's engine reloads what is on disk, and the org takes no further act until it has.
  If the step was saved but couldn't be applied, even after a retry, the act is not refused: it
  reads "Saved, but not applied yet: it takes effect when the workspace reloads." and nothing else
  runs until it is; the org waits for Reload. "Nothing was done." is said only of a step that
  never reached disk.
- Replaying the journal after a crash records each event at most once (by its id and source key),
  checks every row of a step before counting the step as written, and drops only a torn last line
  of a step it is replaying (a fragment that begins one of that journal's own lines). A torn last
  line found before an append is kept as it is and shown as a workspace problem, "{file} can't be
  read: its last line was cut short ({n} characters); it is kept as it is and the next line starts
  after it"; any other line no pending step covers that can't be read is kept and reported
  (§app.org-history/ledger), never deleted.
- **A decision marker is never lost or doubled.** A decision entry in a transcript whose decision
  has no statechart yet is recovered when the server starts (§app.requirements/decisions), and its
  history event is recorded with it, once: recovering it again, or recording it live as well,
  finds the same source key and records nothing new. The recovered decision keeps the author id
  its entry recorded (`by`), never whoever holds the session when it is recovered, and shows the
  name its entry saved when it was recorded; an older entry with no saved name shows the name the
  conversation has for that person when it is recovered, marked as named at recovery, never
  presented as a name recorded at the time; its quote
  is checked again as it is recovered, which decides who the history says decided it
  (§app.org-history/actors). A recovery the statechart would refuse (its author is neither the
  operator nor someone the conversation recorded as a participant or a hand-off's person) is asked
  first and never taken: no step, no activity row, no history event, at any start. The entry stays
  as it is, unrecovered, and is tried again at every server start, and the org's Settings tab shows
  it as a problem, "A decision recorded in {conversation title} couldn't be recovered: {who}
  isn't part of that conversation.", {who} being the name the entry kept, else today's name for
  that person (any other refusal the statechart gives is quoted after the
  colon). An entry whose author is missing or is neither the operator nor a
  roster person is never recovered as the operator's or anyone's: it stays unrecovered the same
  way, shown as "A decision recorded in {conversation title} couldn't be recovered: its author
  wasn't recorded."
- **When history can't be saved**, every ordinary managed act is refused whole, changing nothing:
  "History can't be saved right now: {why}. Nothing was done." **Stop and Cancel still go**:
  cancelling a held act and stopping a project's instance (`down`). Each one made while history
  can't be saved is recorded, once saving works again, as a **capture gap** event ("History wasn't saved from
  {start} to {end}. Stops and cancels made then aren't in it.") with no invented chain, and the
  History tab shows it. Effect results and run reports that arrive meanwhile are held in order and
  applied once saving works, never refused or lost; timers that come due wait, then fire in order.
  Stopping a running turn and turning a preview link off are not statechart
  acts and never wait on history.
- An outside act whose result never came back (a send interrupted before it was acknowledged)
  reads **Unknown**, never sent or failed: a WhatsApp send reads done when it was sent, refused,
  failed only on a definite failure, and Unknown for anything unconfirmed. An outside act run again (a WhatsApp note sent again
  after a restart) is recorded as its own attempt with the earlier one's uncertainty kept, so two
  sends read as possibly two. Sova never promises an outside act ran exactly once.

## §app.org-history/evidence — What an event cites, and how a citation reads

- Each evidence reference says what kind it is: a **transcript message** (session id and entry
  id, an optional span, the speaker and a digest), another **event**, a **transition log row**, a
  **Git artifact** (a commit in the project or the workspace repo), a **spec record**, a
  **validation result**, or a **runtime observation**. A citation never stores a file path or a
  share link.
- A citation is opened on request only, through the harness's neutral reader, fetching the cited
  message and span, never a whole transcript. It reads as one of: available, missing, withheld (the
  reader may not see it), changed (its stored digest no longer matches), unsupported
  version, corrupt, on another host, or unchecked, each in words on the page. A digest shows a
  source changed; it never proves the source was true.
- Text from a source or a record is data, shown and passed as untrusted content, never as
  instructions.

## §app.org-history/reads — Bounded search, trace and packet, with no model call

- **Search** finds events by project, kind, actor, outcome, time range and words of their
  headline and readable rationale: at most 50 hits a page, newest first, with a cursor and the
  total count. A project overseer's search never reveals which other
  projects its own events affect: filtering by another project finds none of them.
- **Trace** from one event follows its recorded links, triggers and every other relation, at most
  2 hops each way and returns at most 100 events, each edge marked `cause` (a trigger, with how) or
  `relation` (with its type) and each event marked as reached through causes only or through a
  relation; saying how many it left out, which returned events it cut past on each side (`frontier`)
  and which frontier events have no recorded trigger, with a cursor to go further. The next page carries
  what the earlier pages returned: it returns its own edges to those events, so what it adds joins the
  chain already shown, and never returns one of them again. A project overseer's trace walks no further than a boundary card. The
  overseers' trace text says "before {n}" or "after {n}" with "(cause)", "(result)" or "(relation:
  {type})", and each edge "cause ({how})" or "relation, {type} (not a cause)".
- **Packet** is one event's or one query's context, at most 12,000 characters: the query and
  scope, what it is as of (the newest event it includes), the controlling decision and what
  superseded it, the recorded reasons and rejected or deferred options, the causes, permitted
  cross-project dependencies, each citation with its state, what is unknown, the index's freshness,
  and what was cut. **Copy Context** on the History tab copies exactly this packet.
- Every read is answered from a host-local index under `<stateRoot>/org-history/<org>/` (event id to file and
  offset, project, kind, actor, time, links both ways, the words of readable headlines and
  rationale), updated after each committed step and rebuilt from the event files when missing or
  stale; a rebuilt index answers every read the same. No read scans every event file per query.
- **Routes** (the operator's, main listener only): `GET /api/orgs/:id/history` (search: `project`,
  `kind`, `outcome`, `actor`, `initiation`, `from`, `to`, `q`, `asOf`, `groupOf` for the events grouped
  under one, `cursor`, `limit`), `GET …/history/events/:eid?asOf=` (one event), `GET
  …/history/events/:eid/chain?hops=&limit=&cursor=&asOf=&project=` (trace), `GET …/history/packet` (an event's
  packet with `event=<eid>`, else a search's, with the search's parameters), `GET
  …/history/events/:eid/evidence/:n` (one cited span) and `POST …/history/events/:eid/purge
  {confirm: true}` (§app.org-history/rationale). An unknown parameter is refused (400).
- No history read calls a model: who, when, what and the recorded why are read, not written.

## §app.org-history/readers — Who reads the history

- **The operator**, on the org page's History tab (§app.org-history/page), every event of the org
  (main listener only; an org attached on a peer is read through that host, as its page's other
  reads are, §mesh.remote-sessions/org-pages).
- **A project overseer**, through `sova_history {action: search | event | trace | packet, q?,
  kind?, outcome?, from?, to?, event?, hops? (1–2), cursor?, limit? (at most 50)}` (a read, at any
  level): its own project's
  events, and from another project of the org only the boundary card of an event linked to one of
  its own (kind, outcome, time, project; its who reads "who: withheld"), never that event's words or citations.
- **The global Overseer**, when it asks for it: `sova_org_history {org, project?, action, …}`, the
  same reads over the whole org, in turns the operator started only (elsewhere: "The organization's history
  is read only in a turn the operator started: ask them."), built by its org projection (§app.overseer/org-projection), so contact reads
  `[contact]` and no link reaches it.
- **Who may read is decided now.** A read as of an earlier time (`asOf`) still uses who may read
  what today, never who could have read it then.
- The models' history tools only read: none of them writes, corrects or annotates the history.
- Nothing else reads it: no share page, owner page, `/h/` or `/i/` response, hand-off session,
  wrap-up, reconciler decide call, coding session, session list or attention digest.
- No event and no rationale file holds a contact value or the About text, so no history read carries
  either: `contact never enters any model prompt.` (§app.organizations/privacy), and About keeps
  its own readers (§app.organizations/about).
- Search hits, counts, snippets, citations and packets are made from what the reader may see; a
  withheld event is neither counted nor hinted at.

## §app.org-history/page — The History tab

- **The tab.** The org page has a **History** tab, the fourth, after People and before Settings
  (`#/orgs/<id>/history`), with no count and no needs-you dot. One event's detail is
  `#/orgs/<id>/history/events/<event id>`. The filters and the view are in the URL's query
  (`project=<pid>,<pid>`, `kind=`, `actor=`, `initiation=`, `from=`, `to=` as dates, `q=`,
  `view=chain` and with it `more=<n>`, how many times the Causal View was expanded (1–50), beside `host=` for an org on a peer); a value the page doesn't know is dropped,
  never guessed. Picking the tab still replaces the hash; changing a filter or the view, or
  selecting an event, adds one history entry, so Back restores the previous filter and selection
  and a reload or a link opens the same view. An event link identifies an event; it grants nothing
  and works only for someone who may read it.
- **Head.** "History" and the coverage line (§app.org-history/capture), then one filter bar:
  **Search History** (literal words, no model), Project (All projects, or one or more of the org's
  projects, archived ones labelled "Archived"), Kind (in groups: Requests and looks, Gaps,
  Gatherings, Decisions and conflicts, Holds, refusals and stops, Promotions and builds, People,
  projects and settings, History notes; `kind=<group>` in the URL), Initiation (operator,
  overseer, person, system, unknown) and **More Filters** (actor, from, to); a set filter says its
  value in words, and **Clear Filters** shows while any is set. The count in the bar is the
  server's, "{shown} of {total} events", with "· {n} linked outside this filter" only when the
  server returned such events. **Copy Context** in the bar copies the packet of the filters as
  set. The tab's footer says where history is kept (§app.org-history/portability) and what purging
  leaves behind (§app.org-history/rationale).
- **Timeline** (the default) and **Causal View** are a view switch, not more tabs.
- **A timeline row**, newest first, grouped by day: the time (mono, the app's 12-hour clock), the project, a
  headline (verb and object), its outcome word with a marker, who ("{decider} · started by
  {initiator}", with "· unattended" for an unattended act; an unknown one reads "Decided by: not
  recorded" or "start not recorded"), and the recorded reason's first line when there is one. Refused, deferred, rejected, won't-do,
  cancelled, failed and unknown rows show like any other. **Show Details**, on a row the server says has
  some, lists the lower-level events grouped under it: the events whose causal parent it is and that share its
  recorded source transaction, never events grouped by time or title. **Show More** loads the next page, and the bar says how many aren't loaded yet.
- **Projects.** A placed project's Overview has a **History** card (second column, before
  Activity: "What happened in this project, who decided it, and the reason recorded.") whose
  **Open History** opens this tab filtered to
  that project. Filtering keeps the events that project owns or affects; a linked event of another
  project is never listed as the project's own, only as its boundary card, labelled "Outside
  project filter"; a boundary card whose actors the reader may not see reads "Who: withheld". Clearing the filter
  returns to all projects with the same event selected.
- **Event detail.** Beside the timeline when the pane is wide enough, one framed region whose head
  (headline, outcome, time and actions) stays while its body scrolls; a view of its own when it
  isn't, starting at **Back to History** (keeping the filters and scroll; the filter bar and the view
  switch return with the list). Its head: the headline ("Worded by {recorder}" under it whenever the
  recorder words statements and isn't the decider, §app.org-history/actors; never under a template headline), the outcome (with the decision's disposition
  chip only when the outcome word doesn't already say it; a note's or correction's author chip, and
  "Imported" as a plain chip; no decider chip: Who says it), the time ("Recorded {t}", "Happened {t}" when that differs, nothing more for an event with
  no occurrence time of its own, as a note; "Imported {t}" for an imported event), the projects and its actions. Then: what was decided or happened, only when the recorded statement
  says more than the headline (with "Worded by" under it then, instead of under the headline); the
  recorded reason with its source citation and the caption "{author} · Worded by {recorder} ·
  recorded at the time" ("Added later" for a later one; "Worded by" only when the recorder isn't
  the author, as when a model writes a person's reason), or "Reason not recorded"; who initiated, decided, recorded and executed it and on what
  authorization, each "Not recorded" when unknown, followed by the why recorded for it when there is
  one ("Not recorded: the gathering's turn."), who an authorization was by named ("A person's decision ·
  by Mahmoud", never a raw kind), and a decision's authority on its own line only when it isn't who
  decided. Then the options as recorded only (Selected,
  Rejected, Deferred, Won't do, each with its reason or review condition; a condition that
  already starts with "until" shows as written, any other as "Until: {condition}"), the numbered evidence
  with each source's state (§app.org-history/evidence; a decision whose source can't be opened reads
  "Decision recorded; source unavailable"), Triggered By, Resulted In and Related, each labelled
  with its relation read from the linked event's side ("Triggered this · effect", "Names this as its
  target", "This was recorded in it"; "Trigger not recorded" as text when there is none; no evidence
  and no consequence read as one muted line, "No evidence cited · no recorded consequence.", not as
  empty blocks; a relation whose target
  is an entity, not an event, is its own line in Related with no link, "This {relation words}
  {entity type} {entity id} · not in this history" ("This was recorded in gathering s_123 · not in
  this history"), its type and id as stored), the hold and policy, the capture status, and
  supersession. Its actions are **Copy Event Link**, **Copy Event Context** (this event's packet; the
  bar's **Copy Context** is the filters'), **View Chain**, **Open Source** (the cited span only, on
  request) and **Purge Reason…** (§app.org-history/rationale), the one write, last in the detail's
  foot after its disclosures; it never approves, builds or acts.
- **Causal View** centres on the selected event (with its detail beside it when the pane is wide
  enough; when it isn't, the event carries **Open Event Detail**): 2 hops each way through recorded
  triggers and relations, at most 100 events, with **Expand {n} Earlier Events** (or **Later**) for the next
  bounded step and the bound said in words ("{n} events within 2 steps · nothing left out", or how
  many earlier and later events aren't shown). Expand sits in the section where the bound cut the chain
  (Came from, Led to or Related), and each card it cut past says "Earlier events past this aren't shown" or
  "Later events past this aren't shown"; never under a section the cut isn't in. The events it adds take
  their places in the same sections by their returned edges, with their words and rails, as if read at once:
  a trigger among them is a cause, on its solid rail, and joins Came from or Led to when it chains to this
  event. Expanding adds one history entry (`more=`), so Back, Forward and a reload show the chain as far as
  it was expanded; another event's chain opens unexpanded. The chain is drawn as one ordered relation list,
  keyboard navigable, full width with no sideways scroll: **Came from** (its causes, through
  triggers only), **This event**, **Led to** (its consequences, or "No recorded consequence.") and
  **Related · not causes** (every other event the trace reached), so causes sit in their own
  sections apart from other relations, never by line style alone. Each event shows once; each
  returned edge is said once, in words between the cards it joins, from the card's side ("triggered
  this · effect", "adopts this", "recorded in it"); a relation is never worded as a cause. Where a
  trigger wasn't recorded the list says "Trigger not recorded" and draws no line.
- **No model.** The tab has no Ask About History: search, detail, chain and Copy Context read
  records only (§app.org-history/reads).
- **Live.** A background re-read at the org page's pace is reconciled in place: the selection,
  filters, focus, scroll and open disclosures stay.

## §app.org-history/portability — History travels, and imports only what is recorded

- **It rides the workspace commits.** `history/events/` and `history/rationale/` are ordinary
  workspace files: the workspace's commits take them like every other change (the hourly commit,
  Commit Now and the shutdown commit, §app.organizations/workspace-repo), and a clone and attach
  brings them with every event id and link unchanged (§app.organizations/portability). The index
  under `<stateRoot>/org-history/<org>/` is never committed: an attach builds it again from
  `history/`.
- **Where it is kept.** The History tab says: "History is kept in this organization's workspace
  repo on this device; only a push to its remote copies it elsewhere."
- A host-local source (a coding transcript, a watch row, a file's bytes) stays referenced on
  another host and its citation reads as on another host.
- An event that two copies record differently under one id is shown as a conflict, both kept,
  never merged by time.
- **Import of what already exists.** Existing org records are imported once, only where a fact and
  its link are recorded (a decision's session and gap, a gathering's start data, a statechart's log
  row, a snapshot's current state), and only by the host that holds the org
  (§app.organizations/holder). Each imported event keeps the source's own time as when it happened
  only where the source records it (absent otherwise) and its import time apart; an actor or a
  reason is recorded only where the source records it, and reads unknown otherwise. A snapshot
  imported now records what was observed at import, never a reconstructed earlier action or motive.
  Nothing is matched by title or similar words, and no About text, profile, contact value or whole
  transcript is copied. The import leaves a receipt in `history/`, so it runs once: running it
  again, on this host or on a clone, imports nothing new and keeps every id. The receipt is one
  history event (source key `import:baseline:<org>`), written in the same journal step as the facts
  it imported, last. An org created with this version gets a receipt that reads "Nothing to import:
  the organization started with its history.", and no imported event is made for it, not even for
  its creation. For an org that existed before, what its records hold now is imported as observed
  at the import, at the import's time, and its receipt reads "Existing records imported; earlier
  acts, holds, sends and reasons are not recorded": those are never reconstructed as events. Its reads count imported
  events as partial coverage ("Earlier history partial").
- Archiving a project, retiring a session from the list, a person leaving and a restore never
  delete an event or let anyone new read it.

## §app.org-history/seams — Inside the harness and project boundaries

- A server feature imports `shared/harness.ts` and `server/harness/`, never pi: the history's
  modules (`shared/org-history.ts`, `server/org-history/`) and their tools are written as
  `ToolSpec`s and read session messages through the harness.
- History is read through the neutral reader, never `parseLines` plus a switch on `entry.type`.
- The project layer never knows organizations exist (§app.projects/seam): no project module
  imports the history; the org layer records project events through the registration points the
  project layer already offers.
