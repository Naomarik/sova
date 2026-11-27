# §app/chat-homes — Chat homes: one folder for each new chat
> Part of the Sova design spec · [overview](../design/overview.md)

Each chat Sova starts from now on keeps everything that is its own in one folder, its home. That
covers its conversation and every helper's, its records, its helpers' records and its shared
folder. Chats from before stay where they are, and are listed, opened and archived exactly as
today. A home outlives its chat's archiving. Only your own Delete removes it.

## §app.chat-homes/location — Where homes live

- **Where.** A chat's home is `~/.local/state/sova/chats/<key>/<chat id>/`. `<chat id>` is the
  chat's session id. `<key>` is a short hash of the server's state root (`<agent dir>/sova`). So two
  agent dirs never share homes and never list each other's chats, whether the second is a hermetic
  copy, a test run or a second install. The homes folder is never keyed by the home folder (`$HOME`)
  alone.
- **The state root remembers its homes.** The first time a home is made, the state root gets a
  marker file naming its homes folder. From then on the marker says where the homes are, not the
  hash, so moving the agent dir, or naming it another way, still finds the same homes. Each home
  holds a `home.json` naming the state root it belongs to. The list takes only homes whose
  `home.json` names this state root. You choose another folder with **Chats folder** in Settings,
  which moves every home there first (§app.chat-homes/chats-folder).
- **A missing folder is said, never an empty list.** If the marker names a homes folder that is
  missing (a backup disk not mounted, say), the server logs it once, and Settings' Chats folder row
  and the top of the chat list each warn that it is missing (§design.copy-deck/chats-folder), the
  list's empty state hidden meanwhile; the list is never quietly short of those chats. Until that folder is back, new chats are made as before homes, so a new chat
  never starts a second, empty homes folder in its place.
- **An override for test copies.** An absolute `SOVA_CHAT_HOMES` in the server's environment
  replaces `~/.local/state/sova/chats/<key>`, and the chats and workers the server starts inherit
  it. With it set, the Chats folder can't be changed in Settings (§app.chat-homes/chats-folder). A hermetic copy of Sova (`dev:hermetic`) and every test harness set it to a folder of their
  own (§app.server-runtime/test-agent-fence), so none of them ever makes a home in your real state.
- **Outside everything a tool writes.** Homes sit outside the agent dir and outside every
  repository and every writable root a confined agent has (§chat.sandbox/what-on-enforces).
  Nothing in a home shows in a branch or blocks Land.

## §app.chat-homes/layout — What a home holds

```
<home>/
  home.json             the chat's id, its state root, the layout version, the device it began on
  index.json            each of the home's files, marked as a log (only appended) or a document (replaced whole)
  chat/                 meta.json (title, Sova name, alias, tags, group, archive mark, origin) ·
                        seen.json (last seen) ·
                        signals.json (signals, outcomes, worker checks, triage, follow-ups) ·
                        memory/ · attachments/ · cards/ · offers/
  sessions/             <ts>_<id>.jsonl: every conversation of the chat, side by side
  workers/<id>.json     the server's record of each worker
  teams/<lead id>/      the mailbox of the teams the chat, or one of its helpers, leads
  wakes/                wake nudges
  shared/               the chat's shared folder (§chat.sandbox/shared-folder)
  ext/<extension id>/   an extension's own folder for this chat, made at its first write (§app.extensions/reads-chats)
```

- **`sessions/` is flat.** It holds the conversation of the chat itself, and of every worker and
  team member started under it, at any depth, each under pi's own file name. It holds no other file
  ending in `.jsonl`.
- **Records as the stores keep them.** Each file under `chat/` holds, for the chat and for each of its
  helpers, exactly the entries Sova's server-wide stores hold for an older chat, so a home can be put
  back into those stores entry by entry.
- **The unsent draft is not in a home.** A chat's unsent draft stays in Sova's own drafts store, for
  a chat with a home too. It is never carried with the chat, and nothing that reads homes sees it.
- **The chat's records live here, not in Sova's server-wide stores.** For an older chat, these
  records stay in the server-wide stores other claims name, such as `session-titles.json`,
  `archived-sessions.json`, the drafts, seen, tags and signals stores, memory, attachments, offers,
  `chats/workers/`, team mailboxes and wakes. For a chat with a home they are in its home instead.
  Every surface reads and shows them exactly as it does an older chat's.
- **Not in a home.** These stay where they are today, for every chat: Claude Code's own store,
  logins and keys, share and preview links, the machine-wide usage ledger (your time and spend per
  chat), the message labels kept beside each conversation in Sova's state (§app.message-labels/labelling),
  and live records, locks and other runtime state of the host. A Move carries a chat's time and
  labels as its package says (§app.transport/package). The homes folder's own change log and index
  sit beside the homes, in no home (§app.chat-homes/change-log).

## §app.chat-homes/new-chats — New chats get a home; older chats stay where they are

- **Which chats.** Every chat Sova starts from now on gets a home when it starts, while the Chat
  homes switch is on (§app.chat-homes/switch). That covers New Session, Fork from Here, a chat a
  build or a playbook starts, and a chat the Overseer or a command creates. The exceptions keep
  their own folders: organization sessions (batons and project-overseer conversations keep their
  workspace's `sessions/` folder, §app.projects/folder-sessions), and the Overseer's own
  conversation. A new chat whose file can't be written leaves no home behind.
- **Its helpers' conversations go into the same home.** Every worker, team member, coordinator,
  monitor and successor that a chat with a home starts, at any depth, writes its conversation into
  that home's `sessions/`. The server's record of each worker goes to the home's `workers/`, each
  team's mailbox to `teams/`, and each wake nudge to `wakes/`. Workers still run as chat processes
  the server starts and routes (§app.chat-processes/workers). They keep running when their lead
  reloads, crashes or picks up new code, as today. Only their files move.
- **Not in pi's sessions folder.** A chat with a home has no file in pi's per-folder sessions
  folder (`<agent dir>/sessions/--<cwd>--/`). So pi's own terminal resume (`pi -r`, `pi -c`) does not
  list it. That is accepted. The chat's folder (cwd) is still the one it was started in.
- **Older chats never move.** A chat from before homes keeps every file where it is. It is listed,
  opened, archived, forked, deleted and resumed exactly as today, and the workers it starts keep
  writing where its workers always have. Nothing copies, moves or converts it.
- **Listed as one list.** The session list walks pi's sessions folder as before, and also the
  homes. A chat with a home has the same row, regions, order, search and marks as any other chat.
  Its path, wherever a route or a row names one, is its conversation file inside its home, and every
  route that checks a path is a session file (`resolveSessionPath`) takes it.

## §app.chat-homes/sole-writer — Only Sova writes a chat's records

- **One writer.** Only Sova writes a home's files: the server, and the chat processes it runs, for
  the chat's own conversation. `shared/` and the extensions' own `ext/<id>/` folders are the
  exceptions. The chat's own tools, its workers'
  tools and extensions may read anything in a home. They never change a
  record. Titles, tags and the like change only through Sova's own routes and commands.
- **The writable parts.** The chat, its workers and its teams write freely in `shared/`
  (§chat.sandbox/shared-folder). An extension that reads chats writes freely in its own
  `ext/<id>/` and in `shared/` (§app.extensions/reads-chats).
- **How it holds.**
  - A confined agent can't write a home, because every part except `shared/` lies outside its
    writable roots (§chat.sandbox/what-on-enforces).
  - Sova's own guards also refuse a write anywhere in a home except its `shared/`. These are the
    guards that refuse a write into Sova's own state: the Overseer's `write` and `edit`
    (§app.overseer/file-writes), a project overseer's file copy (§app.project-overseer/files), and
    a file offer's destination and archive (§mesh.links/offers).
  - An unconfined chat's commands can reach any of your files, Sova's own state included, as they
    always could (§chat.sandbox/off-is-today).

## §app.chat-homes/lifetime — A home stays until you delete its chat

- **Nothing is deleted on its own.** Nothing removes a home or any file in it by itself. Not
  archiving, a worker or team ending, age, a server start, a Move to another device
  (§app.transport/moved-row), or any automatic cleanup. Compressing an
  old archived chat keeps all of it (§app.session-list/archive-compression).
- **Finished helpers are kept.** A finished worker's record, its conversation and its team's
  mailbox stay in the home for as long as the chat does. They are compressed with it when it is
  compressed. Every worker record a home holds is loaded at server start, before any chat or worker
  is opened, as worker records are today, except the helpers' records of an archived chat: a start
  reads only their names, and reads them whole the first time anything asks about one. Clean Up and
  compression read them all before deciding whether a helper is in use.
- **Your Delete removes the home.** Your own Delete of a chat with a home removes its whole home,
  compressed or not. That covers the chat's own conversation, every helper's conversation and
  record, its mailboxes, wakes, memory, attachments, its shared folder and its extensions' folders. A Delete is Clean Up's
  delete, by age or of one archived session (§app.session-list/archive-cleanup), or archiving an
  empty husk, which deletes it (§app.session-list/archive-org-guard). Before the home goes, the
  chat's time is kept for the usage helper, as for any deleted chat. Everything Clean Up skips or
  refuses today, it skips or refuses for a chat with a home too. Clean Up's deletes by age and of
  empty sessions never match a Moved row, whose home is the safety copy (§app.transport/moved-row).

## §app.chat-homes/switch — The Chat homes switch

- **Where.** Settings → General, **Chats · this computer**, **Chat homes** (§app.settings-dialog/general),
  hint "Each new chat keeps its conversation, its helpers' conversations and its records together in
  a folder of its own. Off, new chats are stored as before. Chats that already have a home stay
  listed either way." It is this computer's, kept by the server in Sova's own settings, and **on by
  default**. A flip saves at once and is not part of any form, so Save Changes neither stages nor
  writes it; a save that fails puts the switch back with a toast.
- **Off.** New chats are made as before homes: the conversation in pi's sessions folder for its
  folder, and its records in Sova's server-wide stores. A helper goes where its parent's place says,
  so the helpers of a chat that has a home still write into that home.
- **Either way.** Chats that already have a home stay listed, open, run and are archived and deleted
  as before; turning the switch off moves nothing and hides nothing. A flip takes effect for the next
  chat that starts, with no restart.
- **Compression has its own switch.** **Compress old archived chats**, beside it, on by default,
  hint "Archived chats older than 60 days are compressed in the background. They stay in the
  Archive, marked Compressed, and can still be deleted, but no longer open." Off turns off only the
  automatic pass (§app.session-list/archive-compression); Compress in Clean Up stays
  (§app.session-list/archive-compress).

## §app.chat-homes/chats-folder — Choosing the Chats folder moves every home there

You can keep your chats in a folder you back up. Changing it moves every chat that has a home
there, safely, and only then switches. Chats from before homes stay in pi's sessions folder and are
not part of it. Its words are in §design.copy-deck/chats-folder.

- **Where.** Settings → General, **Chats · this computer**, a **Chats folder** row
  (§app.settings-dialog/general): the folder homes are in now, and `Change…`. When a variable of
  the server's environment sets the homes folder (`SOVA_CHAT_HOMES`, as a test copy has,
  §app.chat-homes/location), the row is read-only, says which variable and why, and has no
  `Change…`. A move that runs, stopped partway or failed says so on the row.
- **The move dialog.** `Change…` opens **Move your chats to this folder?** with a folder picker that
  starts beside the folder in force. The picked folder is used when it is empty or new; otherwise a
  new `sova-chats` folder inside it. Before you confirm, the dialog shows how many chats, files and
  bytes move and the free space there. A folder inside a live-sync service (Dropbox, iCloud Drive,
  OneDrive, Google Drive, Syncthing, by name or by their own marker files) gets a warning; you can
  still move there. `Move Chats` starts it, and progress shows to its end.
- **Refused, with the reason, nothing moved:** while any chat or helper is working (named), while a
  background job a chat started still runs in the chats folder (named), while a Transport here is
  under way or a chat's compression or a Move Back runs (named), while a variable sets the folder,
  while another move runs; and a folder inside the chats folder or holding it, inside pi's agent
  folder (its sessions folder included) or Sova's own state or holding either, inside a repository
  (where the chats would show as changes; a home folder kept as a dotfiles repository doesn't
  count), inside a folder a confined chat may write (a chat's working folder, the sandbox's writable
  extras and its temporary folder, the Transport agent's tool folders; your home folder itself and
  the folders above it don't count; when Sova can't read which those are, it refuses), a folder
  that already holds files, one Sova can't write, a disk without room for the
  chats, and a chats folder that is missing.
- **Only your own click.** The move and its Cancel run only from Sova's own page, by your click
  (§app.access/your-click): a token, a chat, an extension or a paired device is refused.
- **Everything stops first.** Once it starts, until it ends, no chat is made or opened, and no
  compression, Move Back or new Transport starts: each is refused with "Your chats are moving to
  {folder}. Chats open again when the move is done." A wake that comes due waits, spending no try.
  Every chat process is stopped, idle ones and helpers included, as a Move's switch stops them
  (§app.transport/switch), with every extension program that reads chats
  (§app.extensions/reads-chats).
- **The whole folder, checked.** Every home moves, and every compressed archived chat beside them
  (§app.session-list/archive-compression), empty folders included; the homes folder's change log
  and index stay behind and are rebuilt there (§app.chat-homes/change-log). A Transport's staging
  folders and the compressed copies a returning chat moved aside, beside the old folder, stay with
  it. Each file is copied, written to disk, read back and checked by its
  hash, keeping its mode and times. The records that name the old folder (helpers' records, team
  and wake records, a home's own records, the conversations' headers) are pointed at the new one,
  and at the switch so are the records in Sova's state that name a chat's file here: shares,
  background jobs, wakes, the markers that resume a chat after a crash, the compressed chats'
  records, the Transport agents' record, and in Transport's records this device's chat paths only.
  A conversation's messages are never changed. The copy is journalled: a move cut short by a crash
  or a restart shows `Resume Move`, which goes on from the files already checked.
- **The switch, last.** Only when every file is checked, and the copy and its folders are on the
  disk, does Sova point the state root's marker at the new folder, in one step, remembering the
  folders it was in before. It then reads and watches the new folder: the list shows every moved
  chat once, a new chat starts there, a chat's next prompt writes there, and the stopped programs
  start again. A path under an old folder (an open tab's, an attachment a conversation names) reads
  as the same file in the new one, and opening a chat by such a path opens it in the new folder,
  never the copy left behind. A start that finds the marker already switched finishes the move.
  Until the switch, `Cancel Move` stops it: the partial copy is removed and Sova stays on the old
  folder. A move that fails before the switch removes its partial copy the same way, and says why.
- **The old folder is kept.** Nothing is deleted from it: removing it is yours.

## §app.chat-homes/change-log — The homes folder keeps a change log and an index

Many chats cost the list no more than a few: Sova follows a log of what changed in the homes
instead of checking every home, and keeps an index of them built from it. The homes stay the truth;
the log and index only make reading them cheap.

- **One line per change.** Every write to a home's records, conversations or helpers' records
  (archiving, unarchiving, a rename or Regenerate Title among them), and every home that arrives, is
  deleted or is compressed, adds one line to the homes folder's change log: which home,
  what changed, and its new generation. Lines are only appended, to numbered files
  (`<homes folder>/.changes.<n>.log`); a file is never rewritten or cut short. The log goes on in the
  next file once one reaches 1 MiB, and a file the index has long passed is removed whole. Readers
  follow it from where they last read, once a second at most, in one read whatever the number of
  homes, and look again only at the homes a line names.
- **An index beside it.** `<homes folder>/.index.json` holds each home's conversation files and how
  far the log it covers goes, and is replaced whole in one step, at most every 10 seconds. A
  missing, cut-short or unknown index is rebuilt by one walk of the homes.
- **The log is a hint.** A sweep of the active chats' homes, every 5 minutes and shortly after a
  start that began from the index, still finds a change no line names, so such a change shows late,
  never lost. Archived chats are never swept or polled: their records are read once at start, for
  the list's titles, then only from their lines, and every change to one goes through Sova, which
  logs it. Only when lines may have gone by
  unread (a log file removed before a reader finished it), or the index is missing, cut short or
  unknown, does Sova read every home once, archived ones too.
- **Costs that don't grow with every chat.** Reading the list or a record no longer looks at every
  home each second. A new or changed chat makes Sova read again only that home's open cards, offers
  and records, never every home's. The list's full build takes the homes' conversation files from
  the index, and reads a home's folder again only when a line names it or the folder watch saw a
  file come or go there. A folder in the homes folder that isn't a home is remembered as such until
  a line, an arrival or the sweep says otherwise.
- **This device's only.** The log and index never travel with a chat (§app.transport/package), are
  left behind by a Chats folder move (§app.chat-homes/chats-folder) and rebuilt in the new folder,
  and are rebuilt from the homes wherever they are missing.
- **Measured at landing.** A speed test of 5,000 chats, 1,000 of them active and the rest archived,
  with budgets on what reading them costs, runs among the landing checks when the homes code changes
  (§app.server-runtime/slow-groups, **Many chats**).
