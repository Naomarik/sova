# §app/message-labels — Message labels
> Part of the Sova design spec · [overview](../design/overview.md)

With the switch on, each message you type or dictate in a session gets one label, naming what the
message asks of the work, and every counted second of Time Spent (§app.subagents-pane/time-spent-counting)
goes to the next message you send. The session pane's Time Spent tab shows the result. A label and a
row name what a message asked for and what came next; no word on the tab names a mood or how anyone
felt. The switch is off until you turn it on (§app.settings-dialog/decisions), and with it off nothing
in this document is sent or shown, except the tab's own figures.

## §app.message-labels/time-spent-tab — The Time Spent tab and Your Messages

- **The tab.** Time Spent is a tab of the session pane, between Usage and Context
  (§app.subagents-pane/tabs). It is never the tab a pane opens on by default. It has no fold, and no
  heading repeating its name: the figures start at the top of its panel. The Session tab has no Time
  Spent section.
- **What it holds, in this order.** You, Agent and the word (Counting, Paused or Not Recording); the
  activity rows with no heading above them, Reading opening to Main Thread, Alignments and Workers;
  **Your Messages**; the **Alignments** list. Each figure other than Your Messages means what
  §app.subagents-pane/time-spent says. There is no "Your Time" heading, and no note about estimates or
  older sessions.
- **Ticking.** You ticks only while this tab is showing. Time goes on counting on every other tab and
  with the pane closed.
- **Your Messages, row order.** Specifying, Directing, Reworking, Asking, Unsorted, Not Labelled, Before
  An Action, Since Your Last Message.
- **Each row.** Its label, a count and a time, and the time is the row's main figure. The first six
  count messages. Before An Action counts the actions that closed its time. Since Your Last Message has
  no count.
- **When a row shows.** The first six rows show while they hold a message, even one with 0 seconds.
  Before An Action and Since Your Last Message show while they hold time.
- **Adding up.** While Your Messages shows, its rows add up to You, to the second, whatever the switch was
  doing. Time from before the switch went on goes to the next message like any other, and a message sent
  with the switch off stays under Not Labelled as an old message (§app.message-labels/crediting). Since
  Your Last Message is what the others leave: seconds with no message or action after them yet.
- **A row keeps up.** Since Your Last Message ticks with You. When you send a message, what Since Your
  Last Message held moves to that message. A message with no label yet is in Not Labelled, and moves to
  its label's row on the tab's next read after the label is stored, with no reload.
- **Opening a row.** Clicking any of the first six rows opens it to the messages it counted, in the
  order they were sent, and clicking again closes it. An opened row stays open, and keeps focus, through
  every tick and new read while the tab shows. Each line gives the message's first words, at most
  120 characters on one line and redacted as a decision's excerpt is, and the time counted to it. The
  lines add up to the row. Before An Action and Since Your Last Message don't open.
- **Who labelled it.** A line whose label came from the fallback model reads `Labelled by {model id}`: the
  id without its provider (`Labelled by glm-5.3`), or a Claude model's catalog name, as the chat shows it.
  A line Jev labelled says nothing about who did.
- **Reviewing Screenshots.** With the switch on, the Reviewing Screenshots activity row opens to what
  followed that time, under `Followed By Reworking`, `Followed By Specifying`, `Followed By Directing`
  and `Followed By Anything Else`: its seconds whose next message was labelled Reworking, Specifying or
  Directing, each under its own, and all its other seconds, whatever followed them or with nothing
  after them yet. The four add up to the row, and one with no time doesn't show. The words say what
  came next and nothing else. Where Your Messages doesn't show, the row doesn't open.
- **The switch off.** The whole Your Messages section is hidden, its heading and every row, Before An
  Action and Since Your Last Message included, and Reviewing Screenshots doesn't open. Labels stored
  before stay stored, and show again when the switch goes back on.
- **No message since the switch went on.** The section shows once a session has a typed or dictated
  message sent with the switch on, labelled or not, so with no provider its messages appear in Not
  Labelled. A session with no such message hides the whole section the same way, whatever time or actions
  it holds, so an old session shows nothing, and neither does one a program spoke in and you only read.
  A stored label counts as such a message, so the section comes back when the switch goes back on. With
  no message in its first six rows the section is hidden, whatever its last two hold.
- **Sessions that never show it.** A worker's session, the Overseer's, a project overseer's, a baton
  session, a merge queue chat and any session the Decisions gate stops (an excluded folder; with Never
  send TUI sessions on, a terminal session, §app.decisions/privacy) show the tab without Your Messages. An
  archived session keeps its rows.
- **Another computer's session.** The labels, the switch and the chain are those of the computer hosting
  the session, so any device reading that session shows the same rows. Reading them asks only for the
  `sessions` grant (§mesh.peers/grants).
- **Plain numbers.** Nothing on the tab flags, ranks or comments on a row, and no row is compared with
  another. The rows announce nothing to assistive technology as they tick.
- **Left out.** Totals across sessions, charts, changing a label by hand, labels in the chat or on the
  Timeline, alerts and old sessions. Nothing here reaches Needs you, the Overseer or a notification. A
  public share page (§app.session-share/page) shows no label.
- **Scripts.** Reading a session's Your Messages is in the catalogue (§app.commands/catalogue) as a look,
  with the session's record. Being listed doesn't open it to agents.

## §app.message-labels/labelling — How a message is labelled

- **The labels** are §app.message-labels/the-labels.
- **What one check sends.** The head of the message (at most 600 characters), the tail of the previous
  reply (at most 1,500, its closing spec lines cut), and two yes-or-no facts worked out in code: whether
  the agent delivered or showed results since your previous message, and whether this message attaches
  an image. Delivered or showed means a file-changing tool succeeded, a tool result carried an image, a
  worker or team handed in its report, or a reply named an image file. It sends no title, tool call,
  image or file, and goes through the redaction every decision goes through (§app.decisions/privacy).
- **It runs in the background.** Sending never waits for a label, and a failed check never fails a send.
  The agent never sees a label: none enters the context window, and it changes nothing the agent is sent.
- **Who answers.** The Decisions chain, with its normal falling through (§app.decisions/providers): Jev,
  then the fallback model if one is set. When Jev is out of quota and a model is set, the model answers
  and the label names it. The provider that answered is stored with each label.
- **Not Labelled, and catching up.** With no provider, or when every provider fails, the message stays
  Not Labelled and Sova asks again later, within the chain's backing off, for as long as it takes.
  Sova finds these messages again from which have no stored label, so after an hour of failures and a
  restart the message still gets its label. No number of failures gives up on a message sent with the
  switch on. The one wait is a request Sova itself got wrong (`bad-request`, §app.decisions/interface):
  that message isn't asked again until a restart. An archived session isn't asked about while archived.
- **The switch.** Its own switch in Settings → Decisions, off until turned on, and a settings file
  without it reads as off. With it off, nothing is sent for any message. A message sent with it off is
  never asked about, even once it is back on: it stays under Not Labelled as an old message, and it takes
  its time like any other. Going on asks about nothing sent before that moment. A message sent while it
  was on and not labelled yet is asked about again once it is back on, and labels already stored stay.
  The Decisions gate (§app.decisions/privacy) applies to every check, so no check goes out for a worker's,
  an Overseer's or a baton session, a merge queue chat, or a session in an excluded folder.
- **Stored beside the session.** Labels, each with its provider, the press times of messages that waited
  in the queue, Land presses, a hash of an offer button's words, which messages a program sent and the
  switch's moves are stored in
  `<stateRoot>/message-labels/`, never in the session's file.
- **Removed with the session.** Archiving keeps them. Deleting the session removes them, however it is
  deleted, Clean Up included (§app.session-list/archive-cleanup). Nothing else clears them.
## §app.message-labels/the-labels — The four labels, and which one a message gets

- **The four labels**, in the words the classifier gets:
  - **Specifying:** Says WHAT the deliverable should be: new work of its own however small, a problem
    in something the agent did not make here, a requirement of work not produced yet, or taking the
    agent's recommendations or picks (unless purely about process).
  - **Directing:** Says HOW the agent works, with no WHAT: process steps (verify, commit, push, merge,
    test, measure, mock-ups, review), order, who or which model, how to report; or moves work on:
    a short go-ahead or approval, also one that names the thing or the tool to use, next piece, stop,
    picks on purely process questions.
  - **Reworking:** Rejects, changes, removes, redoes or fixes something the agent made, showed or
    reported in this conversation, or says it is wrong, missing or broken, in any tone, also worded as
    a wish or handed to another agent.
  - **Asking:** Nothing requested, chosen or approved: wants only an answer, explanation (in any form),
    status, opinion, or a finding from a check.
- **What the meanings come to.** Specifying is what the work should be, new or refined; taking the
  agent's recommendations or picking among its options is Specifying, and so is a bare short yes to a
  recommendation. Directing is how the agent does its job, plus go-aheads and approvals of what is
  already decided; a pick is Directing only when every question it answers is purely about how the
  agent works.
- **A go-ahead that names the thing.** A short go-ahead or approval is Directing even when it names
  what it moves on, starts with a yes to the agent's recommendation, or picks one tool or option as it
  says to go on: "fix it", "land it", "let's get this merge ready", "take option two and carry on".
  Naming the thing is not saying what it should be; only a real description of the work's content,
  features, requirements or scope makes it Specifying. A pick or a yes that comes with a go-ahead
  ("sure, let's get this merge ready") is Directing; a bare pick or a bare yes to the agent's
  recommendations, with no go-ahead, stays Specifying. A go-ahead that only adds how carefully, fully
  or simply to do the work stays Directing.
- **A mixed message.** The first label that applies wins, in the order Reworking, Specifying,
  Directing, Asking. Any change asked for in what the agent just delivered or showed is Reworking, even
  when worded as a new idea or a wish. One clause about what the deliverable must contain, cover or
  leave out makes a message Specifying, however much of it is about method. Saying what the
  deliverable should be and also how to work is Specifying; a go-ahead plus only how is Directing; an
  investigation that also says who or how is to do it is Directing. A question attached to a request,
  pick or go-ahead takes that one's label: a go-ahead with a question is Directing.
- **Every message gets one of the four.** The classifier has a fifth answer, Unsorted, meant only for a
  message with none of your own words to judge. When its top choice is Unsorted, the most likely of
  the four labels in the same answer is stored instead, the first in the order Specifying, Directing,
  Reworking, Asking on a tie. Unsorted is stored only when the answer gave none of the four any
  weight at all. There is no confidence cutoff: a label is stored and shown however sure the answer
  was, and no stored label reads as Unsorted for being unsure. So the Unsorted row is expected to stay
  empty; it shows only while it holds a message, like the other label rows.
- **Steering is retired.** No new message is labelled Steering, and there is no Steering row. A message
  whose stored label is Steering (only test copies hold one) reads as Directing, and is not asked about
  again.

## §app.message-labels/what-counts — Which messages are labelled, and which count

- **What is labelled.** A message you typed or dictated, with words in it, sent with the switch on. A
  message held in Sova's queue is asked about when it enters the session, and one removed first never is.
- **Before An Action.** A press that hands the agent words you didn't type or dictate closes the stretch
  of counted seconds since the last message or action into Before An Action, and is neither labelled nor
  sent to the classifier. Those presses are a quick action (§app.overseer/quick-actions), a playbook step
  (§chat/playbooks), a review button (§chat.alignment-review/card), a pick on an alignment or transcript
  card, a button on an offer (§chat.offers/buttons) and a regenerate, the same words sent again from the same place
  (§chat.transcript/message-actions). A slash command that leaves itself in the chat
  (§chat/slash-commands) and a message of images with no words count the same. So does Land
  (§app.merge-queue/approve), though it puts no message in the chat, once per press at the press's
  time, and so does Land on a merge queue decision (§chat.merge-queue/decision); a typed "land it" is
  a message. A checked fix the queue puts back in line by itself under your standing Land
  (§app.merge-queue/standing-approval) is no press and closes no stretch. Stated limit: a Land on a
  decision that finds the branch blocked again closes no stretch either. A
  pick with words of your own after it is a message, labelled on those words, and typing a button's exact
  words reads as the button. After a reload or a restart of Sova, each of these still reads as it did.
- **What doesn't count.** A background job's end, a wake-up, a worker's report, another session's
  message, the Overseer's, the merge queue's and anything else you didn't send close no stretch and get
  no label: their time goes on to your next message. So does a slash command that puts no message in
  the chat. A message a program sent (a tour's notice, a release step, a script's prompt) is the same:
  not labelled, in no row, closing no stretch, and still so after a reload or a restart.
- **Stated limits.** A prompt template a slash command expanded reaches the session as plain words, so
  it counts as typed. A program's text that pi expands reads as typed too. A card calling `session.send`
  counts as a program, unless it leaves the note an offer's button leaves, which makes it Before An
  Action. With the switch off nothing is noted beside the session, so a program's message and an offer's
  button from then read as old typed messages, and a Land press closes no stretch.

## §app.message-labels/crediting — How a message's time is credited

Every counted second goes to exactly one message or action, or waits under Since Your Last Message
(§app.message-labels/what-counts says which is which). The switch changes none of this: seconds counted
before it went on, or while it was off, go to the next message or action the same way.

- **Credit goes by the press.** Each counted second goes to the next message by when you pressed Send,
  not by when the agent took it, as the computer hosting the session has that time, so a device with a
  wrong clock moves nothing. Two messages the agent took at the same moment, with their Sends 120 s
  apart, split at the second press: the later one gets what was counted in those 120 s. Two with one
  press time go by the order in the session's file. While a message waits in Sova's queue its time reads
  as Since Your Last Message; when it enters the session, the time up to its press moves to it.
- **Stop sends no words.** Pressing Stop closes nothing: its time rolls on to your next message. So does
  a queued message you remove before the agent takes it (§chat.transcript/a-queued-message).
- **No message yet.** Seconds with no message or action after them yet are Since Your Last Message.
- **Every branch counts.** A message you rewound away from keeps its label and its time. A fork's copied
  messages aren't its own: they get no label and no row.
