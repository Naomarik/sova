# §chat/images — 04b · Images
> Part of the Sova design spec · [overview](../design/overview.md)

Images show up in three places. A **user row** and a **tool-result row** can each carry images
(`TranscriptItem.images`, as data URLs). The **composer** can attach images to a prompt or a
steer (`OutboundImage[]`).

Web uploads don't ride the prompt as base64. The composer uploads each image **when you
attach it**, not at send: `POST /api/upload?draft=<session path>` stores the bytes as a fresh
`pi-web-<uuid>.<ext>` in that session's attachments folder,
`~/.pi/agent/sova/attachments/<sessionId>/`. At send, the prompt text names that durable path.
The user row then shows the same path-attachment unit as TUI pastes; the model sees the image by
reading the path. Unlike a TUI paste in `/tmp` (10 days on this host, gone on reboot), the file
outlives a reboot, so a sent image keeps its thumbnail in the transcript. Deleting the session
removes its folder, and then the unit reads "No longer on disk", as a cleaned-up `/tmp` paste
does. Old base64 rows keep their inline thumbnails.

## §chat.images/thread-thumbnails — Thread thumbnails

On a **user row**, the images go under the head, right-aligned, and *above* the text bubble
(the images are what the text talks about). If the row has no text, leave out
`.message-body` entirely rather than render an empty bubble.

```html
<article class="message message-user" aria-label="You, 14:06">
  <div class="message-head"><span class="message-author">You</span><span class="message-time">14:06</span></div>
  <!-- add message-images-single when there is exactly 1 image -->
  <ul class="message-images" aria-label="2 images">
    <li>
      <button class="thumb" type="button" aria-haspopup="dialog">
        <img src="data:image/png;base64,…" alt="Image 1 of 2 in your message" loading="lazy" decoding="async">
      </button>
    </li>
    <li>
      <button class="thumb" type="button" aria-haspopup="dialog">
        <img src="data:image/png;base64,…" alt="Image 2 of 2 in your message" loading="lazy" decoding="async">
      </button>
    </li>
  </ul>
  <div class="message-body message-text">{text}</div>
</article>
```

- **Sizing.**
  - **1 image** (`.message-images.message-images-single`): it keeps its own shape, fitted
    inside 320 × 240 (`object-fit: contain`) and never wider than the column.
  - **2 or more:** 96 × 96 square tiles (`object-fit: cover`), with an `--space-2` gap. They
    wrap as needed: 2 tiles fit in one row at 320px.
- **Surface.** `--r-md` (one step under the bubble's `--r-lg`), a 1px `--color-border` edge,
  and `--color-sunken` behind transparent pixels. On hover the border turns
  `--color-border-strong`. Focus shows the standard ring. The cursor is `zoom-in`.

On a **tool-result row**, the images go in the tool card, as a section after Output. The
collapsed summary shows a count so the images aren't hidden.

```html
<summary class="toolcard-summary">
  …twist, icon, name, arg…
  <span class="toolcard-images" title="2 images">
    <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>2
    <span class="visually-hidden">images</span>
  </span>
  <span class="chip chip-success"><i class="chip-dot"></i>Done</span>
</summary>
<div class="toolcard-body">
  …Arguments, Output…
  <div class="toolcard-section">
    <div class="toolcard-section-label">Images · 2</div>
    <ul class="message-images" aria-label="2 images">
      <li><button class="thumb" type="button" aria-haspopup="dialog">
        <img src="data:image/png;base64,…" alt="Image 1 of 2 from tool result read" loading="lazy" decoding="async">
      </button></li>
      …
    </ul>
  </div>
</div>
```

**Alt text.** It's built from context, because pi stores no captions.

| Where | 1 image | n images |
|---|---|---|
| User row | Image in your message | Image {i} of {n} in your message |
| Tool result | Image from tool result {toolName} | Image {i} of {n} from tool result {toolName} |
| Pending attachment (composer) | attachment | attachment |
| Path attachment | Attachment {name} in your message | — (one image per unit) |

`{toolName}` is the paired tool-call's name (`read`, `bash`, and so on). Without a pairing it's
"result". The thumbnail button needs no `aria-label`, because its name comes from the image's
alt. `aria-haspopup="dialog"` tells AT that it opens something.

## §chat.images/path-attachments — Path attachments

When you paste an image into pi's terminal UI, pi writes it to `/tmp/pi-clipboard-<uuid>.png`
(`/tmp/pi-wsl-clip-<uuid>.png` under WSL) and puts that **path in the message text**. A Sova
upload does the same with a path in the session's attachments folder (above). Either way the
image never reaches the session file. Replies, tool output and subagent reports then quote
the same path. The server finds these paths in user, assistant-text, info (custom messages,
such as subagent reports) and tool-result rows, and sends them as `TranscriptItem.attachments`.
On a user row each path gets a collapsed unit instead of a raw path in the bubble. Everywhere
else it becomes an inline chip or a tool-card section (see **Other rows** below).

```html
<article class="message message-user" aria-label="You, 14:06">
  <div class="message-head">…</div>
  <ul class="message-images">…stored images, if any…</ul>
  <details class="disclosure message-attachment">
    <summary class="disclosure-summary" title="/tmp/pi-clipboard-a587….png">
      <span class="icon icon-sm icon-twist" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
      <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>
      <span class="disclosure-label">Attachment</span>
      <span class="message-attachment-name">pi-clipboard-a587….png</span>
      <span class="message-attachment-meta">· 240 KB</span>
    </summary>
    <div class="message-attachment-body">          <!-- rendered only once opened -->
      <ul class="message-images message-images-single" aria-label="1 image">
        <li><button class="thumb" type="button" aria-haspopup="dialog">
          <img src="/api/attachment?path=%2Ftmp%2Fpi-clipboard-a587….png" alt="Attachment pi-clipboard-a587….png in your message" loading="lazy" decoding="async">
        </button></li>
      </ul>
    </div>
  </details>

  <!-- the file is gone (from /tmp here): a static row, not a disclosure -->
  <div class="message-attachment message-attachment-missing" title="/tmp/pi-clipboard-fc03….png">
    <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>
    <span class="disclosure-label">Attachment</span>
    <span class="message-attachment-name">pi-clipboard-fc03….png</span>
    <span class="message-attachment-meta">· No longer on disk</span>
  </div>

  <div class="message-body message-text">{text without pi's path}</div>
</article>
```

- **Which paths.** An image file (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`), standing alone as a
  word, in one of two roots: directly in `/tmp`, or directly in a session's folder under the
  attachments root (`<agent dir>/pi-web/attachments/<sessionId>/<name>`). Subfolders of `/tmp`,
  deeper paths under the attachments root, and every other folder stay plain text. The client
  recognises an attachments path by its `/pi-web/attachments/<id>/` tail; the server then checks
  it really sits under this machine's root.
- **Only concrete names, never code.** A path counts only when its full file name is written
  out. `/tmp/pi-clipboard-*.png`, `/tmp/pi-clipboard-<uuid>.png` and `…`-shortened names are
  talk *about* the pattern, so they stay text. So does any path inside a markdown code span
  or a fenced block (``` or ~~~, even if the fence is never closed). Our own reports quote the
  pattern all the time, and a chip on a sentence about it would be wrong. A chip for a file
  that no longer exists is fine.
- **Cap.** At most 8 different paths per row get a unit or chip. Later ones stay text. The
  server checks each one once, and never looks at anything but the paths it found.
- **The text.** pi's own clipboard paths come out of the bubble, since the unit stands in for
  them (a Sova upload's name, `pi-web-<uuid>`, counts as pi's own in either root). An image
  path you typed yourself stays in the text (it's part of your sentence)
  and still gets a unit. If nothing is left, there's no bubble (same rule as thumbnails). The
  session file, and the text the model saw, never change.
- **Order.** Stored images, then path attachments in the order they appear, then the bubble.
  All right-aligned.
- **Collapsed by default.** Pasted screenshots are big, and old ones are usually gone. The
  image is fetched only when you open the unit, from `GET /api/attachment`. The browser never
  reads `/tmp` or the attachments folder itself.
- **Open.** It shows the image as a single thumbnail (the `.message-images-single` rules). A
  click opens the lightbox, scoped to that one image.
- **Gone.** `/tmp` gets cleaned, so this is the usual case for older TUI pastes; a file in the
  attachments folder is gone only once its session is deleted. The unit becomes a static row: no
  twist, no request, and it says "No longer on disk" — one note for both roots. A file over the 20MB
  serving cap says "Too large to show · {size}" instead.
- **Tokens.** The row uses the disclosure summary's metrics (`--control-sm` min height,
  `--fs-caption`, `--color-ink-muted`), with the summary's hover ground hanging off the right
  edge instead of the left. The name is `--font-mono` in `--color-ink-2`, truncated, and the
  full path is in `title`. The size is tabular. The opened body sits `--space-2` below the
  summary.
- **AT.** The native `<summary>` is the control. Its name reads "Attachment {name} · {size}".
  The thumbnail's alt is "Attachment {name} in your message", and that's also the lightbox
  caption.

**Other rows.** The path stays where it was written, so the prose still reads. It shows as a
compact chip, never as the raw long path.

```html
<!-- in a reply (markdown) or an info row (subagent report), in place of the path -->
<p>The screenshot at
  <button type="button" class="path-chip path-chip-missing" data-path-chip="/tmp/pi-clipboard-a587….png"
          aria-label="Copy path /tmp/pi-clipboard-a587….png, no longer on disk"
          title="/tmp/pi-clipboard-a587….png · No longer on disk. Select to copy the path.">
    <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>
    <span class="path-chip-name">pi-clipboard-a587….png</span>
    <span class="path-chip-note">· No longer on disk</span>
  </button>
  shows the minimap.</p>

<!-- the file still exists: no note; opens the lightbox -->
<button type="button" class="path-chip" data-path-chip="…" data-available aria-haspopup="dialog"
        aria-label="Open image pi-clipboard-a587….png" title="/tmp/pi-clipboard-a587….png">…icon, name…</button>
```

- **Chip.** One line, inline with the text. Mono `--fs-mono` in `--color-ink-2` on
  `--color-sunken`, with a 1px `--color-border` edge (`--color-border-strong` on hover) and
  `--r-sm`. pi's clipboard names are shortened to the prefix and 4 characters of the uuid
  (`pi-clipboard-a587….png`). Other names show whole and truncate. The full path is always in
  `title`.
- **Available.** A click opens the lightbox on that one image. The alt and caption are
  "Attachment {name}". The cursor is `zoom-in`.
- **Gone.** The chip adds "· No longer on disk" in `--fs-caption`, with the name in
  `--color-ink-muted`. A click copies the full path ("Copied path."), and the cursor is `copy`.
- **Where.**
  - **Replies:** chips are placed while the markdown renders, in text only, never in code.
  - **Info rows** (custom messages, subagent reports): plain text with chips.
  - **Tool cards:** the Output `<pre>` stays verbatim, since it's the record of what ran, and
    the card is collapsed anyway. After Output (and Images), an "Attachments · {n}" section
    lists the same units a user row gets.
- **Streaming.** While a reply streams, its paths are plain text. Chips appear when the finished
  row arrives from the server: the refetch when the turn settles, a hello, or a watch append.
  Nothing jumps mid-stream.

## §chat.images/resize-notes — pi's image resize notes

**The note pi writes for the model is not shown.** When pi (0.87+) resizes an image a user message
carries as image content, it appends a note for the model to that message's stored text, after a
blank line, one per resized image:
`[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]`.
Wherever Sova shows that message's text, it shows the text as typed, without those notes: the
user row, live or reloaded and in watch mode; the session's title; the text rewind puts back in the
composer; and the text a fork puts in the new session's composer. A message that was only images
shows as an image-only row, and rewind and fork put back no text. The note is display-only to hide:
the session file, and what the model is sent (a regenerate replays the stored text, note and all),
are unchanged.

Only pi's exact shape is removed, so typed text that merely looks like one stays as written. The
notes must be the message's whole last block, after its last blank line. Every line of that block
must be a hint pi writes: the dimension note, "[Image converted from … to image/….]" or pi's two
"[Image omitted: …]" lines. Each note's scale must equal its original width divided by its
displayed width, to two places. The message must be in the shape pi's prompt builds (one text
block, then only images), with at least as many images as notes. Only the dimension notes are
removed; pi's other hints stay. An assistant reply, or a user message without images, is never
touched.

## §chat.images/lightbox — Lightbox

**There is a lightbox.** Clicking or pressing Enter/Space on a `.thumb` opens that image full
size. It's one native `<dialog>`, opened with `showModal()`. That puts it in the top layer (it
isn't trapped by a `.pane`, and it needs no Portal), makes the page behind it inert, and gives
Esc for free. It fades in once with `--dur-base`; nothing loops, so the animation budget is
untouched.

```html
<dialog class="lightbox" aria-labelledby="lightbox-caption">
  <div class="lightbox-bar">
    <p class="lightbox-caption" id="lightbox-caption">Image 1 of 2 in your message</p>
    <span class="lightbox-count" aria-hidden="true">1 / 2</span>   <!-- only when n > 1 -->
    <button class="button button-icon button-ghost" type="button" aria-label="Close Image" autofocus>
      <span class="icon" style="--icon: url(/icons/close.svg)" aria-hidden="true"></span>
    </button>
  </div>
  <div class="lightbox-stage">                       <!-- a click here, outside the img, closes -->
    <img class="lightbox-img" src="data:image/png;base64,…" alt="Image 1 of 2 in your message">
    <!-- only when n > 1 -->
    <button class="button button-icon lightbox-prev" type="button" aria-label="Previous Image">
      <span class="icon" style="--icon: url(/icons/chevron-left.svg)" aria-hidden="true"></span>
    </button>
    <button class="button button-icon lightbox-next" type="button" aria-label="Next Image">
      <span class="icon" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
    </button>
  </div>
</dialog>
```

- **Scope.** The lightbox steps through the images of *one row* (one message, or one tool
  result), never the whole transcript.
- **Caption.** The caption is the image's alt, so the label, caption, and alt all say the same
  thing.
- **Keys.**
  - `Esc` closes it (native `cancel`).
  - `ArrowLeft` / `ArrowRight` step through the images, and wrap at the ends.
  - `Tab` cycles between Close, Previous, and Next.
- **Dismissing.** Any of these closes it:
  - `Esc`;
  - the Close Image button;
  - a click on the backdrop or on the empty stage (`event.target === dialog` or
    `event.target.classList.contains("lightbox-stage")`).

  A click *on* the image does nothing.
- **Focus.** On open, focus goes to Close Image (`autofocus`). On close, move focus back to the
  `.thumb` that opened it: store the element before `showModal()` and call `.focus()` on
  `close`. Don't rely on the browser to do this.
- **Layout.**
  - The image is fitted to the viewport under the 56px bar, with `--space-4` around it and
    `--space-8` side room for the arrows.
  - Under 768px the arrows move to the bottom corners, inside the thumb arc, and the image makes
    room above them.
- **Tokens.** The dialog is opaque `--color-bg` (full-bleed), with `::backdrop` `--scrim`
  underneath. Bar `--color-surface` with `--color-border`. Image on
  `--color-surface`, with `--r-sm` and `--shadow-3`. Arrows are `.button-icon` on surface with
  the 3:1 `--color-border-strong` edge, so they read against the scrim.

## §chat.images/composer-attachments — Composer attachments

There are three ways in, and all three feed the same pending list.

1. **Paste**, the CLI flow. In the textarea's `paste` handler, take every `File` in
   `clipboardData.files` whose type is an image and attach it. Call `preventDefault()` only if
   the clipboard has no `text/plain`. A paste that carries both text and an image, such as
   copying from a web page, keeps its text and attaches the image. A pasted screenshot has no
   useful name, so it shows as "Pasted image".
2. **Drag and drop** onto the composer. The whole `.composer` is the target.
   - On `dragenter`/`dragover` with `Files`:
     - set `data-drop="active"` if at least one item is an accepted image type;
     - otherwise set `data-drop="reject"`, which shows "Only images can be attached".
   - Call `preventDefault()` in `dragover` so the drop is allowed.
   - Clear `data-drop` on `dragleave` (when leaving the composer itself, not a child) and on
     `drop`.
   - On the **window**, `preventDefault()` for `dragover`/`drop` anywhere else. Otherwise a stray
     drop makes the browser navigate away to the image.
   - While the composer is disabled, never set `data-drop`, and ignore the drop.
3. **File picker.** The flyout's **Attach images** row (§4 "Composer flyout") closes the flyout and
   opens the hidden `<input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp">`,
   which stays the composer's — the flyout only asks for it. Reset the input's value after reading
   it, so the same file can be picked twice.

**Accepted.** `image/png`, `image/jpeg`, `image/gif`, and `image/webp`, up to **5 MB each** and
**8 per message**. These are the formats model providers accept. HEIC, SVG, and anything larger
are rejected on the client before they're sent. If the server enforces a different limit, change
the numbers here and in the copy deck together.

**Placement at 320px** (and anywhere the composer is under 480px wide). The row is the flyout
trigger (44) + textarea + actions. Under 480px of composer width, `Send`, `Steer`, and `Stop` drop
to icon-only 44px squares: their word sits in `.button-label`, which becomes visually hidden and
stays the accessible name. That's why every composer button wraps its word in
`<span class="button-label">`. At 320 while streaming, the textarea keeps 288 − 3 × 44 − 3 × 8 =
132px, and no control has to hide to get there — the flyout is one button where Attach and
Commands were two. It stays leftmost, away from the primary. The pending list sits above the row
and wraps, so it never squeezes the textarea.

**Pending list** (above the textarea):

```html
<ul class="attachments" aria-label="Attachments">
  <li class="attachment">
    <button class="attachment-thumb-button" type="button" aria-haspopup="dialog" aria-label="View screenshot-2026-09-19.png" title="screenshot-2026-09-19.png">
      <img class="attachment-thumb" src="blob:…" alt="attachment">
    </button>
    <span class="attachment-text">
      <span class="attachment-name" title="screenshot-2026-09-19.png">screenshot-2026-09-19.png</span>
      <span class="attachment-meta">240 KB</span>
    </span>
    <button class="button button-icon" type="button" aria-label="Remove screenshot-2026-09-19.png">
      <span class="icon icon-sm" style="--icon: url(/icons/close.svg)" aria-hidden="true"></span>
    </button>
  </li>

  <!-- rejected: stays in the list, is NOT sent -->
  <li class="attachment attachment-rejected">
    <span class="attachment-icon"><span class="icon" style="--icon: url(/icons/alert-circle.svg)" aria-hidden="true"></span></span>
    <span class="attachment-text">
      <span class="attachment-name" title="holiday.heic">holiday.heic</span>
      <span class="attachment-meta">Unsupported type</span>
    </span>
    <button class="button button-icon" type="button" aria-label="Dismiss holiday.heic">
      <span class="icon icon-sm" style="--icon: url(/icons/close.svg)" aria-hidden="true"></span>
    </button>
  </li>
</ul>
```

- **Shape.** Each attachment is 44px tall and at most 240px wide, with `--r-md`. It's an object
  you remove, so it takes a control's shape, not a status chip's pill. Contents: a 32px preview
  (`object-fit: cover`, `--r-sm`), then the name (truncated, full name in `title`) over the size
  in mono, then a 44px Remove.
- **Viewing.** The preview is a button ("View {name}") that opens the lightbox on just that
  image (alt "Attachment {name}"). Esc closes it and focus returns to the preview. Tab order in
  the row is View, then Remove. Hover shows a `--color-border-strong` edge, focus the standard
  ring, and the cursor is `zoom-in`.
- **Upload at attach.** Each accepted file uploads right away into the session's attachments
  folder; its row appears when the upload lands, and the stored draft then names it. Several
  upload in parallel, and one that lands after you switch sessions still joins its own
  session's draft. An upload that fails becomes a rejected item whose reason is `Upload failed`,
  announced as "{name} wasn't attached. Upload failed."
- **Preview source.** The uploaded file itself, through `GET /api/attachment?path=…` — the same
  route the transcript uses, so the preview survives a reload with the draft.
- **Removing deletes.** Remove takes the item out of the draft and deletes its file
  (`DELETE /api/attachment?path=…`, best effort: a failed delete leaves only an unnamed file).
  Deleting the session removes its whole attachments folder.
- **Size format.** `KB` under 1 MB, rounded (`240 KB`). Otherwise one decimal (`2.4 MB`).
- **Rejected.** Rejected files stay in the list with `.attachment-rejected`: `--status-error-bg`
  ground, a `--status-error` edge, and the `alert-circle` icon instead of a preview. The meta
  line gives the reason in words, so the color is never the only signal. They're never sent. The
  button is "Dismiss {name}". All rejected items clear on the next successful send.
- **Announcements.** Adding and rejecting are announced in the polite live region:
  - "{n} images attached."
  - "{name} wasn't attached. {reason}."
- **Removing.** After Remove, focus moves to the next attachment's Remove, or the previous one's,
  or the textarea when the list is empty.
- **Send rules.**
  - Send is enabled when there is text **or** at least 1 accepted attachment. An image-only
    prompt is valid and sends `text: ""`.
  - Send and Steer both carry the images. On a successful send, the list empties together with
    the textarea.
  - The optimistic user bubble shows the images right away.
  - Drafts keep their attachments per session, durably: the draft store holds the text **and**
    up to 8 attachments (`{ path, name, mimeType, size }`), so both survive a reload and follow
    you to another browser (§4). A draft of images alone still lists its session (§2).
- **Disabled composer** (TUI-live, connecting, reconnecting). The Attach images row takes the same
  `aria-disabled` and shares `aria-describedby="composer-reason"`. Paste and drop don't attach
  anything.

**Tokens.**
- **Attachment.** `--color-sunken` with a `--color-border` edge, `--r-md`, `--control-md`
  tall. Name `--fs-caption` in `--color-ink`; meta `--font-mono` in `--color-ink-muted`.
- **Rejected.** `--status-error-bg` with a `--status-error` edge, and meta in `--color-ink-2`.
- **Drop overlay.** A `--stroke-icon` dashed `--color-accent` edge on `--color-accent-tint`,
  with `--r-lg`, and text in `--color-ink` at `--fw-medium`. It's the one place a drag needs to
  say "here", which is what the accent is for. Reject swaps in `--status-error` /
  `--status-error-bg`.

**Contrast.**

| Pair | Dark | Light |
|---|---|---|
| Ink on accent-tint (drop text) | 12.57 | 14.57 |
| Ink-2 on error-bg (rejected meta) | 6.48 | 7.49 |
| Error on error-bg (rejected icon and edge) | 5.01 | 5.16 |
| Muted on sunken (size meta) | 5.40 | 4.75 |
| Border-strong on surface (lightbox arrows) | 3.47 | 3.61 |

---

