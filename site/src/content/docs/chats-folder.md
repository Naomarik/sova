---
title: Where your chats are kept
description: Each new chat keeps everything that is its own in one folder, its home; choose the Chats folder they live in, and know what happens to old archived chats.
group: Features
order: 14.2
---

Each chat Sova starts keeps everything that is its own in one folder, its **home**: its
conversation, its helpers' conversations, its records, its memory and attachments, and its shared
folder. All the homes sit in one **Chats folder**. Chats from before homes stay where they always
were, in pi's sessions folder, and are listed, opened, archived and resumed as before. Nothing
copies or converts them.

## Chat homes

Every new chat gets a home: New Session, Fork from Here, a chat a playbook or the Overseer starts.
Every worker, team member, coordinator and successor it starts writes into that same home.
Organization sessions and the Overseer's own conversation keep their own folders.

A chat with a home has no file in pi's own sessions folder, so `pi -r` and `pi -c` in a terminal
don't list it. In Sova it has the same row, search and marks as any other chat.

Only Sova writes a home's records. Its chat, workers and extensions may read it, and write only in
its shared folder (and an extension in a folder of its own there). A home stays until you delete its
chat: nothing removes one by itself, not archiving, age or a server start. Your own Delete removes
the whole home.

**Chat homes** in Settings → General, under **Chats · this computer**, is on by default. Off, new
chats are stored as before homes. Chats that already have a home stay listed either way, and a flip
applies to the next chat that starts.

## The Chats folder

By default the Chats folder is under `~/.local/state/sova/chats/`, outside pi's agent folder.
**Chats folder** in Settings → General shows where it is now; **Change…** moves every chat with a
home to a folder you pick, such as one you back up.

**Move your chats to this folder?** takes an empty or new folder, or makes a new `sova-chats` folder
inside the one you pick, and shows how many chats, files and bytes move and the free space there. A
folder inside a live-sync service (Dropbox, iCloud Drive, OneDrive, Google Drive, Syncthing) gets a
warning; you can still use it. **Move Chats** starts the move, and its progress shows to the end.

It is refused, with the reason and nothing moved, while any chat or helper is working, while a
background job still runs in the Chats folder, while a Transport, a compression or a Move Back is
under way, or when the folder is inside pi's agent folder, Sova's own state, a repository, or a
folder a sandboxed chat may write, already holds files, can't be written or lacks room.

While it runs, no chat is made or opened, and every chat process is stopped. Each file is copied,
written to disk, read back and checked before Sova switches to the new folder in one step, last.
Until then **Cancel Move** removes the partial copy and changes nothing; a move cut short by a crash
or a restart offers **Resume Move**. After the switch, a chat's next prompt writes in the new
folder, and an old path still opens the chat there. The old folder is kept: removing it is yours.

If the Chats folder goes missing (a backup disk not mounted, say), Settings and the top of the chat
list say so instead of showing a shorter list, and new chats are made as before homes until it is
back. A server whose environment sets the folder (`SOVA_CHAT_HOMES`, as a test copy does) can't
change it in Settings.

Only your own click in Sova's page moves the Chats folder or cancels a move; a chat, a script, an
extension or another computer is refused.

## Old archived chats are compressed

An archived chat last active more than 60 days ago is compressed in the background, a few at a
time. It stays in the Archive with its date, folder, title, model and tags, and its second line reads
**Compressed**. It can still be deleted, but it no longer opens: Sova keeps it only for the record and
reads nothing in it. A chat that is open anywhere, working, or just written is left for the next pass.

**Compress old archived chats** in Settings → General, on by default, turns the automatic pass off.
**Compress** in Clean Up compresses the archived chats of a range, or one archived chat, whatever
their age.

Many chats cost the list little: Sova follows a log of what changed in the homes instead of
checking each one, so a list of thousands of chats reads like a list of a few.
