# 12 · Inputs tab and rewind
> Part of the pi-web design spec · [overview](overview.md)

The session pane (§11) gets an **Inputs** tab, second after Session: this session's own messages
on the active branch, newest first. Each can rewind the chat to just before it, and the message's
text comes back to the composer so it can be edited and sent again. It is pi's `/tree` on a user
message, cut down to the one thing people use it for: "take that back and let me say it better."

It is its own tab, not a section of Session, because it's the one place in the pane that
writes. Everything else there is read-only — including **Timeline** ([13-timeline.md](13-timeline.md) §13),
which sits beside it and draws the same messages on a time axis: its rows jump, and only jump.

## Opening it

- The tab strip, like any tab. The pane keeps the tab per session path.
- A bare `/tree` in the composer opens the pane on Inputs. It opens, never toggles shut, clears
  the draft and announces "Inputs open." `/tree` with arguments falls through to a normal send.
- The composer flyout's **Undo last turn** (§9 Composer flyout), the last item after a
  separator, rewinds to just before the newest message without opening the pane.
- **The composer's own inputs row**, below. It is the discoverable door: the tab strip only helps
  someone who already opened the pane, and `/tree` only helps someone who knows pi.

### The inputs row

The composer's `.run-status` line (§3) grew a second control, right-aligned beside the subagents
one, a `button.run-status-link` pushed over with `margin-left:auto` and no new CSS:

```html
<p class="run-status">
  <!-- the subagents trigger (§11), when there is one -->
  <button type="button" class="run-status-link" aria-expanded="false" aria-controls="session-pane"
          aria-label="7 inputs in this chat — show inputs">
    7 inputs
    <span class="icon icon-sm" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
  </button>
</p>
```

- **The count is the user's own messages on the active branch**, the same rows the tab lists, from
  `inputCount` in `src/lib/input-count.ts`. It drops the moment a rewind lands, because the branch
  is what it counts.
- **Hidden at 0**, and hidden means *absent*: a session nobody has written to yet shows no control,
  not a greyed one. Visible text is "7 inputs" / "1 input"; the accessible name says what it does,
  and stays singular throughout at one: "1 input in this chat — show input".
- **The row now renders whenever any of its three parts has something to say** — a running turn,
  workers, or inputs. It used to appear only while streaming or while workers ran, so an idle
  session had no row at all and nowhere to put this.

Both triggers point `aria-controls` at the pane's one tab-neutral id, `session-pane` (§11). The
pane is in the DOM only while it's open, so that reference dangles while it's closed: intended,
and the same thing the subagents trigger has always done.

`aria-expanded` is **per tab, not per pane**: true only when the pane is open *and* that trigger's
own tab is the one showing. The app passes the pane's active tab down to the composer, and each
trigger compares it with its own (`"agents"` for subagents, `"inputs"` here).

| Pane state | Subagents trigger | Inputs trigger |
|---|---|---|
| Closed | `false` | `false` |
| Open on Agents | `true` | `false` |
| Open on Inputs | `false` | `true` |
| Open on Session, Timeline, Skills or Explain | `false` | `false` |

That last row looks odd — the pane is plainly open and both controls say collapsed — but
`aria-expanded` answers "did *this* control's content open?", and neither one's did. Saying true
would promise a user that activating it changes nothing, when it still has to switch tabs.

## Rows

`<ul class="list input-list" aria-label="Your messages">`, built like the skill list. Each
`li.input-row[data-input="<entry id>"]` is one message, in two parts (the tab's own anatomy: it
does not use `.list-row`, whose padding and single hit area suit a row that does one thing):

- **The body is a button** (`.input-row-body`) that **jumps to the message in the transcript**,
  opening with a visually hidden "Jump to this message: " so the action is in its name. Inside it,
  `.input-row-title` is the text clamped to **two lines** (`-webkit-line-clamp: 2`, the full text
  in `title`), and `.input-row-meta` is the relative time, absolute in its `title`.
- **Rewind** (ghost, `button-sm`) sits apart at the row's end, in `.input-row-actions`.

Reading and acting are the two things to do with a past message, so they get one row and two
targets: a wide body to read and land on, a small deliberate button to undo with. An images-only
message reads "1 image" or "{n} images".

**The rows are the smaller type scale** — caption for the title, micro for the meta — because a
long session has a lot of them, and a list you scan wants density more than it wants weight. Two
clamped lines is enough to recognise a message you wrote.

**Jumping** scrolls the row to the middle of the transcript and tints it for ~1.5s
(`.entry-jumped`, `JUMP_HIGHLIGHT_MS` in `src/lib/jump.ts`, which is the one helper the outline
strip, the Skills tab and this tab all share). Below the column band (1280) the pane is a drawer
over the transcript, so a jump would land behind it: **the pane closes on jump** there, and stays
open in the column band. **A message the transcript doesn't show** — compacted away, or scrolled
out of a branch that no longer holds it — can't be landed on, so the jump says so instead of
scrolling nowhere: "That message isn't in the transcript on screen."

**Newest first**, oldest growing downwards, and the list opens at the top rather than scrolled to
the end: the message someone wants to take back is nearly always the last one they sent, so it
should be the first row, not the one furthest from the eye.

Only the active branch is listed; sibling branches from earlier rewinds or TUI `/tree` moves
aren't, since picking between them is the TUI's job. A foot line under the list says both: "Newest
first, active branch only. A row jumps to its message; Rewind takes the chat back to just before
it."

Empty: "0 messages on this branch." with "Messages you send show up here, and each can rewind
the chat to just before it."

## Confirm, inline

Rewind is two steps, in the row, with no modal. The first click turns the row's button into
**Rewind Here** (destructive, focused) beside **Cancel** (ghost), and an `.input-row-note` says
"This message and every reply after it leave the branch. The session file keeps them." Esc
cancels without closing the pane. The flyout's Undo last turn works the same way: the first
click relabels it "Confirm: undo last turn" and the flyout stays open; closing it disarms.

While one rewind is in flight its button reads "Rewinding…" with `aria-busy`, and every other
row is disabled ("A rewind is already in progress.").

## When it's off

Rewind is `aria-disabled` with the reason in its title and description, never hidden:

| State | Copy |
|---|---|
| A turn is running | "Stop the current turn first." |
| A compaction is running (including a manual `/compact`) | "Wait for the compaction to finish." |
| Open in a terminal (TUI-live) | "This session is open in a terminal, so pi-web won't write to it." |
| Watching, or no chat open here | "Only a chat open in pi-web can rewind." |

Streaming refuses; it never auto-aborts. Stopping is the user's call, and a rewind that
silently killed a running turn and its workers would be the surprise. The server enforces all
of this again (below), so a stale pane can't get past it: a refusal's message shows inline under
its row (a `.text-error` span inside the `.input-row-note`, hung off the button's `aria-describedby`), and the flyout
toasts it.

## After a rewind

The composer gets the message's text ahead of whatever draft was there, the same way a Stop
hands back queued messages, and announces "Rewound. Your message is back in the composer."
Images aren't handed back, as in pi's `/tree`. The thread, context ring and mode redraw for the
new branch; a rewind to the first message leaves an empty thread.

In the tab, the rewound-to row stays as the **boundary** (`.input-row-boundary`, the accent tint)
with a focusable note, "Rewound to just before this message. Its text is in the composer.", and
focus lands on it. The rows that left the branch stay **above** it as a **shadow** for one turn:
`.input-row-abandoned`, muted ink, regular weight, no action, and a visually hidden "Left behind
by the rewind." Above is what makes the grey mean *abandoned* rather than *old*: newest first puts
the turns a rewind threw away at the top, where the eye already is, with the row you rewound to
holding the line under them. The boundary and the shadow go as soon as the branch shows a message
the rewind didn't know about, which is the next send. Until then the user can still see what they
took back.

**Any successful rewind refreshes the list once, whoever started it** — a row, the flyout's Undo
last turn, anything later. The chat tells the app each time the server says `rewound`; the app
mints a counter and hands it to the pane for that session path only, and the pane re-reads its
rows and draws the boundary and the shadow. A rewind in one session never refreshes another's.
**A refusal refreshes nothing and changes nothing**: the list is still true, so the rows stay as
they are and only the note under the row appears. Without this the tab went stale after a flyout
undo — it kept offering Rewind on messages that had already left the branch, and the click came
back "That input is not on this chat's current branch anymore."

The two halves of that are independent on purpose. The notification the chat raises carries the
session path and the message id, and **no text**: the chat has already filled the composer from
the server's own reply, and the pane rebuilds its boundary and shadow from the id alone. The app
routes on the path and mints the counter. Nothing downstream can drift out of sync with what the
composer shows, because nothing downstream holds a second copy of it.

A refusal is **announced as well as shown**. The inline note is easy to miss for a screen-reader
user who just heard "Rewound.", so the polite region (§3) gets the refusal's own words; otherwise
it keeps reading the last success while the screen says the opposite. **The chat owns the
announcement** — every refusal, whether the row asked for it, the flyout did, or the chat turned
it down without asking the server — and the tab owns the note on the row. One owner, because two
code paths saying the same sentence is how the live region ends up reading it twice.

## Accessibility

- **The list** is `aria-label="Your messages"`; each row's body button reads "Jump to this
  message: {preview}", so its name says what it does, not just what it contains.
- **Rewind** is never hidden when it can't act: it stays in the row, `aria-disabled`, with the
  reason in its `title` and on `aria-describedby`, so it reads out with the button.
- **A refusal** shows inline under the row *and* goes to the polite region, once, from the chat
  (above). Nothing else in the tab announces.
- **Focus follows the step**: into Rewind Here when a row arms, back to Rewind when it cancels,
  and onto the boundary note when the rewind lands — which is also how a screen-reader user hears
  where the branch now ends.
- **Esc** cancels an armed row without closing the pane; the pane's own Esc still closes it when
  nothing is armed.
- **The abandoned rows** carry a visually hidden "Left behind by the rewind.", because muted ink
  and a missing button say nothing out loud.
- **The triggers** are covered above: one `aria-controls` id, per-tab `aria-expanded`, and a
  reference that dangles only while the pane is closed.

## What the server does

`{type:"rewind", id, entryId}` over the chat socket. The server runs the same guards as every
other write (TUI-live, foreign writer), refuses while streaming or compacting, and refuses an id
that isn't a user message on the active branch. Then it calls the SDK's
`navigateTree(entryId, {summarize:false})`, which moves the tip to that message's parent. On its
own that only moves an in-memory pointer, and pi reopens a file at its last line, so a reload or
restart would quietly put the abandoned turns back. So the server appends one invisible `custom`
entry, `customType: "pi-web-rewind"` (`data: {targetId, fromLeafId}`), on the new tip. It's
extension state: never model context, no row in either transcript, no usage. Then every client
of the chat gets a fresh `hello`, the workers snapshot and the chat's `mode`, and the requester
gets `rewound` with the text. Refusals come back as `rewind_refused`, never as a thread error.

## Rejected

- **A modal confirm.** It takes the user off the row they chose; the inline step keeps the
  choice and its consequence in one place.
- **Auto-aborting a running turn.** See above.
- **Showing every branch.** A tree picker is the TUI's `/tree`. Here, the branch you're on is
  the only one you can act on.
- **Summarizing the abandoned branch.** It costs a model call per rewind, and the file keeps the
  turns anyway.
- **Oldest first, like the transcript.** It reads naturally and it was the first cut, but it puts
  the message you almost always want — the last one you sent — at the far end of a long list. The
  rewind maths still works oldest-first underneath; only the render is reversed.
