# §app/session-share — Session share links: a whole session, read-only, one link per recipient
> Part of the Sova design spec · [overview](../design/overview.md)

The operator can share a whole session read-only with people outside the tailnet. A share has a
public title, a mode (a snapshot, or Follow live), an expiry, and one link per recipient: a named
recipient (the operator's private label, such as "Ana") or the optional "Anyone with the link"
row. The recipient opens a phone-first page on the share listener (§app.baton/share-listener) that
shows the conversation only. The operator sees who opened each link, when, on what kind of device,
and who is viewing now. The host that holds the session file mints and serves its shares; the
gateway only routes by hash (§mesh/public). Wire shapes: `shared/session-share.ts`. Copy:
§design.copy-deck/session-share.

## §app.session-share/link — Links: shape, store, expiry, revoke

- **Shape.** `/s/<token>` on the share listener's public address, built like a hand-off link
  (§app.baton/links): 32 random bytes in base64url; the host keeps only its SHA-256, compared in
  constant time; logs show at most 6 characters. Each recipient has its own link; a recipient's
  label is never shown to any viewer.
- **Store.** `<stateRoot>/session-shares.json`, mode 0600, written atomically, host-local, never
  synced or committed: `{version: 1, shares: [{id: "ss_…", sessionId, sessionPath, title, mode,
  cut: {entryId, at} | null, createdAt, stoppedAt?}], links: [{hash, shareId, recipientId: "r_…",
  label, anyone?, createdAt, expiresAt, revokedAt?, revokedWhy?}]}`. A file that fails the strict
  parse serves no link and is never overwritten.
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
- **Dead links.** A revoked, relinked, stopped or expired link, or one whose session file is gone or
  whose cut entry is no longer in it, answers 410 `{error, code: "gone"}` (`why: "expired"` only
  when it expired) with no title or name; an unknown token answers 404 `{code: "not-found"}`.
  Open pages of a link that dies are closed with 4410; a socket is admitted only where the view
  would answer, and a 30-second sweep closes pages whose link expired or whose share no longer
  reads. Archiving a session stops its shares.
- **Nothing after narrowing.** A view, image or pushed view is sent only while the token still
  opens and the share's source (mode, cut, title, stopped) is the one it was built from, judged
  after the build: a revoke, stop or switch to a snapshot during a read or a live rebuild sends
  nothing from it, and of two rebuilds only the newest is pushed.
- **Registry.** Live links are registered with the gateway as kind `s` rows (§mesh.public/registry)
  on every mint, relink, revoke, stop and extend; a mint waits for the gateway's answer as other
  links do, and returns each link once with the share's `linkWarning`. A mint of several links is
  confirmed only when each of them was sent and accepted.
- **Operator routes** are the operator API, as listed in `shared/session-share.ts`: the main
  listener, and a verified peer through the pane's host scope (a peer's sessions are shared by the
  peer). The share listener never has them.

## §app.session-share/snapshot — Snapshot by default, Follow live per share

- A **snapshot** share stores only a cut: the entry the operator's Preview was built at (the
  preview names it, and the mint must pass it back; a cut no longer in the file is refused as a
  stale preview), and its time. What is minted is exactly what was previewed, images included,
  whatever the session wrote meanwhile. Its view is the branch from the root to the cut, rebuilt and filtered on each read, so it
  stays the same after later messages, rewinds or branches. **Update to now** moves the cut to a
  previewed cut when one is given, else the current leaf, and pushes the new view to open pages.
- **Follow live** (`mode: "live"`) has no cut: the view is the session's current branch. While a
  live share has an open page, the minting host watches the session file (TUI-owned sessions
  included) and, debounced, pushes the refiltered view when whole entries were appended; it never
  streams a reply as it is written.
- The mode can be switched afterwards; switching Follow live off sets the cut to the current leaf.

## §app.session-share/content — What a recipient sees

- The page shows the public title, "Shared {date} · read only" and the conversation: each user
  message's text and each assistant reply's text as markdown, with its `vis` drawings, and the
  images embedded in those messages. The newest 200 items come first; Show earlier reads the page
  before them. No composer, no names, no recipient label.
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
  attachment paths, and recipient labels. The view is built field by field on the server; no
  transcript row is passed along whole. What is excluded are the records and fields themselves: an
  assistant reply that quotes a tool's output, or any other private value, is still reply text,
  and only the redactor's known secrets and patterns are taken out of it; Preview and the Follow
  live consent are what cover the rest.
- Every string passes the server redactor (known secret values, then secret patterns) before it
  leaves the host. In the conversation's text, the session's cwd becomes relative and the home
  directory `~`. Wake nudges and link partners' messages are not the user's words and are left
  out. An image path (/tmp, an attachments folder, a generated paste name) leaves the text
  wherever it stands, prose, inline code, a fence or a vis drawing's source alike: removed when
  it is a word of its own, `[image]` otherwise; ordinary code stays as written. A time goes out only as a canonical ISO time
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
  an abandoned branch next to an id-less record in Follow live.

## §app.session-share/rejected — Rejected shapes

- Serving shares from the main listener: outsiders never reach it (§app.baton/rejected).
- Reusing the `/h/` family or kind `h`: a separate `/s/` family and kind `s`, gated by the
  gateway's advertised kinds, instead.
- Sending transcript rows and filtering on the client, copying content to the gateway, storing a
  frozen copy of the view, token streaming to viewers, and viewer replies.

## §app.session-share/page — The share page

- `/s/<token>` is the share build's session page (`src/share/SessionShareApp.tsx`): one column,
  phone first, like the hand-off page. The head is the public title and "Shared {date} · read
  only"; a snapshot adds "up to {date and time}" (its `through`), and a Follow live share carries
  a `Live` chip. User messages are right-hand bubbles and replies left-hand ones; neither is
  labelled with a name.
- **Drawings.** A reply's `vis` fences draw as on the hand-off page (§app.baton/outsider-view),
  plus `sequence` and `state`. `svg` draws as an image, which runs no script and fetches nothing;
  `code` and `html` show as their source, escaped, under a caption. Any other kind, or one that
  doesn't parse, is the one quiet line.
- **Images** are thumbnails under their message's text, at most 320 by 240 pixels, each a link that
  opens the full image in a new tab.
- The page reads the newest page first, from the top; **Show Earlier** reads the page before and
  keeps the reader's place. A `view` push replaces the newest page and keeps the earlier pages
  already read; a reader at the bottom stays at the bottom.
- The page opens `/ws/s?token=&v=` and sends only `{t: "vis", on}` on open and on each
  visibilitychange. A `gone` frame or a 4410 close shows the dead page ("This link has expired."
  only when it expired); an unknown token shows "This link doesn't open a shared session.". A
  public gateway's 503 or a 4503 close keeps what the page shows, says it is offline, and reads
  and reconnects, backing off from 5 to 60 seconds (§mesh.public/offline).

## §app.session-share/sheet — Sharing in Session detail, and the Share sheet

- **Sharing section.** Session detail's Session tab has a Sharing section after Identity
  (§app.subagents-pane/tabs). It lists the session's shares, newest first: each share's public
  title, its mode line ("Snapshot up to {time}" or "Follows live"), and its recipients, each with
  a presence word when a page is open ("Viewing now", "Open in a tab") and "Opened {n}× · last
  {time}" or "Not opened yet". A stopped share says "Stopped". Each share has **Manage**; the
  section has **Share Session** and a link to `#/shares`. None: "Not shared with anyone."
- **The Share sheet** is a dialog that becomes a sheet at folded width. Creating a share, it holds:
  the public title (the session's title, editable, at most 120 characters, with a hint that the
  session's own title may say more than you mean); the people, one label each (Enter or **Add**;
  each removable; at most 20 links in all, no two alike); an **Anyone with the link** switch, off by
  default; a **Follow live** switch, off by default (a snapshot), whose hint says which one it is;
  and the expiry (1 day, 7 days, 30 days or 90 days; 30 by default).
- **Images before any link.** The sheet reads the preview (the same builder, no token) when it
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
- **Create Links** (`Create Link` for one) mints them and shows each link once, with its label and
  **Copy Link**; the `linkWarning`, when there is one, shows with **Open Settings** (§app.baton/links).
- **Managing a share** opens the same sheet on it: the title (Save Title), the Follow live switch,
  **Update to Now** on a snapshot (both it and switching Follow live off first show the
  conversation as it is now, images loaded as above, and then stop at that preview's cut:
  **Update to This** / **Stop Following Here**, with the same stale-preview handling; Back
  changes nothing), each recipient's
  row (presence, opened line, expiry, its visits folded underneath, **Get New Link**, and **Turn
  Off** asked twice), **Add Person**, **Add Anyone Link** while it has no live anyone row, **Extend**
  with the four expiry choices, **Preview**, and **Stop Sharing** asked twice. A new link from Get
  New Link or Add shows once, like Create. A Get New Link or Turn Off that fails says the server's
  reason on that recipient's own row, brought into view; a share-level action's failure is the
  sheet's banner. A turned-off row has no Get New Link: the person is added again instead. While
  open it reads the share's activity every 5 seconds while the page is visible.
- A share on a peer's session is read and changed on that peer, through the pane's host scope.

## §app.session-share/shares-page — The Shares page

- `#/shares` is a main-pane page, entered from a pinned **Shares** row in the sidebar foot (and the
  spine's Shares button while the pane is collapsed), and from each Sharing section. At folded
  width it uses `data-view="session"` and shows `.app-back`.
- It lists every live public link this host and each up peer serve: **Session shares** first (the
  shares with a live link, then the stopped and expired ones folded under "Ended"), then
  **Organization links** (every live hand-off `/h/` and owner `/i/` link, from
  `GET /api/shares-overview` on each host). With the mesh on, each row names its host.
- A session share row: its public title (a link to the session), its mode line, its recipients
  with presence and opened lines, and **Manage** (the Share sheet on it) and **Stop Sharing**
  asked twice.
- An org link row: the person, the organization, the hand-off's title and number or "Owner page",
  its state, "Expires in {n} days", the presence word, the opened line, its visits folded
  underneath, and **Turn Off Link** asked twice (the existing hand-off or owner revoke route). The
  page never changes those stores otherwise.
- It reads every host again every 5 seconds while the page is visible, and not while hidden. A
  host that doesn't answer is one line: "{host} can't be reached, so its links aren't listed.".
  None anywhere: "No public links are open. Share a session from its Session tab."

## §app.session-share/visits — Who opened each link

- Each recipient's link keeps a visit log under the rules of §app.baton/visits: a visit starts at
  the page's first `GET /api/s/<token>` that answers 200, continues by the tab's `?v=` or within
  10 minutes from the same device family, records a device family (never the address, the raw
  user agent, the token or its hash), marks scanners and scripts `bot`, records a known link
  previewer's shell fetch as a preview and a dead link's read as a refusal, caps new lines at 20 a
  link a day, and writes `seen` lines every 5 minutes, when a socket closes and at shutdown. A
  socket never starts a visit.
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
  4410; a 30-second sweep catches expiry. Update to now, a mode switch and a live share's growth
  push `{type: "view"}` to every open page of the share.

## §app.session-share/overview — The Shares page's data

- `GET /api/shares-overview` answers this host's public links only (the page fans out to up
  peers): its session shares, with each recipient's presence and visit counts, and its **org
  links**, meaning every live hand-off (`/h/`) and owner (`/i/`) link of every attached org, newest
  first. Each org link carries its org, its person's name, a hand-off's session id, public title,
  number and baton state (an owner link's state is "live"), its creation and expiry, and its own
  visits from the org's visit log (§app.baton/visits), with `opened` and `lastAt` counted as for a
  recipient. A hand-off link whose page has an open socket is `viewing` (hand-off pages send no
  visibility); an owner link, which has no socket, carries no presence.
- It only reads the hand-off and owner link stores and the visit logs, and never writes them. An
  org whose workspace can't be read is left out. A turned-off or expired link is not listed.
