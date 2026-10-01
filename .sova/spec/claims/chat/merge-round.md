# §chat/merge-round — The merge round
> Part of the Sova design spec · [overview](../design/overview.md)

Sova's own repository ships one scheduled playbook, **Merge round** (`.sova/playbooks/merge-round/`),
run by the project profile **Merge captain** (`.sova/profiles/merge-captain.json`, One at a time)
every 30 minutes and after a Claude limit resets (§chat/schedules). A round finds finished branches,
checks each one, lands it on master, pushes it and restarts the live server when that is safe. The
playbook is instructions to a model: what it promises is what it tells the captain to do, and what
its two scripts, `discover-names.mjs` and `leak-scan.mjs` (Node builtins only), do.

## §chat.merge-round/round — What one round does

- **Settings and the start interview.** Local settings are `<state root>/merge-round.json`, one per
  machine and never committed. On the first round of a new captain session (it reads its own
  transcript to tell) the captain asks the user one short set of questions about what must never
  reach the public repo: servers and their IPs, domain names, hostnames or tailnet names, API or
  encryption keys, client or person names, anything else. With no file, it builds one from the
  answers plus `discover-names.mjs`; with one, it shows the current list back in the local chat
  (never in a commit) and asks whether it is right, then adds what the user says. Answers go in
  through the script. Later rounds in the same session don't ask again.
- **The push hold.** When the file was missing at the session's first round, the round may merge
  locally but pushes nothing until the user has answered, even once the script has made the file.
  When it existed, the round pushes with it, and adds the answers when they arrive. Names the script discovers apply at once; the first round's report gives their kinds,
  their counts, and which of them origin already has in public (masked).
- **Intake.** A branch reaches the queue from the user, the Overseer or a session's message, in the
  order given.
- **The poll.** Each round also reads, for every session `session_list` shows, its `session_detail`
  worktree lines (`Worktree <branch>: Ready to merge …` or `… Waiting for your OK …`), the Ready to
  merge chip's own rule set (§chat.worktrees/readiness). The owner of a branch is the session whose
  detail lists it, never a guess from session files. A branch ahead of master that no session
  reports is listed as **unowned** and never merged on the captain's own say.
- **Verify.** The chip can be wrong (it doesn't know intent, and its checks-passed isn't tied to
  the branch's head), so before accepting a branch the captain reads the owner's transcript
  (`session_read`) and the git state: commits ahead, a clean tree (the sandbox tests' own output
  apart), no TEMP, WIP, `fixup!` or `squash!` subject, and no open alignment questions.
- **Asking the owner.** Unsure, and only when the owner session and all its workers are idle, the
  captain asks it with `session_send` whether the branch is ready, for a reply of `READY <branch>
  <sha>` or `NOT READY: <why>`, and reads the reply about 30 seconds later or on a later round. It
  never asks a busy session. "Waiting for your OK" means ask, never merge. A branch its owner
  confirms at the head it reports, and that passes every check, merges without asking the user.
- **Each branch** is merged with master in its worktree, checked (typecheck, tests with timeouts
  near their baseline, each touched pi-config extension's suite, build; a failure that also fails
  on master is named as pre-existing), its drafts promoted, then landed with `worktree merge` and
  built in the main checkout.
- **Push.** `leak-scan.mjs` runs before every push; any hit means push nothing and report the
  commit, file and line, never the matched value. Never `--force`, `--tags` or `--all`.
- **Restart** as before: only when every hosted session is idle, scheduled outside the server with
  `systemd-run` as the turn's last call, and confirmed on the next round.
- **Always the user's call:** rewriting unpushed commits to scrub a hit, names origin already has in
  public, a restart while sessions are busy, and any deploy to a peer.
- **The report** each round: shas merged, push result, spec check, restart state (with the busy
  list), unowned branches, owners asked and their answers, anything handed back and why.

## §chat.merge-round/private-names — Finding the private names, and the leak scan

- **`discover-names.mjs`** collects candidates by kind from this machine: the hostname and home
  path; `tailscale status --json` (host and DNS names, the tailnet suffix, IPs), skipped silently
  when it can't run; `host.json`, `peers.json` and `mesh-extensions.json` under the state root;
  device names in `<agent dir>/claude-accounts.json`; login emails and git's `user.email`, each as
  the address and its domain unless that domain is a public mail provider; `orgs.json` names; and
  the values in the repo's `scripts/mesh-vps/local.env` when present, except those its tracked
  `local.env.example` also has. The agent dir is
  `PI_CODING_AGENT_DIR` (with `~` expanded) or `~/.pi/agent`; the state root is its `sova/`.
- **Dropped:** the owner and repository in origin's GitHub URL, anything under 4 characters,
  generic words (`localhost`, `laptop`, `default` and the like), loopback and documentation IPs, and
  generic path prefixes such as `/home`. A discovered term already in more than 10 of origin/master's
  tracked files is too common to block on: it is dropped as **common**, counted like the others,
  and never listed as already public. The user's own names are never dropped; one that common is
  kept with a masked warning (its kind and index), and so is a name the file already holds that has
  become that common, which stays in the list.
- **Additive.** It merges into `merge-round.json` (mode 0600) and never removes a name. It keeps
  `privateNames` a flat list, adds each name's kind, counts names by kind as `sources`, and sets
  `restartUnit` to `sova-runtime.service` when absent. The user's own names go in with `--add-kind
  <kind> --add <value>` (repeatable) or `--add-file`; `--dry-run` writes nothing.
- **Never printed.** It prints kinds and counts only, and which names origin/master's tracked files
  already contain, each by its kind and index with at most 5 files (then "+N more") and the name
  masked in every path. Only `--show`, which the captain
  uses to show the list to the user in the interview, prints the values.
- **`leak-scan.mjs`** checks `origin/master..master` (added diff lines, commit messages, added file
  names) for secrets and the private names, and prints each hit's commit, file and line and the
  name's line in the settings file, never the name. It fails closed (exit 2) without the file or
  with no names.
