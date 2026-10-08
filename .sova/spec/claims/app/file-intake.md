# §app/file-intake — Files from people: what a project keeps, where, and for how long
> Part of the Sova design spec · [overview](../design/overview.md)

A project can receive files from people: a gathering session with file intake on
(§app.baton/files) lets the person chatting attach any file on the share page, its model examines
it with them, and the project overseer and the operator take it from there
(§app.project-overseer/files, §app.organizations/files-card). Copy: §design.copy-deck/gathering-files.

- **Kept per project**, placed in an organization or standalone alike. The bytes are host-local,
  never in the workspace repo, never mesh-synced and never pushed: one folder per file,
  `<stateRoot>/project-files/<projectId>/<fileId>/<name>` (folders 0700, the file 0600, created
  O_EXCL), streamed to a `.part` file while a SHA-256 is computed, then linked into place under
  its kept name (a name already there is never overwritten) and the `.part` removed. A file id is
  `f_` and 16 random base64url characters.
- **The ledger** is `files.jsonl` in the project's overseer folder (`projects/<projectId>/overseer/`,
  beside `overseer.json`), only ever appended to: one `received` line per file `{v: 1, id, name,
  size, type, kind, sha256, personId, sessionId, at, status: "received"}` (`type` the type the
  page declared, else `application/octet-stream`; `kind` the sniffed label; `sessionId` the
  gathering session), and later status lines `{v: 1, id, status: "confirmed" | "deleted", at,
  by, note?}`; the newest status wins. It never holds bytes, contents, tokens or a link. A
  restored org has the ledger without the bytes: such a file lists as "not on this host" and
  can't be copied or downloaded there.
- **Names.** The page sends the file's name (percent-encoded, `X-File-Name`); the host keeps only
  its last path segment (after `/` or `\`), drops control characters, leading dots and spaces, cuts it
  to 120 characters keeping its extension, and names it `file` when nothing is left. Two files of
  one gathering session never share a name: a later one becomes `name (2).ext`, `name (3).ext`, ….
- **Kind.** The first bytes name the kind only, to label it ("zip archive", "gzip archive", "tar
  archive", "PDF document", "PNG image", "JPEG image", "GIF image", "WebP image", "JSON",
  "CSV text", "text", "binary file"); nothing is refused for its type.
- **Caps.** One file is at most the host's largest file setting (Settings → Organizations,
  §app.settings-dialog/organizations: 1–25 MB, default 25). Per person in one gathering session, at
  most 20 files and 200 MB, staged, received and still uploading together. The host keeps at most
  10 GB of files and takes none while its disk has under 2 GB free (`SOVA_PROJECT_FILES_MAX_MB`,
  `SOVA_PROJECT_FILES_FREE_MB`). An upload counts from before its first byte: its declared size and
  one file slot are reserved for its session and person, and its size in the host's total, in the
  same step that checks them, so uploads sent at once can't pass the caps together; the
  reservation ends when the upload does (kept, refused or cut off).
- **Staged, then received.** An upload is staged (its folder holds a hidden `.meta.json` with
  its session, person, time, name, size, type, kind and SHA-256, and no ledger line) until a
  message sends it; it is then received: its ledger line is written. A staged file that no
  message sent within 24 hours, or whose session is no longer open, is removed by the sweep (every
  10 minutes, and once when the share app starts), as is a folder an interrupted upload left with
  neither a sidecar nor a ledger line, after an hour.
- **Retention.** A received file is kept until the operator deletes it (the Files card's Delete,
  or the project overseer's `sova_files delete` in a turn the operator started): a `deleted` line
  is written and its bytes go; its transcript line stays. Closing or archiving the gathering
  session, or the project, deletes nothing.
- **Who reaches the bytes.** Only: the gathering session's own model through `inspect_files`
  (§app.baton/files), the operator's download on the main listener (§app.organizations/files-card),
  and a copy into one of the project's coding sessions' worktrees (§app.project-overseer/files).
  The share listener only takes uploads: no route of it reads a file back, and a person's page
  shows a sent file's name and size, never a link to it.
