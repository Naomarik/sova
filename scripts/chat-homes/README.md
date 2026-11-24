# Backup and rollback for chat homes

Two commands, run from a Sova checkout with Node (no install needed: Node's built-ins and the
system's `tar` only). Both act on the install the environment names, as the server does:

- the agent dir: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`;
- the chat homes: `$SOVA_CHAT_HOMES` (absolute), else the folder `<agent dir>/sova/chat-homes.json`
  names, else `~/.local/state/sova/chats/<12 hex of the state root's hash>`;
- the older chats' shared folders: `$SOVA_SHARED_BASE` (absolute), else `~/.local/state/sova/shared`.

Stop Sova (and any pi TUI on that agent dir) first: both refuse while a live record names a
running process.

## Backup

```sh
node scripts/chat-homes/backup.mjs [--out <folder>]
```

Writes `<out>/<timestamp>/` (default `$XDG_STATE_HOME/sova/backups`, else
`~/.local/state/sova/backups`), mode 0700:

| file | what |
|---|---|
| `agent.tar.gz` | the whole agent dir: every conversation, Sova's state and settings, logins (live records left out) |
| `homes.tar.gz` | every chat home, compressed ones included (when there are homes) |
| `shared.tar.gz` | the older chats' shared folders (when there are any) |
| `backup.json` | where each came from, its sha256, size and entry count, the Sova commit and branch, counts of conversations, homes and compressed chats |

It prints the folder. Each archive is listed back after it is written.

## Rollback

```sh
node scripts/chat-homes/rollback.mjs [--dry-run] [--no-backup] [--backup-out <folder>]
```

Puts the install back in master's layout, keeping every chat, the ones made on the branch included:

1. takes a backup first (as above), unless `--no-backup`;
2. undoes archive compression: each `<file>.jsonl.gz` back to `<file>.jsonl` and each compressed
   home (`<homes>/<id>.tar.gz`) unpacked into its folder, every file checked against the sha256
   recorded when it was compressed (`<agent dir>/sova/compressed-sessions.json`, and each home's
   `<id>.compressed.json` when that store is gone);
3. moves each homed chat's conversations, its workers' and team members' included, into
   `<agent dir>/sessions/--<cwd>--/` by each file's own header `cwd`, beside the chats already there;
4. merges each home's records into master's stores (titles, names, aliases, tags, groups, archive
   mark, web sessions, seen, drafts at 0600, signals, outcomes, checks, triage, follow-ups), creating a
   missing store with the version master's loader needs;
5. moves attachments, memory, cards, offers, worker records, team mailboxes, wake nudges and the
   shared folder to master's places, and rewrites every path that named the home (in the moved
   conversations, worker records, wake nudges and Sova's other JSON stores) to the new place; worker
   records lose `SOVA_CHAT_HOME`;
6. moves each emptied home to `<homes>/.rolled-back/<id>`. Nothing is deleted.

`--dry-run` says what it would do and changes nothing. A problem (a compressed file that is missing
or doesn't match) is printed as `PROBLEM:`, that chat is left as it was, and the exit code is 2.

Then run master's code: `git -C <checkout> switch master` (or your install's update) and restart Sova.

### Back to a backup exactly

```sh
node scripts/chat-homes/rollback.mjs --from-backup <backup folder>
```

Checks every archive against backup.json, moves what is there now aside to
`<path>.before-restore-<timestamp>` (the agent dir, the homes, the shared folders), and unpacks the
backup in their place. Chats made since the backup are in the moved-aside folders.

## What it does not cover

- Claude Code's own store (`~/.claude`) and its logins are never touched by chat homes, so neither
  command takes them.
- A Claude Code chat started on the branch names its logins by id in its hidden login entries. On
  master the chat keeps its login (master reads the id), but its login-switch notes don't show.
  The conversation files are never rewritten for this.
