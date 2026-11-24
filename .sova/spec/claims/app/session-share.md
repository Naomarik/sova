# §app/session-share — Session share links: a whole session, read-only, one link per recipient
> Part of the Sova design spec · [overview](../design/overview.md)

The operator can share a whole session, or a slice of it (§app.session-share/slice), read-only
with people outside the tailnet. A share has a
public title, a mode (a snapshot, or Follow live), an expiry, and one link per recipient: a named
recipient (the operator's private label, such as "Ana") or the optional "Anyone with the link"
row. The recipient opens a phone-first page on the share listener (§app.baton/share-listener) that
shows the conversation only, with each of its Lookbooks' finished designs read only
(§app.session-share/lookbook). The operator sees who opened each link, when, on what kind of device,
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
  (§app.baton/links), an owner's `/i/` (§app.owner-page/link) and a reviewed tour's `/t/` (§app.tours/sharing) alike, keeps its token in one
  shared file, `<stateRoot>/link-tokens.json` (mode 0600, written atomically, host-local, never
  synced or committed): `{version: 1, tokens: {<hash>: {kind: "s" | "h" | "i" | "t", token}}}`. It is
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
  Neither serves a design, a design page or a design's own tab (§app.session-share/lookbook-serving).
  Open pages of a link that dies are closed with 4410; a socket is admitted only where the view
  would answer, and a 30-second sweep closes pages whose link expired or whose share no longer
  reads. Archiving a session stops its shares.
- **Nothing after narrowing.** A view, image, design page or pushed view is sent only while the token still
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
  streams a reply as it is written. Its Lookbooks follow too: a change to the chat's designs (a
  version landing, a removal, a restore), debounced per chat, rebuilds the view of each of its
  shares with an open page and pushes it only when its Lookbooks changed, so a page being written
  never pushes anything.
- **A snapshot's design cut** (§app.session-share/lookbook). Designs finish in their own sessions
  and add nothing to the chat's file, so a snapshot shows the versions finished by its own design
  cut: the moment of the operator's preview (`designsAt`), pinned like the cut (the first read
  takes now, later reads pass it back) and sent back by Create, Update to Now and Stop Following
  (absent: the server's now; one that isn't a whole ISO time, or is in the future, is refused as a
  bad preview). It is kept in a side file, `<stateRoot>/session-share-design-cuts.json` (mode
  0600, written atomically, read tolerantly), never in `session-shares.json`, whose strict parse
  would make an older Sova serve no link. Each entry names the cut entry it was taken with and
  counts only while the share's cut is that entry; a link with no entry that counts (made before
  designs were shared, or moved by an older Sova) reads at the later of its cut entry's time and
  the share's creation. Follow live has none: every finished version. The design cut is part of
  the share's source, so a build begun before it moved sends nothing.
- The mode can be switched afterwards; switching Follow live off sets the cut to the current leaf.

## §app.session-share/content — What a recipient sees

- The page shows the public title, "Shared {date} · read only" and the conversation: each user
  message's text and each assistant reply's text as markdown, with its `vis` drawings, and the
  images embedded in those messages. The newest 200 items come first; Show earlier reads the page
  before them. No composer, no names, no recipient label. A sliced share shows only its slice
  (§app.session-share/slice), with `earlier` set when it starts after a shown message.
- **Lookbooks.** Each Lookbook run whose card sits in the shown part of the conversation shows
  there, as a block of its finished designs, read only (§app.session-share/lookbook). It is the one
  card a share shows; nothing else of a Lookbook goes out.
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
  name, costs, subagent transcripts and reports, every custom entry and card (a Lookbook's
  designs alone excepted, as §app.session-share/lookbook allows them), clipboard or
  attachment paths, recipient labels, and entry ids (the operator's outline alone carries them). The view is built field by field on the server; no
  transcript row is passed along whole. What is excluded are the records and fields themselves: an
  assistant reply that quotes a tool's output, or any other private value, is still reply text,
  and only the redactor's known secrets and patterns are taken out of it; Preview and the Follow
  live consent are what cover the rest.
- **Of a Lookbook,** only its finished designs' pages and the fields §app.session-share/lookbook
  lists go out: a design's model goes only as its display name, never its id or provider. Never
  the Creative Director (its section, status, chat, card or brief), the Design Brief, Setup, what
  each design was told, design chats, a design's session, session file or model id, its usage,
  cost, status, error or fix, skills, a page being written, a stopped design's still, view
  pictures, removed designs, another chat's designs or another run's, and no internal, pending or
  history field. A design's style and layout names pass the server redactor and both link filters
  below, as a message's text does. Its page text passes both link filters and the redactor's code
  mode, so the page's scripts still parse: known secret values and every shaped secret pattern
  (§app.overseer/tools: `sk-`, GitHub, GitLab, AWS, Slack, JWT, PEM, `Bearer`) are removed as in a
  message, and a name guess (`apiKey=`, `"password":`, `?client_secret=`) removes
  its value only where the swap keeps the code valid, a value in quotes or a URL query's value of
  URL characters, and only a value that looks like a secret (one word of 12 characters or more,
  not a number, path or plain URL). Bare code (`token = getToken()`), comparisons (`e.key==='Escape'`)
  and short keys and labels (`key='draft'`) go out as written.
- Every string passes the server redactor (known secret values, then secret patterns) before it
  leaves the host, a design's page text in the code mode above. In the conversation's text, the session's cwd becomes relative and the home
  directory `~`. Wake nudges and link partners' messages are not the user's words and are left
  out. An image path (/tmp, an attachments folder, a generated paste name) leaves the text
  wherever it stands, prose, inline code, a fence or a vis drawing's source alike: removed when
  it is a word of its own, `[image]` otherwise; ordinary code stays as written. A preview link
  this host keeps (§app.project-overseer/previews), in the title or any message, a person's own
  words included, becomes "[preview link]" before any text is cut, and every view, outline and
  socket frame passes that filter whole. Likewise a link of this host whose token is kept
  (§app.session-share/link: `/s/`, `/h/`, `/i/` or `/t/`), in the title or any message, becomes
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
  carries the same view), and as written on a hand-off page. For Lookbooks it plants a marker in
  every excluded Lookbook field above, a version finished after a snapshot's cut, a removed design,
  a page being written, a run anchored outside a slice and another chat's design, and checks that
  none reaches any `/api/s` answer, the page shell, a design address or the design's own tab, or a
  socket frame, and that a dead link serves no design. A design's page whose script the name
  guesses would rewrite (`e.key==='Escape'`, `key='draft'`, `{"token": "abc"}`) goes out byte for
  byte while the same code in a message is still redacted, an unshaped value in quotes behind
  `apiKey` is still taken from the page, and in Chrome that page's script runs on the link.

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
  plus `sequence` and `state`. `svg` draws as a still image in the chat's figure (its title, the
  drawing, its caption; no Source or Copy), at its own size, centred and shrunk only to fit the
  column, in the page's colours and a sans-serif font, and it runs no script and fetches nothing
  (§app.baton/outsider-view); `code` and `html` show as their source, escaped, under a caption.
  Any other kind, or one that doesn't parse, is the one quiet line.
- **Images** are thumbnails under their message's text, at most 320 by 240 pixels, each a link that
  opens the full image in a new tab.
- **Lookbooks** draw as a block of tiles where their card sits in the conversation, with a
  full-size view and each design's own tab (§app.session-share/lookbook-view). A push or a read
  carries them with the view, so they follow the same lineage and page rules as its items.
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
  section has **Share Session** (a link to the share page, §app.session-share/share-page; hidden
  while sharing is off, §mesh.public/sharing-off) and a link to `#/shares`. None: "Not shared with anyone."
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
- **Designs before any link.** Designs are always shared, with no switch, on links made before too;
  the form shows and loads every version of every design that will go out before Create Links, as
  §app.session-share/review-designs sets out, and Update to Now and Stop Following do the same.
- **A snapshot is the preview.** Create sends the preview's `cut`, so a snapshot holds exactly what
  the sheet showed, never what the session added after; Follow live sends none. When the cut is
  no longer in the session file (409 `stale-preview`), nothing is minted: the sheet says "The
  session changed. Preview it again." beside the preview and reads it again, to be reviewed again.
- **Create Links** (`Create Link` for one) mints them and shows each new link with its label and
  **Copy Link**; the `linkWarning`, when there is one, shows with **Open Settings** (§app.baton/links).
- The sheet and the create form show **Where links open** on one line with **Change**
  (§mesh.public/where-links-open), the Turn On or Download prompt while needed (§mesh/tunnel), and,
  in an open sheet, the banner of this share's links that broke when an address changed
  (§mesh.public/broken-links).
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
  expiry). Standalone reviewed-tour links (`/t/`) are included too, identifying their pinned edition and expiry; their Visits disclosure shows only what the existing opt-in Log visitors switch recorded (§mesh.public/visitor-log). With the mesh on, each row names its host.
- Above the lists: **Where links open** on one line with **Change** (§mesh.public/where-links-open),
  the Turn On or Download prompt while one is needed (§mesh/tunnel), an unreadable setting's warning
  (§mesh.public/free-default), and the warn banner of links that broke when an address changed, each
  with Copy New Link or Share again (§mesh.public/broken-links). A Copy Link here tells the server
  the link left (§mesh.public/broken-links). While sharing is off on this computer
  (§mesh.public/sharing-off) the line reads "Sharing is off." with **Open Settings**, and the rows
  of its links (and every organization link row) show no Copy Link or Copy {name}'s Link; Delete,
  Stop Sharing and Manage stay.
- A session share row: its public title (a link to the session), its slice line or mode line (as
  the Sharing section), its recipients
  with presence and opened lines (each live one whose link is kept with **Copy Link**), and **Manage** (the Share sheet on it) and **Stop Sharing**
  asked twice.
- An org link row: the person, the organization, the hand-off's title and number or "Owner page",
  its state, "Expires in {n} days", the presence word, the opened line, its visits folded
  underneath, **Copy Link** when its link is kept, and **Delete Link** asked twice, its confirm and the line under it saying the link
  stops working for good (the existing hand-off or owner revoke route). The
  page never changes those stores otherwise.
- A tour link row (its own **Tour links** card, after Organization links, listing each live `/t/`
  link whose source chat still owns it): the tour's public title (a link to its chat), its pinned
  edition's check time as "Edition checked {time}", "Expires in {n} days", the opened line, its
  visits folded underneath, **Copy Link** when its link is kept, and **Delete Link** asked twice,
  its confirm and the line under it saying the link stops working for good (the tour's own revoke
  route). A reader's resume link is never listed. The count line adds "· {n} tour links" when
  there are any.
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
  start left the branch included). Update to now, a mode switch, a slice change, a live share's
  growth and a change to a live share's Lookbook designs push `{type: "view"}` to every open page of the share (`reset: true` when its lineage
  changed, §app.session-share/slice).

## §app.session-share/overview — The Shares page's data

- `GET /api/shares-overview` answers this host's public links only (the page fans out to up
  peers): its session shares, with each recipient's presence and visit counts, and its **org
  links**, meaning every live hand-off (`/h/`) and owner (`/i/`) link of every attached org, newest
  first. Each org link carries its org, its person's name, a hand-off's session id, public title,
  number and baton state (an owner link's state is "live"), its creation and expiry, its `link` when
  its token is kept (§app.session-share/link), and its own visits from the org's visit log (§app.baton/visits), with `opened` and `lastAt` counted as for a
  recipient. A hand-off link whose page has an open socket is `viewing` (hand-off pages send no
  visibility); an owner link, which has no socket, carries no presence. Its **tour links** are
  every live standalone `/t/` link whose source chat still owns it, newest first, each with the
  tour's title, its pinned edition and that edition's check time, its creation and expiry, its
  `link` when kept, and its opt-in visits (§app.tours/sharing); a tour link store that can't be
  read lists none.
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
  recipient answer, image route, design address, shell or frame ever carries one.
- **Lookbooks in a slice.** A Lookbook shows only when its card's entry is on the slice; a run
  whose card is before `from` or after the cut is left out whole. A Lookbook block never takes an
  item number: it rides beside the items, placed after the item its card follows, so item
  numbers, image indices and pages stay what they were.
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
  and its Lookbooks included. **Next** shows the create form (title, people, Anyone, Follow live,
  expiry, the images, the designs and Create Links, as §app.session-share/sheet describes them;
  its review line adds ", and the designs below" when the slice shares designs), sending `from`, the previewed `designsAt` and the previewed
  `cut`; a start or cut no longer on the branch is 409 stale-preview and nothing is minted. The new
  links show on the page, with **Copy Link** and the `linkWarning`, and **Done** returns to the
  session.
- **Changing a slice.** With `&share=<id>` the page opens on that share's slice and Next becomes
  **Save Slice**: the same review step (the new slice's images and designs load and gate it, as
  Create's do, since a later end can publish new ones), then PATCH `from`, `cut` and the previewed `designsAt`, with the same
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

## §app.session-share/lookbook — Lookbooks on a share: what goes out

As the user decided, a share link also shows each Lookbook (§chat/design-mode) in the shared part
of the conversation, every design read only and walled off, and nothing of how it was made.

- **Where it sits.** A run is anchored by the first entry on the share's whole branch that names
  it: the `lookbook` tool result carrying its card (not one that failed), or its run record. It
  shows only when that entry is inside the slice (§app.session-share/slice); a run first anchored
  before the slice's start is left out whole, and a run of another chat never shows. Each block
  carries `after`, the item it follows (-1: before the first), and items are never renumbered.
- **Which designs.** Every design of the run with at least one version shown, by letter. A removed
  design is left out, and so is a run with none to show.
- **Which versions.** Finished versions only: a version shows when it has a finish time and its
  page is kept, never a page being written. A snapshot shows those finished by its design cut
  (§app.session-share/snapshot); Follow live shows every one. Versions go out oldest first.
- **What each design carries.** Built field by field on the server, from an allowlist: its letter,
  its style and layout names and its model's display name (each through the share's scrub and both
  link filters, on one line, at most 80 characters), and each version's number, finish time and up
  to 24 view names. Never its cost or tokens, nor anything §app.session-share/never lists. A block
  carries its designs and its place, nothing of the run. Every page and push of a view carries all
  of its Lookbooks (`lookbooks`, `[]` when none); a host that shares no designs sends none.
- **Always on.** No switch and no field in the share's record: links made before this show their
  Lookbooks too. The operator sees each design and version before a link is made or moved
  (§app.session-share/sheet).
- **Signed-in pictures.** A design whose pictures came from a signed-in capture
  (§chat.design-mode/link-sign-in) is shared like any other. The operator's preview, and only it,
  carries `signedInPictures` when a shown version's page uses one, and says so first.
- **A peer that doesn't offer them.** A peer's share is built by that peer: one whose Sova sends no
  `lookbooks` shows none, and the operator's preview shows no designs section.

## §app.session-share/lookbook-view — Lookbook tiles, the full-size view, and a design's own tab

- **The block.** Titled "Lookbook · {n} designs" ("1 design"), after the item its card follows
  (§app.session-share/lookbook); one whose item is on an earlier page waits for Show Earlier, and
  one before the first item shows on top once no earlier page is left. One tile per design: its
  newest version scaled down from 1280 pixels wide, its letter, "{style} · {layout}" (the style
  alone with no layout), and its model's name with its count of versions. One column on a phone,
  a grid on a wider page. A tile's frame is there only within about a screen of view, with small
  pictures and its motion held; the whole tile opens it full size.
- **The full-size view** is a dialog over the page: **Back** (and Esc), its title (the letter and
  version, with its style and layout) and model name, **Previous** and **Next** across the block's
  designs (wrapping, with two or more), the **Version** picker over every version shared
  ("Version {n} · {time}", disabled with one), **Desktop** / **Phone** on a screen 768 pixels wide
  or more, and **Open in New Tab**. The share page keeps the open design in its address,
  `#design=<letter>[/<n>]` (no version: the newest), so Back closes the view and a reload opens it
  again; a move inside the view replaces the address instead of adding to history. A pushed view
  never closes it, and a newer version joins its picker. An address naming a version no longer
  shared closes the view and scrolls to the block.
- **A design's own tab.** Open in New Tab opens `/s/<token>?design=<letter>[&v=<n>]` with no
  opener or referrer: the share page itself, drawing that design alone with minimal chrome. One
  thin bar holds a design picker (every design of the view), the Version picker, Desktop / Phone
  on a wide screen, the model's name and **Close**, which closes the tab or, where the browser
  won't, goes back to the conversation with that design open. The tab's title is "{letter} ·
  {title}". It reads the share as the conversation does, socket included, so a dead, expired or
  stopped link shows the share page's dead page there too, a design no longer shared says so with
  a way back to the conversation, and an offline host says it is offline.
- **Interactive or still.** In a browser that supports the frame `csp` attribute (Chrome-family), a
  finished page runs, in a tile and full size alike; in any other it is a still page with its
  scripts off, under one quiet line saying so (§design.copy-deck/session-share-lookbook). Both
  follow §chat.design-mode/prototype-frame's wall on a shared page. A frame shows a loading line
  until its page has drawn, and a page that tries to leave its frame is stopped and says so.

## §app.session-share/lookbook-serving — How a share serves its designs

- **One address per document.** `GET /api/s/<token>/d/<letter>/<n>/<kind>`: a letter of 1 to 4
  capital letters, a version from 1, and the kind `page` (full size, running), `still` (full size,
  no scripts), `tile` (running, small pictures, motion held) or `tile-still`. It is on the strict
  path list (§app.baton/share-listener), and a gateway passes it as a forward-only shape for a link
  a routed host registered (§mesh.public/share-protocol). No address names a run, a session, a file
  or an entry id; the design's own tab is the share page's own `/s/<token>` with a query.
- **Only what the view shows now.** The document is built against the link's share as it is
  (granted, judged again after its reads, as every view is: §app.session-share/link), and only for
  a version the view shows; anything else is 404 "No such design.", and a dead, expired, stopped or
  unknown link answers as the view does (410 or 404), serving nothing.
- **What a document is.** The version's page as kept: its text through the share's scrub in its
  code mode and both link filters (§app.session-share/never), which leave a page that drew still
  drawing and its scripts still parsing and running, then its
  pictures put in (never read as text), then the app's wall (`src/lib/design-frame.ts`): `page`
  and `tile` in its two-frame shell, the stills as the frame for a page being written. On a share
  the shell puts the page in as a `blob:` document it makes, never `srcdoc` or a `data:` address
  (Chrome refuses navigation URLs over 2 MB), so the page's `baseURI`, `location`, `URL` and
  referrer never hold the token (§chat.design-mode/prototype-frame). A document
  is at most 32 MB: past it, it falls back to small pictures, then is not served.
- **Its headers.** `page` and `tile` carry the policy `sandbox allow-scripts allow-forms` plus the
  wall's design policy (Google Fonts' stylesheets and font files only) and `frame-ancestors
  'self'`, the shell's policy differing from the app's wall only by `frame-src blob:`; the stills
  carry `sandbox` with the stream policy. Every document is `text/html`,
  `X-Frame-Options: SAMEORIGIN` (the share listener's one framing exception besides the frame
  host), `nosniff`, `no-store`, `no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and
  `noindex`. The share page's own policy is never loosened for a design.
- **Limits.** Per token, 240 document reads and 256 MB a minute (429 past either); per address, a
  bucket of their own of 240 a minute, beside the page's 60. A gateway caps a routed host's design
  answer at 32 MB too.
- **The operator's preview** reads the same documents, with the same headers, from its own routes
  (`/api/session-shares/preview/d/…` at the preview's cut, design cut and start, and
  `/api/session-shares/<id>/preview/d/…` for a share as it is now). It reads each document's text
  and frames it inline under the same sandbox and `csp` attributes, so a peer's design reads through
  the peer relay too; it has no Open in New Tab.

## §app.session-share/review-designs — The designs before any link

As the user decided, the operator sees every design and version a share will carry before any link
is made or moved, as shared images load first (§app.session-share/sheet).

- **What it shows.** When the previewed part holds a Lookbook (§app.session-share/lookbook), the
  create form, on the share page and in the sheet, shows every version of every design that will go
  out, each drawn small from the very document a recipient gets, grouped by Lookbook when there are
  several, under "{n} designs · {m} versions".
- **Loaded at once.** Never lazily: every version is read (four at a time) before anything is
  shared, and Create Links waits for them after the images; one that fails, or a set not loaded
  after 15 seconds, shows **Retry Designs**.
- **Signed-in pictures.** When any shown version's pictures came from a signed-in capture
  (§chat.design-mode/link-sign-in), "Some pictures came from a signed-in page." stands above them.
- **Moving a snapshot.** Update to Now and Stop Following show the same before their confirm and
  wait for it the same way; their line ends "…images and designs included." when designs are
  shared. The preview's `designsAt` goes back with its cut, so a snapshot holds exactly the
  previewed designs (§app.session-share/snapshot).
- **Preview** draws the Lookbooks in the thread too, from the operator's preview routes
  (§app.session-share/lookbook-serving), with no Open in New Tab.
- **A peer without them.** A share on a peer whose Sova doesn't offer designs on shares previews
  and shares without them, with no designs section.
