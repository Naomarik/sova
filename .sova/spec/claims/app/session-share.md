# §app/session-share — Session share links: a whole session, read-only, one link per recipient
> Part of the Sova design spec · [overview](../design/overview.md)

The operator can share a whole session, or a slice of it (§app.session-share/slice), read-only
with people outside the tailnet. A share has a
public title, a mode (a snapshot, or Follow live), an expiry, and one link per recipient: a named
recipient (the operator's private label, such as "Ana") or the optional "Anyone with the link"
row. The recipient opens a phone-first page on the share listener (§app.baton/share-listener) that
shows the conversation only. The operator sees who opened each link, when, on what kind of device,
and who is viewing now. The host that holds the session file mints and serves its shares; the
gateway only routes by hash (§mesh/public). Wire shapes: `shared/session-share.ts`. Copy:
§design.copy-deck/session-share.

## §app.session-share/link — Links: shape, store, expiry, revoke

- **Shape.** `/s/<token>` on the share listener's public address, built like a hand-off link
  (§app.baton/links): 32 random bytes in base64url; the store keeps its SHA-256, compared in
  constant time, and the token itself is kept beside it (Kept tokens, below); logs show at most 6
  characters. Each recipient has its own link; a recipient's
  label is never shown to any viewer.
- **Store.** `<stateRoot>/session-shares.json`, mode 0600, written atomically, host-local, never
  synced or committed: `{version: 1, shares: [{id: "ss_…", sessionId, sessionPath, title, mode,
  cut: {entryId, at} | null, from?: {entryId, at}, createdAt, stoppedAt?}], links: [{hash, shareId, recipientId: "r_…",
  label, anyone?, createdAt, expiresAt, revokedAt?, revokedWhy?}]}`. A file that fails the strict
  parse serves no link and is never overwritten.
- **Kept tokens.** Every link this host mints, a session share's `/s/`, a hand-off's `/h/`
  (§app.baton/links) and an owner's `/i/` (§app.owner-page/link) alike, keeps its token in one
  shared file, `<stateRoot>/link-tokens.json` (mode 0600, written atomically, host-local, never
  synced or committed): `{version: 1, tokens: {<hash>: {kind: "s" | "h" | "i", token}}}`. It is
  read tolerantly: a file that can't be read keeps no token and every link still opens, and an
  entry counts only when its token is well formed and its SHA-256 is the entry's key. A token is
  kept from its mint on and dropped when its link is turned off (deleted, relinked or replaced,
  stopped, archived, its person gone or its owner changed), never when it merely expires (an
  Extend can open it again). The link stores' own files and keys never change, so an older Sova
  still reads them. A link made before tokens were kept has none: it carries no link and shows no
  Copy Link, with no line about why.
- **Copyable.** Every operator answer that describes a live link whose token is kept carries its
  URL as `link`, built on the current public address when it answers: each recipient of a
  `SessionShare` (`GET /api/session-shares`, the share in every act's answer, and
  `/api/shares-overview`), each org link row of `/api/shares-overview`, the person page's hand-off
  and owner link rows, the owner card's `ownerPage.link.url`, and the strip's `BatonInfo.links`. An
  expired, turned-off or older link carries none.
- **Expiry.** 1, 7, 30 or 90 days, 30 by default, absolute. Extend sets every live link of the share
  to expire that many days from now. An expired link that was not turned off opens again with it
  only while the limits below still hold, newest first; one that would be a second Anyone row, a
  name twice or a 21st live link stays expired.
- **Recipients.** One to 20 live links per share: named labels (at most 60 characters, no two live
  alike) and at most one live "Anyone with the link" row, which is just another recipient with a
  fixed label. Every write keeps these limits: create, add, relink (refused whole, with nothing
  written, when the recipient's new link wouldn't fit beside the others) and extend.
  A recipient can be added later, relinked (a new token; the old one stops at once, and its open
  pages close before any wait on the gateway for the new one) or turned off. Stop sharing turns
  every link of the share off.
- **Dead links.** A revoked, relinked, stopped or expired link, or one whose session file is gone,
  whose cut entry is no longer in it, or whose start is no longer on its branch
  (§app.session-share/slice), answers 410 `{error, code: "gone"}` (`why: "expired"` only
  when it expired) with no title or name; an unknown token answers 404 `{code: "not-found"}`.
  Open pages of a link that dies are closed with 4410; a socket is admitted only where the view
  would answer, and a 30-second sweep closes pages whose link expired or whose share no longer
  reads. Archiving a session stops its shares.
- **Nothing after narrowing.** A view, image or pushed view is sent only while the token still
  opens and the share's source (mode, cut, start, title, stopped) is the one it was built from, judged
  after the build: a revoke, stop or switch to a snapshot during a read or a live rebuild sends
  nothing from it, and of two rebuilds only the newest is pushed.
- **Registry.** Live links are registered with the gateway as kind `s` rows (§mesh.public/registry)
  on every mint, relink, revoke, stop and extend; a mint waits for the gateway's answer as other
  links do, and returns each new link with the share's `linkWarning`. A mint of several links is
  confirmed only when each of them was sent and accepted.
- **Operator routes** are the operator API, as listed in `shared/session-share.ts`: the main
  listener, and a verified peer through the pane's host scope (a peer's sessions are shared by the
  peer). The share listener never has them. Their answers carry the kept links (Copyable, above),
  so a peer granted `sessions` (§mesh.peers/grants) reads working links; there is no other route
  for them.

## §app.session-share/snapshot — Snapshot by default, Follow live per share

- A **snapshot** share stores only a cut: the entry the operator's Preview was built at (the
  preview names it, and the mint must pass it back; a cut no longer in the file is refused as a
  stale preview), and its time. What is minted is exactly what was previewed, images included,
  whatever the session wrote meanwhile. Its view is the branch from the root to the cut, rebuilt and filtered on each read, so it
  stays the same after later messages, rewinds or branches. **Update to now** moves the cut to a
  previewed cut when one is given, else the current leaf, keeps a slice's start (refused as a stale
  preview when the new branch no longer holds it), and pushes the new view to open pages.
- **Follow live** (`mode: "live"`) has no cut: the view is the session's current branch (from its
  start, for a slice with one; a slice with an end is always a snapshot). While a
  live share has an open page, the minting host watches the session file (TUI-owned sessions
  included) and, debounced, pushes the refiltered view when whole entries were appended; it never
  streams a reply as it is written.
- The mode can be switched afterwards; switching Follow live off sets the cut to the current leaf.

## §app.session-share/content — What a recipient sees

- The page shows the public title, "Shared {date} · read only" and the conversation: each user
  message's text and each assistant reply's text as markdown, with its `vis` drawings, and the
  images embedded in those messages. The newest 200 items come first; Show earlier reads the page
  before them. No composer, no names, no recipient label. A sliced share shows only its slice
  (§app.session-share/slice), with `earlier` set when it starts after a shown message.
- **Size.** Only the first 1 MB (1,048,576 characters) of a message's text is read at all. After
  every scrub, an item's text is at most 256 KB (262,144 characters), ending in "…" when cut.
  Both cuts step back to the last token boundary (whitespace, a quote, a bracket or a
  separator), so no cut leaves part of a path, a generated name or a secret. Building a view
  takes time linear in the session's size: no text, however it is shaped, makes a read slow.
- **Images** are the image blocks embedded in the shown messages of the session file, never a file
  named by a path. Each is served by `GET /api/s/<token>/img/<n>` (its index in the view), only
  png, jpeg, webp or gif, at most 10 MB, with the same routing as the view. Images are shared as
  they are: the redactor can't read them, so Preview shows them before any link is minted.

## §app.session-share/never — Never on a session share

- Never sent to a recipient: thinking, tool calls, tool results and their output, the system
  prompt and `role: "system"` entries, usage, model ids, the session id, its path or cwd, the host
  name, costs, subagent transcripts and reports, every custom entry and card, clipboard or
  attachment paths, recipient labels, and entry ids (the operator's outline alone carries them). The view is built field by field on the server; no
  transcript row is passed along whole. What is excluded are the records and fields themselves: an
  assistant reply that quotes a tool's output, or any other private value, is still reply text,
  and only the redactor's known secrets and patterns are taken out of it; Preview and the Follow
  live consent are what cover the rest.
- Every string passes the server redactor (known secret values, then secret patterns) before it
  leaves the host. In the conversation's text, the session's cwd becomes relative and the home
  directory `~`. Wake nudges and link partners' messages are not the user's words and are left
  out. An image path (/tmp, an attachments folder, a generated paste name) leaves the text
  wherever it stands, prose, inline code, a fence or a vis drawing's source alike: removed when
  it is a word of its own, `[image]` otherwise; ordinary code stays as written. A preview link
  this host keeps (§app.project-overseer/previews), in the title or any message, a person's own
  words included, becomes "[preview link]" before any text is cut, and every view, outline and
  socket frame passes that filter whole. Likewise a link of this host whose token is kept
  (§app.session-share/link: `/s/`, `/h/` or `/i/`), in the title or any message, becomes
  "[share link]" before any text is cut, in every session share's view, outline and socket frame.
  Hand-off pages are never filtered this way: a person holding a hand-off sees every link as
  written. A time goes out only as a canonical ISO time
  re-written from a whole ISO 8601 entry time; any other value is left out.
- The branch is chosen strictly: the cut's path to the root, or, with no cut, the path from the
  file's last entry that has an id. An id-less record is ignored, never read as a reason to show
  every branch. Two entries with one id, a missing parent or a cycle make the share read as gone.
  Only a file whose entries have no ids at all and whose header is older than version 2 is read
  as one linear list.
- A privacy test plants a distinct marker in every excluded field, checks it is in the session
  file and, for every field the operator's transcript shows, there too, and checks it is absent
  from every `/api/s` answer, the page shell, the image route and the socket frames. Its markers
  include image paths in code, fences and vis source, marker-bearing and invalid entry times, and
  an abandoned branch next to an id-less record in Follow live. For a slice it plants text, an
  image and a vis source before the start and after a snapshot's end, and checks that none of them
  and no entry id reach any answer, any image index up to the whole session's count, or a frame,
  in either mode, and that a rewind above a live slice's start makes its link read as gone. A kept
  link planted in a shared session reads "[share link]" in its view, preview and outline (a frame
  carries the same view), and as written on a hand-off page.

## §app.session-share/rejected — Rejected shapes

- Serving shares from the main listener: outsiders never reach it (§app.baton/rejected).
- Reusing the `/h/` family or kind `h`: a separate `/s/` family and kind `s`, gated by the
  gateway's advertised kinds, instead.
- Sending transcript rows and filtering on the client, copying content to the gateway, storing a
  frozen copy of the view, token streaming to viewers, and viewer replies.
- A `token` key in `session-shares.json`: an older Sova parses that file strictly and would serve
  no link after a rollback; tokens are kept in `link-tokens.json` instead.
- A separate admin-gated route that reads links, held in a client cache: a link rides on the row
  it belongs to, so a copy can never drift from the state shown beside it.

## §app.session-share/page — The share page

- `/s/<token>` is the share build's session page (`src/share/SessionShareApp.tsx`): one column,
  phone first, like the hand-off page. The head is the public title and "Shared {date} · read
  only"; a snapshot adds "up to {date and time}" (its `through`), and a Follow live share carries
  a `Live` chip. User messages are right-hand bubbles and each reply takes the column's width
  (§app.session-share/reading); neither is labelled with a name.
- **Drawings.** A reply's `vis` fences draw as on the hand-off page (§app.baton/outsider-view),
  plus `sequence` and `state`. `svg` draws as an image, which runs no script and fetches nothing;
  `code` and `html` show as their source, escaped, under a caption. Any other kind, or one that
  doesn't parse, is the one quiet line.
- **Images** are thumbnails under their message's text, at most 320 by 240 pixels, each a link that
  opens the full image in a new tab.
- The page reads the newest page first, from the top; **Show Earlier** reads the page before and
  keeps the reader's place. A `view` push replaces the newest page and keeps the earlier pages
  already read; a reader at the bottom stays at the bottom. A push with `reset` (its lineage changed)
  replaces the whole view, earlier pages included, and so does any view (a push or a read)
  of another `lineage` (§app.session-share/slice); a Show Earlier answer of another lineage is
  dropped and the newest page is read again. Reads act in order: a read overtaken by a push, or by
  a newest-page read begun after it, is dropped whole when it answers, its view and its gone, busy
  or offline state alike, so a late answer never brings back an older, wider view.
- **A slice that starts partway** (`earlier`) shows one quiet line above its first item, once no
  earlier page remains: "Earlier messages aren't part of this share.", with no count.
- The page opens `/ws/s?token=&v=` and sends only `{t: "vis", on}` on open and on each
  visibilitychange. A `gone` frame or a 4410 close shows the dead page ("This link has expired."
  only when it expired); an unknown token shows "This link doesn't open a shared session.". A
  public gateway's 503 or a 4503 close keeps what the page shows, says it is offline, and reads
  and reconnects, backing off from 5 to 60 seconds (§mesh.public/offline).

## §app.session-share/reading — How a reply reads

- A reply's markdown reads as the chat's does, a step under the page, on every share page (`/s/`,
  `/h/` and `/i/`): headings are never larger than the page title — `#` at heading-m, `##` at
  heading-s, `###` to `######` at body size, all semibold — with space above and below.
  Paragraphs, lists, quotes, tables and drawings share one block gap; list items keep a small gap
  between them, and a nested list sits just under its item.
- **Tables** are ruled: one border round the table, a rule under each row, a sunken header row, and
  cells aligned left (a column marked right or centre keeps it) whose text wraps. A table wider
  than the column scrolls inside itself; at 390px the page never scrolls sideways.
- **Quotes** carry a left rule and read in secondary ink. Bold text, and a table's header, is
  semibold.
- **Width.** A reply card takes the column's width; user bubbles stay narrow, on the right.

## §app.session-share/sheet — Sharing in Session detail, and the Share sheet

- **Sharing section.** Session detail's Sharing tab holds the Sharing section
  (§app.subagents-pane/tabs). It lists the session's shares, newest first: each share's public
  title, its slice line for a sliced share ("Messages 12–18 of 40", "Message 3 of 9", "From
  message 12 · follows live", from its `span`) or else its mode line ("Snapshot up to {time}" or
  "Follows live"), and its recipients, each with
  a presence word when a page is open ("Viewing now", "Open in a tab") and "Opened {n}× · last
  {time}" or "Not opened yet". A stopped share says "Stopped". Each share has **Manage**; the
  section has **Share Session** (a link to the share page, §app.session-share/share-page) and a
  link to `#/shares`. None: "Not shared with anyone."
- **The Share sheet** is a dialog that becomes a sheet at folded width, and only manages a share:
  shares are created on the share page, whose create form holds:
  the public title (the session's title, editable, at most 120 characters, with a hint that the
  session's own title may say more than you mean); the people, one label each (Enter or **Add**;
  each removable; at most 20 links in all, no two alike); an **Anyone with the link** switch, off by
  default; a **Follow live** switch, off by default (a snapshot), whose hint says which one it is;
  and the expiry (1 day, 7 days, 30 days or 90 days; 30 by default).
- **Images before any link.** The create form reads the preview (the same builder, no token) when it
  opens; the preview is fixed at its `cut`, and its later pages and images are read at that cut.
  When the session shares images, it shows every one of them as thumbnails, loaded at once (never
  lazily), with "Images are shared as they are: nothing in them is hidden." **Create Links** stays
  disabled until the preview has loaded and every thumbnail has loaded; one that fails, or hasn't
  loaded after 10 seconds, shows **Retry Images**. **Preview Again** reads the conversation as it
  is now. **Preview** shows the whole thread exactly as the share page draws it.
- **A snapshot is the preview.** Create sends the preview's `cut`, so a snapshot holds exactly what
  the sheet showed, never what the session added after; Follow live sends none. When the cut is
  no longer in the session file (409 `stale-preview`), nothing is minted: the sheet says "The
  session changed. Preview it again." beside the preview and reads it again, to be reviewed again.
- **Create Links** (`Create Link` for one) mints them and shows each new link with its label and
  **Copy Link**; the `linkWarning`, when there is one, shows with **Open Settings** (§app.baton/links).
- **Managing a share** opens the sheet on it: its slice line (or "The whole session.") with
  **Change Slice** (the share page on this share; the sheet closes; not on a stopped share), the title (Save Title), the
  Follow live switch,
  **Update to Now** on a snapshot (both it and switching Follow live off first show the
  conversation as it is now, images loaded as above, and then stop at that preview's cut:
  **Update to This** / **Stop Following Here**, with the same stale-preview handling; Back
  changes nothing), each recipient's
  row (presence, opened line, expiry, its visits folded underneath, **Copy Link** while it is live
  and its link is kept, **Get New Link**, and **Delete Link** asked twice, its confirm and the line under it saying the link stops working for good,
  §design.copy-deck/session-share), **Add Person**, **Add Anyone Link** while it has no live anyone row, **Extend**
  with the four expiry choices, **Preview**, and **Stop Sharing** asked twice. A new link from Get
  New Link or Add shows as Create's do, and its row takes the answer's share. A Get New Link or Delete Link that fails says the server's
  reason on that recipient's own row, brought into view; a share-level action's failure is the
  sheet's banner. A turned-off row has no Get New Link: the person is added again instead. While
  open it reads the share's activity every 5 seconds while the page is visible.
- **Copy Link copies the row's own link**, the `link` of the recipient row it sits on, never one
  remembered elsewhere, so it always belongs to the state and times shown beside it. Each
  activity row carries its recipient's newest link's `createdAt` and its state (`live`, `off`,
  `expired`); when either differs from the row's, that row hides Copy Link and the sheet reads the
  share again at once, so a link replaced, deleted or stopped from another tab or host is never
  copied and the change shows within one read.
- A share on a peer's session is read and changed on that peer, through the pane's host scope.

## §app.session-share/shares-page — The Shares page

- `#/shares` is a main-pane page, entered from the overview's **Shares** card
  (§chat.transcript/landing-page) and from each Sharing section; the sidebar foot, its phone sheet
  and the spine have no entry to it. At folded
  width it uses `data-view="session"` and shows `.app-back`.
- It lists every live public link this host and each up peer serve: **Session shares** first (the
  shares with a live link, then the stopped and expired ones folded under "Ended"), then
  **Organization links** (every live hand-off `/h/` and owner `/i/` link, from
  `GET /api/shares-overview` on each host), then **Preview links** (this host's live previews,
  §mesh.public/preview-card; the people a preview was sent to on WhatsApp are on its **Sent to**
  line, and a person's own copy whose original isn't listed says "sent to {name}" before its
  expiry). With the mesh on, each row names its host.
- A session share row: its public title (a link to the session), its slice line or mode line (as
  the Sharing section), its recipients
  with presence and opened lines (each live one whose link is kept with **Copy Link**), and **Manage** (the Share sheet on it) and **Stop Sharing**
  asked twice.
- An org link row: the person, the organization, the hand-off's title and number or "Owner page",
  its state, "Expires in {n} days", the presence word, the opened line, its visits folded
  underneath, **Copy Link** when its link is kept, and **Delete Link** asked twice, its confirm and the line under it saying the link
  stops working for good (the existing hand-off or owner revoke route). The
  page never changes those stores otherwise.
- A visit's line adds what §mesh.public/visitor-log recorded for it, when anything: the address,
  the browser family (the raw user agent on hover), the language and, for a preview, "{n} pages"
  (the paths on hover). A session share recipient and a preview recipient with visits have their
  own **Visits** disclosure, and so has a preview row.
- It reads every host again every 5 seconds while the page is visible, and not while hidden. A
  host that doesn't answer is one line: "{host} can't be reached, so its links aren't listed.".
  None anywhere: "No public links are open. Share a session from its Sharing tab: Session details,
  then Sharing."

## §app.session-share/visits — Who opened each link

- Each recipient's link keeps a visit log under the rules of §app.baton/visits: a visit starts at
  the page's first `GET /api/s/<token>` that answers 200, continues by the tab's `?v=` or within
  10 minutes from the same device family, records a device family (never the address, the raw
  user agent, the token or its hash), marks scanners and scripts `bot`, records a known link
  previewer's shell fetch as a preview and a dead link's read as a refusal, caps new lines at 20 a
  link a day, and writes `seen` lines every 5 minutes, when a socket closes and at shutdown. A
  socket never starts a visit. While the host's **Log visitors** switch is on, each visit's
  address, raw user agent and language go to the host-local side file of §mesh.public/visitor-log,
  keyed by the visit's id, never to this log.
- The log is host-local: `<stateRoot>/session-share-visits.jsonl`, mode 0600, never synced or
  committed. Each line carries `via: "session"`, `shareId` and `recipientId`, and no person.
- A recipient's row counts its visits by a person (`opened`; previews, scanners and refusals not
  counted) and shows the newest one's last activity (`lastAt`). The "Anyone with the link" row's
  visits are told apart only by device family.

## §app.session-share/presence — Who is viewing now

- Presence is kept in memory on the minting host, which every `/ws/s` socket reaches, through the
  gateway or not (§mesh.public/routing); nothing about it is written down.
- A link holds up to 4 open sockets; a fifth closes the oldest (4000, "Opened elsewhere").
- The page sends one kind of frame, `{"t": "vis", "on": true|false}`, when its visibility
  changes. A frame over 1 KB closes the socket with 1009, and any other frame (binary, another
  shape, extra keys) with 1003.
- A recipient is **viewing** while a socket of theirs is open and visible (a new socket counts as
  visible until it says otherwise), **open** while one is open but hidden, and **away**
  otherwise.
- When a link dies (turned off, relinked, expired, the share stopped, the session gone) its open
  pages get `{type: "error", code: "gone"}` (`why: "expired"` only when it expired) and close with
  4410; a 30-second sweep catches expiry, and a share that no longer reads (a live slice whose
  start left the branch included). Update to now, a mode switch, a slice change and a live share's
  growth push `{type: "view"}` to every open page of the share (`reset: true` when its lineage
  changed, §app.session-share/slice).

## §app.session-share/overview — The Shares page's data

- `GET /api/shares-overview` answers this host's public links only (the page fans out to up
  peers): its session shares, with each recipient's presence and visit counts, and its **org
  links**, meaning every live hand-off (`/h/`) and owner (`/i/`) link of every attached org, newest
  first. Each org link carries its org, its person's name, a hand-off's session id, public title,
  number and baton state (an owner link's state is "live"), its creation and expiry, its `link` when
  its token is kept (§app.session-share/link), and its own visits from the org's visit log (§app.baton/visits), with `opened` and `lastAt` counted as for a
  recipient. A hand-off link whose page has an open socket is `viewing` (hand-off pages send no
  visibility); an owner link, which has no socket, carries no presence.
- Each session share recipient also carries its own `visits`, and the answer carries
  `previewVisits`, this host's preview visits by preview id (§mesh.public/visitor-log). A visit
  with lines in the host's identity side file carries them: `ip`, `ua`, `lang`, and for a preview
  its `pages` (paths) and `referer`. Only this answer carries them; the preview list
  (`GET /api/previews`) and the project overseer's tools never do.
- It only reads the hand-off and owner link stores, the kept tokens and the visit logs, and never
  writes them. An
  org whose workspace can't be read is left out. A turned-off or expired link is not listed.

## §app.session-share/slice — A share of part of a session

- **Start and end.** A share may start partway: the store keeps an optional `from: {entryId, at}`
  beside its `cut`, and the cut is the end. `from` absent or null means from the first message.
  Both are entry ids, never item numbers: an entry id on the root → cut path never moves.
- **The builder slices first.** The view is the strict branch (root → cut, or the current branch
  in Follow live) cut down to its suffix that starts at `from`, before anything is built. So item
  numbers, image indices and pages are the slice's own: item 0 and image 0 are the slice's first,
  and no answer, image route or pushed view reaches an entry before `from` or after the cut.
- **A start no longer on the branch** (a rewind above it, a branch that left it, a start after the
  cut) makes the share read as gone, the rule a cut that left the file already follows.
- **Follow live with a start.** A slice with only a start may Follow live ("from here on, keep
  following"); a slice with an end is always a snapshot. An end given to a share that follows live
  (on create, PATCH, Update to now or in the store) is refused with 400 `live-end` ("A share that follows live has
  no end. Turn Follow live off to end it."), never dropped, and the store's strict parse refuses a
  live record with a cut. A change of start, end or mode is written only if the share's mode, end
  and start are still the ones it was validated against; otherwise nothing is written (409
  `share-changed`, "This share changed meanwhile. Try again."). Update to now moves the end and keeps the
  start; when the new branch no longer holds the start it is refused as a stale preview ("The
  start of this share is no longer in the session.") and nothing changes.
- **Earlier messages.** When the slice drops a message the whole view would show, the view says
  `earlier: true`, with no count, excerpt or id, and the page shows one line above its first item:
  "Earlier messages aren't part of this share.". A dropped wake nudge or other left-out entry
  alone doesn't set it.
- **Narrowing resets open pages.** `from` is part of the share's source, so a read or live rebuild
  begun before the start moved sends nothing. Every recipient view carries a `lineage`: an opaque
  random id, kept only while each view extends the one built before it (same start, the last view's
  last entry still on the slice), so an item's number always names the same message within a
  lineage; a moved start, a rewind, or an end moved back or onto another branch starts a new one.
  A page replaces its whole view (earlier pages included) when a view of another lineage arrives,
  by push or by read, and drops an earlier page read in another lineage. A push whose lineage
  differs from the last one pushed also says `reset: true`, so a reset owed by an overtaken build
  is carried by the next one sent.
- **Entry ids are the operator's.** The operator's outline carries them to the share page; no
  recipient answer, image route, shell or frame ever carries one.
- **Span.** The operator's share rows carry `span: {first, last, total}` for a sliced share: 1-based
  positions among the messages the whole view would show (`last` null while it follows live), so
  lists can say "Messages 12–18 of 40". Whole-session shares carry none.

## §app.session-share/share-page — The operator's share page

- `#/share/<sessionId>[?host=<peer>][&share=<ss_id>][&from=<entryId>]` is a main-pane page (like
  `#/shares`: `data-view="session"` and `.app-back` at folded width), isolated in its own component
  (`src/components/SharePage.tsx`) over a pure slice model (`src/lib/share-slice.ts`). It is where
  shares are created; the Share sheet only manages them.
- **The outline.** The page reads `GET /api/session-shares/preview?session=<id>&outline=1`: one
  row per message the share would show, with its entry id, kind, time, a scrubbed excerpt of at
  most 160 characters and its image count, fixed at a `cut` like the preview. A host that answers
  without an outline can't slice, and the page says "This host needs an update to share part of a
  session." and never mints.
- **Two taps.** The list is one column of rows at least 44px tall (a role mark, the time and a
  two-line excerpt). The first tap marks the start, the second the end; a second tap above the
  start swaps them; tapping a boundary again clears it; a tap once both are set moves the nearer
  one. Until picked, the range is the whole session ("From the first message", "To the latest").
  Rows are buttons, so Enter and a mouse pick the same way. No row is marked until a boundary is
  picked; the list opens scrolled to the picked start (else the end).
- **The bar.** A sticky bottom bar says the range ("Messages 12–18 of 40", "Message 12 of 40", or
  "From message 12 · follows live") and holds **Preview** and **Next**. It offers one-tap hints and
  never moves a boundary by itself: "Starts with a reply. Include the question?" and "Ends with your
  question. Include the reply?".
- **Follow live** is offered only while the end is "To the latest"; picking an end turns it off.
  **Preview** shows the slice exactly as recipients will see it, the "Earlier messages…" line
  included. **Next** shows the create form (title, people, Anyone, Follow live, expiry, the images
  and Create Links, as §app.session-share/sheet describes them), sending `from` and the previewed
  `cut`; a start or cut no longer on the branch is 409 stale-preview and nothing is minted. The new
  links show on the page, with **Copy Link** and the `linkWarning`, and **Done** returns to the
  session.
- **Changing a slice.** With `&share=<id>` the page opens on that share's slice and Next becomes
  **Save Slice**: the same review step (the new slice's images load and gate it, as Create's do,
  since a later end can publish new images), then PATCH `from` and `cut`, with the same
  stale-preview handling; open pages start over with the new slice. Save Slice on a share that
  follows live with an end picked makes it a snapshot (`mode: "snapshot"` and the cut); Follow live
  is turned back on only in the Share sheet. Saved, the page says "Slice saved." and returns to the
  session. When the share changed meanwhile (409 `share-changed`), nothing is saved: the page reads
  the share again, keeps the picks, and says so ("This share changed meanwhile."), to be saved
  again. With
  `&from=<entryId>` the start is preselected and the list scrolls to it, waiting for the end tap.
- **Doors.** The session head's Share button, a message's **Share from here** action (with
  `&from=`), the Sharing tab's **Share Session** (with or without shares), and a share's **Change
  Slice** (with `&share=`). #/shares' empty state points the way there ("Share a session from its
  Sharing tab").
