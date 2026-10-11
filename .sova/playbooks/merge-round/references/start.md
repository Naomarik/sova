# Merge round: start

Read this at the start of every round. Paths here are relative to the playbook's folder (`references/` is beside `PLAYBOOK.md`).

## Start
`round.mjs start`. On a session's **first round** it says so: ask the user one short set of questions about what must never reach the public repo (servers and their IPs, domain names, hostnames or tailnet names, API or odd encryption keys, client or person names, anything else).
- Settings missing: run `node scripts/discover-names.mjs`, add the answers, then `round.mjs names-answered`. Until then the push hold is on: merge locally, push nothing.
- Settings present: run it with `--show` and show the list in this chat only (never in a commit, a file or another session); ask whether it is right.
- Add answers with `--add-kind <kind> --add <value>`, or `--add-file <file>` (one `<kind>: <value>` per line; delete the file after). Never repeat a name outside the interview.
The list is the user's: drop a name from it (a false positive, or a name the user says may be public) only on their word, after copying the settings file aside as a backup, and rescan.
Later rounds run `discover-names.mjs` without `--show`.
Every round, call `queue_open` with name `merge`: it returns this session's topic (for example `merge-k7m4qz`), the same one each round while this session lives. Owners answer on it. A session can push to it only after a `session_send` from you names it: tell any session that needs to reach you (one you didn't ask, or one that says it can't reply) that way, and never open a second topic for it. You can't push to your own topic: answer with `session_send`.

