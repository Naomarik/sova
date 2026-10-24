# §chat/offers — Offers
> Part of the Sova design spec · [overview](../design/overview.md)

A project can declare a few named **offers** in one file: when its agent may show one, why, and the
buttons it gets. The agent shows an offer by name (with at most a short note) and Sova draws it as a
card under the reply, so the user answers with a click instead of typing "merge it" or "go". The
agent never writes the buttons, and Sova enforces every limit the file sets.

Owns: the offers file and how Sova reads it, the `offer` tool and which chats get it, conditions
and the repeat guard, send and run buttons, approving run buttons, the card and its states, an
offer shown by another chat, the project page's Offers list, and Sova's own offers file. Not here:
the Overseer's decision cards this card looks like (§app.overseer/confirm), alignment cards
(§chat/alignment), the readiness offers read (§chat.worktrees/readiness), and the asks-you signal
an open offer feeds (§app.decisions/asks-user).

In code and on the wire offers are **session offers** (`shared/session-offers.ts`,
`server/session-offers*.ts`, `/api/session-offers`), because "offers" already names what an
extension offers (§app.extensions/offers) and baton offers. The screen says Offers.

## §chat.offers/file — The offers file

- **Where.** A project's offers are `.sova/offers.json` in its main checkout (the project root of
  §chat.profiles/projects), the way session profiles are read: a branch, a worktree or a subfolder
  reads its main checkout's file, so a branch can't give itself offers by editing its own copy.
  A remote or relative cwd has no project and so no offers.
- **The file is the only control.** Sova keeps no per-user switch for offers and has no "Don't
  offer this again". To stop an offer, a person edits the file (remove it, or set `"disabled":
  true`). Sova reads the file again on every show and every click, never from a cache, so an offer
  removed or disabled there stops at once, in running chats too.
- **Shape.** `{"version": 1, "offers": {<name>: <offer>}}`. A name is lowercase letters, digits
  and hyphens, starting with a letter, at most 32 characters. An offer has:
  - `when` (required, at most 200 characters): when the agent may show it.
  - `why` (optional, at most 200): what it saves the user.
  - `title` (required, at most 120): the card's question. `{branch}`, `{base}`, `{commit}` and
    `{project}` are filled in from Sova's facts about the session (the branch its folder is on, the
    repository's main branch, master else main, the moment's commit shortened to 7 characters, and
    the project's folder name); no other placeholder is
    allowed, and one with no value reads as a plain phrase ("this branch", "its base").
  - `onlyIf` (optional): conditions that must all hold (§chat.offers/conditions).
  - `repeat` (optional): `once-per-commit` (the default), `once-per-reply` or `once-per-session`
    (§chat.offers/conditions).
  - `shownBy` (optional): `agent` (the default: the session's own agent shows it with the tool) or
    `another-chat` (only another chat shows it, §chat.offers/from-another-chat).
  - `disabled` (optional): `true` hides it everywhere but the project page's list.
  - `buttons` (required): 1 to 4 buttons, each `{label, about}` with exactly one of `send` or
    `run` (§chat.offers/buttons). `label` is at most 32 characters, `about` at most 160 (one line:
    what the button does).
- **`mainMerges`** (optional, top level): `"go-ahead"` turns on the merge guard
  (§chat.worktrees/merge-guard); absent, merges are unchanged. Any other value makes the file broken.
- **Strict, one offer at a time.** The file must be JSON with exactly the keys `version` (1) and
  `offers`, and optionally `mainMerges`; anything else makes the whole file **broken**, and no offer shows. Inside, each offer
  is checked on its own: an unknown key, a missing or over-long field, a bad name, an unknown
  condition, placeholder or `repeat` value, or a bad button makes that offer **broken**, listed
  with its reason, and never hides the others. At most 8 offers count; those after the eighth are
  broken ("More than 8 offers"). A file over 64 KB is broken.

## §chat.offers/tool — The offer tool

- **Who gets it.** An ordinary chat Sova runs, on pi or Claude Code alike, whose project has a
  valid offers file with at least one enabled offer the agent may show, gets one tool, `offer`.
  Never a worker, the Overseer, a project overseer or any other special chat; never a shared,
  watched or terminal session (Sova runs none of them). A chat with no such offer gets no tool and
  no instructions: its tools and prompt are exactly what they were before offers existed.
- **What it takes.** `{offer, note?}`: `offer` is one of this session's offer names (an enum),
  `note` an optional line under the title, at most 300 characters. The agent cannot write a title,
  a button, a label or a message: those come from the file.
- **What the agent is told.** The tool's description is made only from each offer's `when`, `why`
  and its buttons' `about` lines, under its name: what it is for, never how to write offers. It
  says the card shows under the reply and the user answers with a button, so the agent doesn't ask
  in words as well.
- **One set per session.** The first time Sova builds a session's tools, it records which offers
  the tool names and their lines (a **snapshot**, or "none") in its own state, keyed by the session
  id (`<state root>/session-offers/<session id>.json`), never in the session's file. Every later
  build reads that record: a reopen, a reload onto new code, a reconnect after a server restart,
  a resumed Claude Code chat. A fork starts with its parent's record. A session with no record
  that already holds a user message (it started before offers existed, or before its project had
  the file) records "none" instead of reading the file, so it never gains the tool on a reload.
  The file changing later
  never changes a session's tool or instructions, so a Claude Code chat keeps resuming its own
  Claude session (§app.claude-code-provider/continuity) instead of replaying its history; an offer
  added later reaches new sessions only.
- **Each call.** Sova reads the file again and refuses, showing nothing, when: the offer is gone,
  disabled or broken now; its run buttons are not approved (§chat.offers/approval); the session has
  an open alignment question; a condition doesn't hold; the repeat guard already showed it for
  this moment; or the user chose Not Now on it in this session. Each refusal says which, and
  "Nothing was shown." One open offer at a time: while another offer's card is open in the
  session, nothing shows and the refusal names the open offer in one line (a card whose offer left
  the file is withdrawn, and a once-per-commit card whose branch moved on is replaced by a newer
  commit, §chat.offers/card: neither is open, so the new card shows at once). The call never ends the agent's turn.

## §chat.offers/conditions — Conditions and the repeat guard

- **Conditions** are worked out with no model call, as the session will read once its turn ends
  (the call runs mid-turn, so "working now" is left out):
  - `branch-ready`: one of the session's worktrees is ready to merge or waiting for your OK
    (§chat.worktrees/readiness).
  - `waiting-for-ok`: one is waiting for your OK.
  - `tree-clean`: the session's folder has no uncommitted changes.
  - `no-open-alignment`: no open alignment question (always enforced; naming it is allowed).
  - `has-merge-captain`: a session on the Merge Captain profile, not archived, works in the same
    project.
  - `ready-to-land`: the worktree is Ready to land (§chat.worktrees/ready-to-land), or its specs
    can't land and it says why (`Can't land specs:`).
  - `specs-promoted`: the worktree holds no spec draft left unpromoted.
  - `specs-left`: it holds one or more.
  An offer shown for one worktree (the Merge Captain's queue, §chat.merge-round/round) reads these,
  its branch and its commit from that worktree; otherwise from the session's folder.
- **The repeat guard.** An offer shows at most once per **moment**, whatever happened to the card:
  `once-per-commit` is the session folder's current commit (a folder outside git falls back to
  once per reply), `once-per-reply` the user message the turn answers, `once-per-session` the whole
  session. An offer another chat shows has no turn of its own: once per reply there is the target
  session's last activity. There are no timers and no per-session caps beyond that.

## §chat.offers/buttons — Send and run buttons

- **Send.** `"send": "<text>"` (at most 500 characters) posts the text as the user, as the
  composer does (`session.send`, queued after the turn when one is running). `{branch}`, `{base}`,
  `{commit}` (the moment's short commit) and `{project}` are filled in when the card is shown.
- **Run.** `"run": "<catalogue id>"` runs one of Sova's own catalogue actions
  (§app/commands) on this session's own branch: the same request the web app makes, as the
  operator, with every parameter taken from Sova's facts about the session and none from the file
  or the agent. Only the ids on Sova's run list are allowed; today that is
  `project.worktree.merge` (Merge Worktree), for a session a project's overseer tracks, with the
  project's id and the session's id. Any other id, an id the catalogue doesn't have, or a run
  button an offer from another chat would send elsewhere makes the offer broken. There is no
  "update from master" or "send to the captain" action: those are send buttons.
- **A button's own conditions.** `"onlyIf": [...]` on a button (the same conditions) leaves the
  button off the card when one doesn't hold; at least one button must remain, else nothing shows.
- **Confirm first.** `"confirm": "<text>"` (at most 300 characters) makes the card ask before the
  click counts: the text, then Cancel or the button's label again. `{drafts}`, the worktree's
  spec drafts left unpromoted, may be filled in there and in `send`.
- **Landing records.** `"landing": "go-ahead"` records the user's go-ahead to land this branch at
  this exact commit (§chat.worktrees/merge-guard), `"go-ahead-without-specs"` the same with its
  spec drafts left behind, and `"not-yet"` the user's Not Yet for this commit. Each is recorded
  when the click's send succeeds, never on a refused one.
- **To the chat that showed it.** A button of an `another-chat` offer may say `"to": "shower"`
  with `send`: its text goes to the session that showed the offer, not this one
  (§chat.offers/from-another-chat).

## §chat.offers/approval — Approving run buttons

- A file with any run button needs your approval before an offer with one shows. The approval is
  of the file's run buttons as they are (each offer's name, its run buttons' labels and ids): a
  **fingerprint**. Any change to them asks again; a change to other text does not.
- Approvals are `<state root>/session-offers-trust.json`
  `{version: 1, approved: {<project root>: {fingerprint, at}}}`, outside every repository, so no
  branch, clone or chat can approve itself. Only you approve, on the project page's Offers list
  (**Approve Run Buttons**), or with **Apply and Approve** on a project overseer's Settings change card
  that grants the file's run buttons (§app.project-overseer/settings: the fingerprint the card showed).
  `POST /api/projects/:pid/offers/approve {fingerprint}` is refused when
  the file's run buttons changed since you looked: what you approve is what you saw. It is a trust
  grant, so it is no catalogue command (the commands inventory classes it as a trust grant), and no
  agent tool reaches it.
- Offers with only send buttons never need approval. A click on a run button checks the approval
  again, and an unapproved one runs nothing.

## §chat.offers/card — The card

- **Look.** The card is drawn like the Overseer's decision cards (§app.overseer/confirm): its id
  (`of_N`), the title, the agent's note under it, then the file's buttons in order and a quiet
  **Not Now** button. Each button's `about` line is its tooltip. It stands where the `offer` call is
  in the transcript, among the turn's steps, as soon as the call returns; the card's state is read
  from Sova (again after each turn, after a click, and every 20 seconds while the project has an
  offers file).
- **A click.** The card records the choice and its buttons go away; it reads "You chose **{label}**".
  A send button's text is sent as your message; when sending is refused (a terminal holds the
  session), the card stays open and says why. A run button shows "Running…", then its outcome
  ("Done: {action} done." or "Failed: " and the route's own words); the agent gets one hidden note
  at the start of its next turn naming the card, the button and the outcome. The first click claims
  the card before anything is sent or run, so a second click at the same moment does nothing; a
  send that fails reopens it.
- **Not Now** hides that offer for the rest of the session: the card reads "Not now", and the agent
  can't show that offer here again. It sends nothing. `session.offers.unsnooze` brings it back.
- **Replaced by a newer commit.** A card shown once per commit (§chat.offers/conditions) is for
  its branch at that one commit. Sova reads the branch's head again on every click, each time the
  session's cards are read and whenever it shows an offer in that session; once the branch has moved on, the card reads "Replaced by a newer
  commit", and a click on it is refused: nothing is sent, run or recorded (no go-ahead, no Not
  Yet). When the head can't be read at a click, the click is refused and the card stays as it is.
  This holds for every once-per-commit offer, Land It included.
- **Other ends.** A card whose offer left
  the file reads "No longer offered" on its next click or read, and the click does nothing.
- **Read only.** A view that can't act on the session (watching a terminal session, a shared page)
  shows the cards with their choices and no controls; an open one reads "Waiting for an answer:"
  and its buttons' labels.
- **Needs you.** While a session shows an open offer card, idle or working, the card is a Needs
  you item (`offer-waiting`, §app.overseer/attention-digest), listed among the blockers and counted
  in the Overseer's "need you"; it never sends a phone notification and never briefs the Overseer.
  While the session is idle its row also carries the asks-you mark (§app.decisions/asks-user).
- **Never over an alignment.** An offer never shows while the session has an open alignment
  question, and it never replaces an alignment card.

## §chat.offers/from-another-chat — An offer shown by another chat

- `session.offers.show` (`POST /api/session-offers/show {path, offer, note?, from?}`) shows an
  offer in a target session on another chat's behalf (the Merge Captain, when it queues a branch):
  every rule of §chat.offers/tool applies, read from the target's project. An `another-chat` offer
  shows only this way, or when Sova shows the Landing card itself on the Merge Captain's queue
  (§chat.offers/sova-landing); an `agent` offer shows either way. `from` names the session that asks (by
  id or path); a button with `"to": "shower"` needs it.
- It has no tool call in the target's transcript, so its card stands at the end of the target's
  transcript, above the composer, while it is open, and shows its choice there until the page is
  opened again. With `from`, it reads "From {title of the chat that showed it}".

## §chat.offers/project-list — The project page's Offers list

- The project page's Settings tab lists the project's offers (`project.offers.list`,
  `GET /api/projects/:pid/offers`): each declared offer's name, title, when, buttons and their
  about lines, whether it is broken (and why) or disabled, who shows it, and how many times it was
  shown and used (any button but Not Now) on this host. An offer shown at least 5 times and used
  under a fifth of those reads **Rarely used**.
- With run buttons it says whether they are approved, lists them, and has **Approve Run Buttons**
  while they are not. A broken file says why; no file says how to add one. Changes go through the
  file.

## §chat.offers/sova-landing — Sova's own offers file

Sova's repository declares one offer, **landing**, `shownBy: another-chat`, so no Sova chat gets
the tool from it: Sova shows it itself when the Merge Captain queues a branch
(§chat.merge-round/round), from the captain's chat, once per commit, and only while the branch is
Ready to land (§chat.worktrees/ready-to-land). Its title is "Land {branch} at {commit}?", the
commit shortened to 7 characters. Its buttons are send
buttons only:

- **Land It** (only when no spec draft is left): records the go-ahead for this commit and sends it
  to the captain ("Go ahead: land {branch} at {commit}."), who lands, pushes and restarts as
  usual without asking again.
- **Merge Without Specs…** (only when drafts are left and the session said why it can't land
  them): asks first, naming the drafts that stay behind to promote later on a fresh branch from
  master, then records the go-ahead without specs and sends the captain the go-ahead without them.
- **Not Yet**: records Not Yet for this commit and tells this session's agent to keep working; the
  captain leaves the branch until its head changes.

The file also sets `"mainMerges": "go-ahead"` (§chat.worktrees/merge-guard).
