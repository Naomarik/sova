# §chat/composer — Session input

Message input for one chat session the webapp holds. A watch-only composer never sends.

## §chat.composer/drafts — Stored-draft retention

On a draft save, the server keeps the original text and the valid pending attachments
when trimmed text or a valid attachment remains; otherwise it deletes the stored entry.
Valid means well-formed, deduplicated by path, and passing the image check (in `/tmp` or an
attachments folder, a regular image file of at most 20 MB); the first 8 are kept and the rest are
dropped without failing the save.

## §chat.composer/draft-memory — In-tab draft authority

Within a tab, the in-memory draft for a session path is the authority. A path this tab has loaded
or written is never fetched again. If a fetch completes while the path is still unknown, non-empty
stored text seeds it, and stored attachments are added after this tab's own, skipping duplicate
paths. If this tab wrote the path while the fetch was out, its text wins, and stored attachments
are taken only when the tab holds none. A failed fetch counts as an empty stored draft. Saves are
debounced per path (600 ms) and flushed on unmount and when the page is hidden. A failed save is
silent, and the in-memory draft stays.

## §chat.composer/send — Send and acceptance

Send is possible when the composer is not disabled, no upload is outstanding, and trimmed text or
an attachment remains. It sends the trimmed text with each attachment path appended on its own
line, as a steer while a turn runs and a prompt otherwise. The composer clears only when the chat
accepts the send. The chat accepts when the socket is open and the chat's model is not turned off.
This is a client-side acceptance, not a server acknowledgement. Clearing empties the text and the
pending attachments and schedules the stored-entry deletion. The uploaded files stay.

## §chat.composer/keys — Enter and composition

Enter without Shift sends unless IME composition is in progress. Shift+Enter inserts a newline.
While the slash menu is open with matches, Enter without Shift and Tab insert the active command.
The slash menu stays closed while the whole text is a bare local command, so Enter submits it.
While the @ menu is open with matches, Enter without Shift and Tab insert the active entry. The @
menu has no local-command exception. With either menu open and no matches, Enter sends the text
as typed.

## §chat.composer/restore — Text handed back

Handed-back text goes ahead of the current draft, joined by a blank line. Text returned by Stop,
a rewound message, and a failed or dropped message reach the mounted composer's `restored` input.
That input updates both its text and the draft store. A prompt left unaccepted by a `busy`,
`recent`, or `config` error is written only to the in-memory draft store and its scheduled save. A
composer reads its text from that store only at mount, and again when its initial load resolves
if its text is still untouched and empty. This claim does not assert that an already-mounted
composer shows the prompt. Attachments come back as path text, not as pending attachments. A
failed or dropped message returns only in the tab that sent it. A failed, dropped, or unaccepted
message is handed back at most once per id.

## §chat.composer/slash — Slash token and local commands

A `/` at the start of the text or after whitespace opens a token up to the caret. The token cannot
contain whitespace or another `/`. The menu opens only when the composer is enabled and has
commands. A bare `/agents`, `/subagents`, `/tree`, `/timeline`, or `/new` with no attachments is
handled locally and never sent, if the view offers that action. The draft is cleared, except that
`/new` keeps it when no session was made. All other `/…` text is sent as message text.

## §chat.composer/mentions — @ file completion

An `@` at the start of the text or after whitespace opens a token, and double quotes protect spaces
inside it. The menu needs the session's cwd. Completing a file replaces the whole token with the
plain relative path, without the `@`, quoted if it contains whitespace, and followed by a space.
Completing a directory keeps the `@`, appends `/`, and continues the token. The sent text carries
no mention structure.

## §chat.composer/attachments — Pending image limits

The client accepts PNG, JPEG, GIF, and WebP images up to 5 MB each and at most 8 pending,
counting uploads still in flight. It rejects the rest per file with a reason. Each accepted image
uploads at once into the session's attachments folder and joins the draft when the upload lands.
