# §chat/transcript-cards — Transcript cards
> Part of the Sova design spec · [overview](../design/overview.md)

A **transcript card** is anything Sova draws in a chat's transcript as a card: Sova's own (an
alignment, an offer, a tour, a settings change…) and the ones a project or an installed extension
declares. Every card type, Sova's own included, is drawn through one **card toolkit**: a named type
with a fixed place, a height reserved before it draws, and an error box of its own. A project or
extension card is either one of the common cards Sova draws from data (a question, a checklist, a
status, a table, buttons) or its author's own view, run in a sealed box. A chat's agent raises
cards during its reply; scripts, project hooks and extensions raise them at any time through
Sova's catalogue. A user answers a card by acting at once or by picks that go with the next
message, and the agent learns the answer on its next turn.

Owns: the toolkit and its card types, placement, the data cards and data checks, project card
files, the sealed box and the view API, trusting a project's or extension's cards, answering,
raising cards (the `card` tool and the catalogue commands), redraw on save, how Sova builds project
views, the toolkit version, project and extension drawing kinds, and Sova's own cards on the
toolkit. Not here: an extension's manifest keys for cards and drawings (§app.extensions/views),
what each of Sova's own cards shows and does (its own claim: §chat.alignment/card,
§chat.offers/card and the others), the composer (§chat/composer: the message box gets nothing
from this feature but staged text and picks), and the reply place under a message
(§app.commands/reply-place, unchanged).

## §chat.transcript-cards/toolkit — One toolkit for every card type

- **One list of card types.** Every row the transcript draws, a card or any other, is drawn by
  looking its type up in one list; no row is drawn by a path of its own. A type has a name, what it
  draws (one of Sova's data cards, a Sova-built view, or its author's own view), the shape of the
  data it accepts, how it is answered (§chat.transcript-cards/answering) and where it stands
  (§chat.transcript-cards/placement).
- **The running turn too.** A turn in progress draws through the same list: each type that can
  appear while a reply streams has a live form, which draws the same view the settled row will
  draw. Whether a tool call stands in the turn's Work run or breaks it is its type's say, one rule
  for the running turn and the settled transcript (§chat.transcript/work-chain), so no card joins
  or leaves the run when the turn settles.
- **Names never clash.** Sova's own types have plain names (`align`, `offer`, `tour`…). A
  project's are `project.<name>` and an extension's `<extension id>.<name>`, so no project or
  extension type can replace, change or pass for one of Sova's, and two owners never share a name.
  A name is lowercase letters, digits and hyphens after the owner, starting with a letter, at most
  32 characters.
- **A reserved height.** Before a card draws, its row holds the height its type estimates for it
  (worked out from the data for a data card; the type's declared `height` for a view; Sova's own
  as before, §chat.transcript/rendering), so a card that loads late or off screen never moves what
  the reader is looking at. A view that has drawn once keeps its drawn height while it is drawn
  again (a redraw on save, a Reload).
- **Its own error box.** Each card is walled off from the rest of the transcript: a card whose
  data doesn't fit its type, whose view fails to build or load, throws while drawing, or was built
  for another toolkit version, draws one error box in its own place, in the error colour, saying
  what went wrong ("This card couldn't be drawn: {why}."), with **Reload**. Every other row, card
  and the composer go on as if nothing happened. Reload tries that card again; it never reloads
  the page or the chat.
- **The same host for every card.** Sova's own types and every declared type draw through the same
  host: the reserved height, the error box with Reload, and for every data card and view the data
  check before it draws.

## §chat.transcript-cards/placement — Where a card stands

Each card type declares its placement:

- **Anchored** (the default): the card stands where it was raised. One the chat's agent raises
  stands where its tool call is, among the turn's steps, as soon as the call returns; one raised
  from outside (§chat.transcript-cards/raise-command) stands after what was the transcript's last
  row when it was raised (by its time, when that row isn't among the rows on screen), and stays
  there as the chat goes on.
- **Follow**: the card follows the chat the way an alignment card does (§chat.alignment/card). A
  follow card carries a **key**, given when it is raised; raising a card of the same type with the
  same key in the session later is a new **revision** of it. Each revision stands where it was
  raised, by the rule above, and never moves. The **newest revision of each key** is the full card;
  every earlier revision of it collapses to one line (its title and "revision {n}"), which opens to
  show that revision in place, read-only (a view's earlier revision says it is one). An open
  earlier revision is closed by the newer one: only the newest takes an answer. So the next reply
  always appears under the newest copy.
- No card is ever pinned at the bottom of the chat or above the live reply, and a placement never
  makes one card cover another or the composer. A revision that appears, and an older one that
  collapses, keep the reader's view where it is (§chat.transcript/rendering).

## §chat.transcript-cards/data-cards — The cards Sova draws from data

A type may draw one of Sova's five **data cards**. Sova draws them itself, in the page, with its
own components and its design: the author writes only data.

- **Question**: a title, an ask, an optional context line, 2 to 8 options lettered a, b, c… (each
  a label and an optional trade-off line; no two labels alike), and an optional recommendation
  naming one option by its letter with a why. It looks and picks exactly like a question on an
  alignment card (§chat.alignment/card: the letter column, the recommendation line "Recommended b —
  {label}", the whole option row as the target), because it is drawn by the same code.
- **Checklist**: a title and 1 to 50 items, each a line of text and whether it is done, the text
  beside its box (a wrapped item keeps its text column). Answerable types let the user tick items;
  others show the ticks as data.
- **Status**: a title, a tone (`ok`, `warn`, `error`, `info`, `muted`, as the reply chips', with
  the dot and the word: OK, Warning, Error, Info, Note) and one line, with an optional detail line.
- **Table**: an optional title, 1 to 12 column heads and up to 200 rows of plain-text cells; past
  10 rows it shows the first 10 and **Show All {n} Rows**.
- **Buttons**: a title, an optional note and 1 to 4 buttons, each a label (at most 32
  characters), an optional one-line `about` (its tooltip), and what a press does: answer the card
  with that button, send a text as the user, or run one catalogue command (as
  §chat.offers/buttons; a send, or a run of a command that changes something, needs the card's
  owner trusted, §chat.transcript-cards/trust). An optional `confirm` sentence asks first, as an
  offer card does. Once answered, the card keeps no buttons: only its answer line ("You chose
  {label}"), as Sova's own confirm cards. Until then, where it can't be answered, it reads
  "Waiting for an answer:" and its buttons' labels.

Text in a data card is plain text, with inline code and bold runs drawn as on an alignment card;
nothing else in it is markup.

- **Checked before it draws.** Every card's data is checked against its type's shape when it is
  raised, and a card that fails is never raised: the raiser gets "Nothing was raised:" and the
  first field that broke a rule, by its path (`options[2].label is longer than 120 characters`).
  A data card's shape is Sova's; a view's is the shape its type declares
  (§chat.transcript-cards/files). Data that reaches the browser and doesn't fit (a card stored
  before its type's shape changed) draws the card's error box naming the field, never half a
  card. A card's data is at most 64 KB.

## §chat.transcript-cards/files — A project's card files

- **Where.** A project's card types are folders `.sova/cards/<name>/` in the checkout the chat runs
  in, found the way project modes are (§chat.mode-menu/project-modes, "Which checkout"): a chat in
  a worktree uses its own branch's card files, and a chat with no local folder has none.
- **`card.json`** declares the type, strictly: `{"version": 1, "toolkit", "title", "when"?,
  "draws", "data"?, "answer"?, "placement"?, "height"?}`. `toolkit` is the toolkit version the
  type was made for (§chat.transcript-cards/versions). `draws` is one of the data cards
  (`question`, `checklist`, `status`, `table`, `buttons`) or `view`; `view` needs `view.tsx` in the
  same folder and `data`, the shape its data must have (a JSON Schema of types, properties,
  required fields, items, enums and string and array lengths; anything else in it is refused). A
  data card takes neither `data` nor `height`: its shape and size are Sova's. `answer` is `none`
  (the default), `at-once` or `gather`: a question or buttons card is always answered, a status or
  table card never. `placement` is `anchored` (the default) or `follow` (keyed revisions, the
  newest drawn in full where it was raised, §chat.transcript-cards/placement); `height` (32 to
  1200) is the view's reserved height in px. `when` (at most 200 characters) is when the agent may
  raise it; a type without `when` is raised only from outside
  (§chat.transcript-cards/raise-command).
- **Broken folders.** A folder whose name is bad, whose `card.json` is missing, over 64 KB, isn't
  JSON, has an unknown key or a bad value, or whose `view.tsx` is missing, is **broken**: it raises
  nothing. One broken folder never hides the others. At most 16 card types count; past them, the
  rest are broken.
- **The project's Cards section.** The project page's Settings tab has a **Cards** section, after
  Offers, read from the main checkout now: its card types by name, its drawing kinds
  (§chat.transcript-cards/drawing-kinds), each broken folder with its path, a Broken chip and what
  is wrong, and whether the project's cards are trusted (§chat.transcript-cards/trust). The
  catalogue's `project.cards.list` reads the same.
- **Fixed per chat.** The types a chat may raise, and their shapes, answer modes and placements,
  are snapshotted the first time Sova builds the chat's tools, as offers are (§chat.offers/tool,
  "One set per session"), in Sova's own state keyed by session id, never in the session's file:
  the project's types from that checkout, then the types the installed extensions declare
  (§app.extensions/views), each name once. A reload, a resume, a reconnect after a restart and a
  resumed Claude Code chat read that snapshot; a fork starts with its parent's; a session with no
  snapshot that already holds a user message records none. Editing, adding or removing a
  `card.json` never changes a running chat; new chats get the new set. Only a view's own code is
  redrawn on save (§chat.transcript-cards/redraw).

## §chat.transcript-cards/sealed-box — A view in a sealed box

A type that draws its author's own view (a project's `view.tsx`, an extension's view module) runs
in a **sealed box** in the card's place. Only Sova's own cards draw in the page itself.

- **In a card's frame.** A view card stands in the same card as a data card: a header with its
  title (the data's `title`, else the type's), and the box as its body; "From …" stands above it,
  as on a data card.
- **Walled off from Sova.** The box is two frames, a Sova shell holding the view's frame, both
  with scripts but an opaque origin of their own that is never Sova's: no Sova cookies, storage,
  token or key, no way to read or change the page around it, other cards or the composer, and no
  top navigation, popups, forms or downloads. A view that tries to navigate itself away goes
  nowhere: the shell stops it and its card's error box reads "This view tried to leave its box, so
  it was stopped." It reaches Sova only through the view API (§chat.transcript-cards/view-api):
  the page takes a message only from that card's own shell, and names the card itself.
- **Walled off from the network.** Its documents load only Sova's toolkit and the view's own built
  code, from Sova; every other request (fetch, sockets, images, fonts, styles or scripts from
  anywhere else, frames, workers) is refused by the box's content policy, which is also each
  frame's `csp` attribute, and the shell's policy refuses every navigation of the view's frame.
  WebRTC is gone from the view's document before its code runs, and only the view's own code ever
  runs there: a script, handler or `javascript:` link in a frame it makes never runs. Views run
  only in a browser that supports the frame's `csp` attribute (Chrome, Chromium, Edge and the rest
  of their family); anywhere else the card shows its error box, "This browser can't wall off card
  views, so this one isn't run."
- **Only its own card's data.** It receives the data its card was raised with (and later
  revisions of it), the card's answer, the state Sova keeps for it, and the session's id, title and
  whether this view can act on it, as plain JSON. Nothing else of the transcript or the draft.
- **Sova's look.** Its document starts with Sova's design tokens and base styles and the theme in
  use, on the card's own background, and follows a theme change at once, with no reload
  (§app.settings-dialog/themes). Its native controls (buttons, text fields, selects, checkboxes,
  radios and sliders) are drawn as Sova's, with Sova's focus ring. It loads no web fonts: its text
  is in the system's.
- **Sized to fit.** It holds its reserved height until it draws, then takes the height of what it
  draws (or asks for), from 32 to 1200 px; past that it scrolls inside. It never takes the
  keyboard focus on its own (focus taken without a press in it goes back where it was), and Tab
  moves into and out of it as through any card.
- **Only in its chat.** Where a transcript is drawn outside its own chat's pane (a live watch, the
  Overseer's chats, a shared page), a view card reads "{title}: this card's view draws in its
  chat."

## §chat.transcript-cards/view-api — What a view can do

A view in a sealed box works through one **view API**, by messages to the page, which answers for
that card only. Its types ship with the toolkit (`import { card, mount } from "sova:card"`,
§chat.transcript-cards/versions), the command ids and params generated from the catalogue.

- **Read** its card's data, answer, status and state, the session's id, title and whether it can
  act, and the theme; each is a Solid signal, told when it changes (a new revision of the data,
  an answer given in another tab, a theme switch).
- **Run Sova's commands**: every entry of the catalogue (§app.commands/catalogue), with the
  parameters the view gives, checked as the entry declares them (an unknown, missing or mistyped
  one is refused); a session parameter it leaves out is its card's own session. It is the same
  request the web app makes, answered with the route's own status and body, and recorded in the
  record of who ran what (§app.command-audit/list) with the card's type as the caller
  (`card:<type>`). Until the card's owner is trusted (§chat.transcript-cards/trust), **every**
  command is refused before any request is made, reads included (a read such as `session.read`
  would hand it the whole chat, or another by its session parameter): the card asks for trust, and
  Trust runs the command, Not Now refuses it. It runs only from this machine's own page: a script's
  token and the peer listener are refused.
- **Stage text into the draft**: put text at the end of the chat's draft in the composer, where
  the user sees and edits it before sending. It never sends. Refused in a view that can't act on
  the session.
- **Record an answer on its own card** (§chat.transcript-cards/answering), never on another card:
  one line of 1 to 200 characters, with an optional JSON value of at most 16 KB. An at-once card
  records it now; a gathering card stages it as a pick.
- **Keep state**: a small JSON value Sova keeps for this card (at most 64 KB), kept across a redraw
  on save, a reload of the page and a reopened chat; no other card can read it.
- **Size its box**: ask for a height (§chat.transcript-cards/sealed-box).
- Drawing, reading what it was given, staging text, recording its own answer, keeping state and
  sizing its box are its card's own and never need the user's OK. Anything else it asks is refused
  ("{call} is not something a view can ask.").

## §chat.transcript-cards/trust — Trusting a project's or an extension's cards

- **Once per project or extension.** The first time any card of a project (its project root, so
  every branch and worktree of it) or of an extension (its id) wants to act, the card asks. A data
  card's button acts when it sends a message or runs a command that changes something (a `looks`
  command runs untrusted); its ask reads "Let {name}'s cards act for you? They can then run any Sova
  command, such as sending messages or merging, without asking again." A view acts when it runs
  any command at all, reads included (§chat.transcript-cards/view-api); its ask reads "Let
  {name}'s cards use Sova's commands for you? They can then run any Sova command, such as reading
  your chats, sending messages or merging, without asking again." Both offer **Trust {name}'s
  Cards** and **Not Now**: Trust runs what was asked, Not Now runs nothing, and the card can ask
  again on its next try.
- **Then every command works.** Once trusted, every command any of that owner's cards runs works
  without another prompt, after edits and updates of its card files or views included. A
  project's trust never covers an extension's cards, nor the reverse.
- **Only the user grants it, in the page.** Trust is kept in Sova's own state
  (`<state root>/card-trust.json`), outside every repository, so no branch, clone, chat or card can
  trust itself. It is a trust grant: no catalogue command and no agent tool reaches it, and a
  caller with the token is refused. The project page's Cards section says whether its cards are
  trusted, and the extension's page says so while they are, each with **Stop Trusting Cards**
  while they are, which takes effect on the next command.
- Sova's own card types never ask.

## §chat.transcript-cards/answering — Answering a card

A type that takes an answer declares how:

- **At once** (`at-once`), like Land It: a pick (a lettered option, a button, a checklist tick
  that completes it, or a view's own answer) is recorded at once, with who answered (you, or the
  caller that answered through the catalogue) and when, and the card reads "You chose **b**: {label}"
  (or "{who} chose…"; a checklist "You answered **3 of 4 done**") with the time on hover, and the
  outcome of any send or run after it. The first answer claims the card; a second at the same
  moment does nothing, and an answered card takes no other answer.
- **Gather** (`gather`), like an alignment card: picks stay on the card, held per session in this
  browser like the draft, and show in the composer's staged answers row (§chat.composer/anatomy)
  until the next send. They go out with that message as one line per card, `{cd_N}: {answer}.`,
  and are recorded as the card's answer once the send succeeds. A refused send keeps them; Clear
  Picks drops them.
- **Needs you.** Either way, while an answerable card is open in a session it is a Needs you item
  (`card-waiting`, §app.overseer/attention-digest), idle or working, until it is answered or its
  raiser marks it done. It never sends a phone notification and never briefs the Overseer.
- **The agent learns at its next turn.** An answer given at once reaches the agent as one hidden
  note at the start of its next turn, naming the card, the answer and who gave it, with the outcome
  of any command it ran; a gathered answer is in the message itself.
- **Where it can be answered.** Only in a chat Sova holds and can act in. Where it can't (an
  archived chat, a live watch of a terminal session, a shared page, the Overseer's own chats) a
  card shows its answer and no controls; an open one reads "Waiting for an answer".
- Answers are kept in Sova's own state keyed by session id, never in the session's file.

## §chat.transcript-cards/card-tool — The agent raises a card

- **Who gets it.** An ordinary chat Sova runs, on pi or Claude Code alike, whose snapshot
  (§chat.transcript-cards/files) holds at least one type with a `when`, gets one tool, `card`.
  Never a worker, the Overseer, a project overseer or any other special chat, and never a codemode
  script's call. A chat with no such type gets no tool and no instructions: its tools and prompt
  are exactly what they were before.
- **What it takes.** `{type, data, key?}`: `type` one of the snapshot's names (an enum), `data`
  checked against that type's shape (§chat.transcript-cards/data-cards), and `key` (at most 64
  characters), which a `follow` type requires and no other type takes: the same key raises a new
  revision of that card (§chat.transcript-cards/placement). The tool's description is built
  only from each type's `when` and its data shape.
- **Each call.** Refused, raising nothing, when the session has an open alignment question, the
  type isn't one the agent may raise, the key is missing or not wanted, or the data doesn't fit;
  each refusal starts "Nothing was raised:" and says which. Otherwise the card is raised with an
  id `cd_N` and the call answers "Raised {cd_N} ({type})", with how its answer will reach the
  agent. The call never ends the agent's turn.

## §chat.transcript-cards/raise-command — Raising a card from outside

Scripts, a project mode's hooks (§chat.mode-menu/project-mode-hooks) and extensions raise cards
with catalogue commands (§app.commands/catalogue), at any time:

- `session.card.post` raises a card of a type in the target session's snapshot, with its data, or
  with `card` gives an open card a new revision of its data (an anchored card redraws in place,
  keeping its answer and picks) or marks it done. A `follow` type's card is raised with its `key`,
  and the same key raises its next revision where it is raised (§chat.transcript-cards/placement).
  The card says who raised it: "From {extension id}", "From {chat title}" or "From a script".
- `session.card.get` reads a session's cards, their data and their answers.
- `session.card.answer` records an answer on an open card, as a press on it would, recorded as
  given by its caller.
- **Only an ordinary chat**: a card is never raised into an archived session, a worker, the
  Overseer, a project overseer or a baton chat ("Nothing was raised: cards show only in ordinary
  chats.").
- **Never into a terminal session**: a session open in a terminal is refused with the catalogue's
  own words (§app.chat-actions/terminal-open), and a card is never written into its file.
- **Never over an alignment**: while the session has an open alignment question, raising is refused
  ("Nothing was raised: an alignment question is open."), and no card ever hides or replaces an
  alignment card. The same data and type rules as the tool apply.

## §chat.transcript-cards/redraw — Redrawn on save

- **Always on.** Saving a view's file (a project's `view.tsx` or a file it imports; an extension's
  built view module or a file beside it that it imports) redraws every card that uses it, in every
  open browser, within about a second, with no restart and no reload of the page or the chat. Each
  card keeps the data it was raised with, its answer, its picks and its state.
- **A broken save.** A view that no longer builds, fails to load or throws shows the card's error
  box with what is wrong (the file, line and column when known) and **Reload**; the rest of the
  chat is unaffected, and the next good save draws the card again on its own.
- **Only the view.** A type's declaration (`card.json`, an extension's manifest entry) is fixed per
  chat (§chat.transcript-cards/files); saving it changes no running chat. A view whose new code
  rejects the data its card was raised with shows the error box.

## §chat.transcript-cards/building — How Sova builds a view

- Sova builds a project's `view.tsx` itself when it is saved, with Sova's own fixed settings: Solid
  JSX, the toolkit (`sova:card`) and Sova's own `solid-js`, relative imports inside the checkout
  and packages the checkout itself has installed (its own `node_modules`, never one above it),
  bundled into one script of at most 4 MB within 30 seconds. Any other import (a URL, a `node:`
  module, a path outside the checkout, a package not installed) is a build error naming the file
  that asked for it. It never reads or runs the project's build config, Babel or TypeScript
  config, plugins, `package.json` scripts or install scripts, and runs nothing of the project's
  while building. A build error is the card's error box (§chat.transcript-cards/redraw). No path on
  this machine reaches the browser in what it builds.
- An extension's view module, built by the extension into its `dist`, is bundled the same way
  from there with Sova's toolkit and `solid-js` and the files beside it; a backend's key file is
  never one of them.
- What it builds runs only in the sealed box (§chat.transcript-cards/sealed-box), never in the
  page and never on the server.

## §chat.transcript-cards/versions — The toolkit version

- The toolkit has a version, today `1`; each type says which one it was made for (a project's
  `card.json` `toolkit`, an extension's card or drawing entry). Sova runs only views built for its
  current version.
- A view built for another version never runs and never half works: Sova doesn't build it, and its
  card's error box reads "This card needs updating for this Sova: it was built for toolkit v{n},
  and this Sova runs v{current}." Data cards, which Sova draws itself, never need updating,
  whatever version they name.

## §chat.transcript-cards/drawing-kinds — A project's or extension's own drawing kinds

Beside Sova's own `vis` kinds (§chat.markdown/visuals), a project or an extension may add kinds
of its own:

- **Declared.** A project: `.sova/drawings/<name>/kind.json` (`{"version": 1, "toolkit",
  "accepts": "text" | "data", "data"?, "height"?}`, checked as strictly as `card.json`) beside its
  `view.tsx` and a `GUIDE.md`, in the chat's own checkout; at most 8 count. An extension: its
  manifest's `drawings` (§app.extensions/views). A project's broken ones are listed in its Cards
  section as card folders are (§chat.transcript-cards/files).
- **Namespaced.** Its fence word is `<owner>.<name>` (`project.gantt`, `notes.mindmap`). It never
  replaces or changes one of Sova's kinds, which have no dot.
- **What it draws.** The fence's body, after an optional `title:` first line and `caption:` last
  line: as text (`accepts: text`) or as JSON checked against the kind's `data` shape
  (`accepts: data`). Its view runs in a sealed box like a card's, built and redrawn on save the
  same way and following the toolkit version, with Sova's figure around it (its title, or the kind
  as its eyebrow, Source, Copy, its caption). A drawing has no answer and runs no commands: the box
  may only size itself, and anything else it asks is refused ("A drawing only draws: it has no
  answer, stages nothing and runs no commands."). One that can't be drawn shows the error box,
  "This drawing couldn't be drawn: {why}.", with Reload.
- **The agent reads its guide.** While vis is on, the `vis_guide` tool lists the chat's own kinds,
  one line each, and returns, for one, how its fence is written and its `GUIDE.md`
  (§chat.markdown/visuals).
- **Fixed per chat.** The kinds a chat may draw, and their guides, are snapshotted with its card
  types (§chat.transcript-cards/files). A fence naming a kind outside the chat's snapshot is the
  ordinary vis error ("Couldn't draw this vis …"). Share and owner pages show it as the quiet line
  they show for any kind they don't draw.

## §chat.transcript-cards/built-ins — Sova's own cards on the toolkit

- Every row Sova itself draws in a transcript, settled or in the running turn, is a type on the
  toolkit: your messages, replies and thinking, tool calls and the cards they read as (the deck,
  confirm, link and profile cards), orphan tool results, the alignment card and the old alignment
  report, offer cards, tours, show changes, settings change cards, worktree merge cards, the
  Overseer's and team cards, reports, briefs, explanations, owner requests, hand-off runs, baton
  cards, and the info, topic, wake and compaction rows. None is drawn any other way; a tool result
  shown in its call's card is a type that draws nothing.
- **Nothing a user sees changes.** Each looks, reads aloud, takes the keyboard, lays out on a phone
  and scrolls exactly as before, and draws as fast; its own claim (§chat.alignment/card,
  §chat.offers/card and the others) holds unchanged. The one difference is that a running turn now
  draws as it will once settled: the same Work runs (§chat.transcript/work-chain) and the same box
  under a message of yours (§chat.transcript/message-actions), so nothing moves when the turn
  settles.
- **Nothing reserved but the page.** A project's or extension's card can do everything Sova's own
  can (answer at once or gather, follow the chat, stage text, run any command once trusted);
  only drawing in the page itself is Sova's alone.
