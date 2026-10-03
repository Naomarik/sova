# §chat/merge-round — The merge round
> Part of the Sova design spec · [overview](../design/overview.md)

Sova's own repository ships one scheduled playbook, **Merge round** (`.sova/playbooks/merge-round/`),
run by the project profile **Merge captain** (`.sova/profiles/merge-captain.json`, One at a time)
every 30 minutes and after a Claude limit resets (§chat/schedules). A round finds finished branches,
checks each one, lands it on master, removes its worktree when git allows it, pushes it and
restarts the live server when that is safe. The
playbook is instructions to a model: what it promises is what it tells the captain to do, and what
its scripts in `scripts/` (Node builtins only) do: the driver `round.mjs` (§chat.merge-round/driver),
`discover-names.mjs` and `leak-scan.mjs`, with their tests in `tests/` (§chat.playbooks/bundles).

## §chat.merge-round/round — What one round does

The captain takes each step through the driver (§chat.merge-round/driver) and makes the judgement
calls itself: whether a branch's intent is finished, whether its owner has open questions, whom to
ask, and what to tell the user.

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
  merge chip's own rule set (§chat.worktrees/readiness), and records what it read with the driver's
  `note`. The owner of a branch is the session whose detail lists it, never a guess from session
  files. A branch ahead of master that no session reports is listed as **unowned** and never merged
  on the captain's own say.
- **Verify.** The chip can be wrong (it doesn't know intent, and its checks-passed isn't tied to
  the branch's head), so before accepting a branch the captain reads the owner's transcript
  (`session_read`) and the git state: commits ahead, a clean tree (the sandbox tests' own output
  apart), no TEMP, WIP, `fixup!`, `squash!` or `amend!` subject, and no open alignment questions.
- **Asking the owner.** Every round the captain calls `queue_open` with `merge`, which gives it its
  own topic, the same one each round while the session lives (§chat.topics/open). Unsure, and only
  when the owner session and all its workers are idle, the captain asks it with `session_send`
  whether the branch is ready at its current head, for an answer pushed to that topic with
  `queue_push`: `READY <branch> <sha>` or `NOT READY: <why>`. It doesn't poll: the answer arrives as
  a batch when the captain's turn ends or it is idle (§chat.topics/delivery). It asks through the
  driver's `ask` and pipes that batch into its `reply`. It never asks a busy session. "Waiting for
  your OK" means ask, never merge. A branch its owner confirms at the head it reports, and that
  passes every check, merges without asking the user.
- **Each branch** is merged with master in its worktree, checked (typecheck, tests with timeouts
  near their baseline, each touched pi-config extension's suite, build; a failure that also fails
  on master is named as pre-existing), its drafts promoted, then landed with `worktree merge` and
  built in the main checkout.
- **Clean up.** Once a branch is landed, the captain removes its worktree from the main checkout
  with exactly the two commands `landed` prints: `git worktree remove -- <path>`, never `--force`,
  then `git branch -d -- <branch>`. Git's own refusals (uncommitted or untracked files, a lock, a
  branch git doesn't find merged) are reported as printed and never retried or forced, and the
  folder then stays. The owner's notice says "Its worktree folder was removed." only when the
  remove succeeded. No tool or grant does this: it is plain git, and the owner's readiness reads
  the gone folder as merged from git (§chat.worktrees/readiness).
- **Push.** Through the driver's `push`: `leak-scan.mjs` runs before every push; any hit means push
  nothing and report the commit, file and line, never the matched value. Never `--force`, `--tags`
  or `--all`.
- **Restart** as before: only when every hosted session is idle, scheduled outside the server with
  `systemd-run` as the turn's last call, and confirmed on the next round.
- **Always the user's call:** rewriting unpushed commits to scrub a hit, names origin already has in
  public, a restart while sessions are busy, and any deploy to a peer.
- **Never:** force-push or rewrite pushed history; `filter-branch`, `read-tree` or `update-ref` on
  master; a private name written inline in a command.
- **The report** each round: shas merged, push result, spec check, restart state (with the busy
  list), unowned branches, owners asked and their answers, anything handed back and why.

## §chat.merge-round/driver — The round's driver

`scripts/round.mjs` (Node builtins only) does the round's mechanical steps. The captain still picks
each next step, and every command ends with a `next:` line naming the likely one. Its state is one
small file, `<state root>/playbooks/merge-round/state.json` (mode 0600, written by atomic rename),
with each check's logs in `logs/` beside it. Output is a compact digest, or JSON with `--json`.
Exits follow the bundle convention (§chat.playbooks/bundles): 0 go, 1 something to act on or
decide, 2 couldn't tell, which fails closed. Every git and child process runs by argv, with no
shell and under a timeout.

- **Never a private name.** Every line it prints, and everything in its state file, has each name
  in `merge-round.json` masked; the logs are the checks' own output, kept on this machine and never
  printed. It prints no value from that file, except the restart unit, and that only when it is a
  plain unit name holding no private name.
- **It never reads sessions.** The session tools stay the only way to read them: the captain
  records what it read with `note <branch> owner=<id> chip=ready|waiting|none idle=yes|no
  [source=<word>]`. Its only HTTP is `GET /api/health`, best effort, to confirm a restart.
- **`start`** knows this session's first round by `PI_SESSION_ID`: it says whether to run the start
  interview, turns the push hold on when the settings file is missing at that first round, and says
  whether a pending restart has happened (the server's `startedAt` after the merge, and its `head`
  at master). **`names-answered`** lifts the hold once the user has answered.
- **`status`** lists every local branch ahead of master that has a worktree: ahead and behind,
  uncommitted files (the sandbox tests' `FIRST-RUN.txt` and `NAIVE-RUN.txt` apart), a TEMP, WIP,
  `fixup!`, `squash!` or `amend!` subject, how many files a trial merge with master conflicts in
  (`git merge-tree --write-tree` into a throwaway object directory, so the repository is never
  written), the last commit's age, the recorded owner and ask, and whether landing it needs a
  restart (§chat.worktrees/readiness's rule). A branch with no recorded owner is flagged unowned. It
  also says whether the main checkout is on master, how many files are dirty there, and how far it
  is from origin/master.
- **`ask <branch> topic=<name>`** needs the name `queue_open` gave the round's topic (a bare base
  name is refused), and refuses an owner not recorded idle, a note older than 15 minutes, and an
  owner asked in the last 10 minutes. Otherwise it records the topic with the ask and prints the text
  to `session_send`: `Is <branch> ready to merge at its current head? Reply with queue_push, topic
  "<name>", text one line: READY <branch> <the head sha you checked>, or NOT READY: <why>.`, which
  never holds the head's sha, and its `next:` line says not to poll. **`reply <branch>`** reads the
  delivered topic batches on stdin (§chat.topics/delivery) — every batch piped, when several arrive
  together — or the owner's `session_read` output. A batch is read only against a recorded ask:
  with none, it is refused. When no piped batch is on the ask's topic the answer is refused as
  another topic's; in the batches that are, only the notes whose sender is the recorded owner count,
  as the server framed them, so another session's READY never does. A note counts once and only for
  the current ask: one stamped before the ask, or before the note the recorded answer came from,
  doesn't count, and the ids of the notes already read are kept in the state, so a batch piped again
  (a reused topic, the same head) or an older batch after a newer answer changes nothing. A
  transcript of another session is refused, and in it only the owner's own reply rows (`ASSISTANT:`)
  count. Either way it accepts only a whole line `READY <branch> <sha>`, whose sha (7 or more
  characters) begins the branch's current head, or `NOT READY: <why>`. Any other sha is **stale**;
  nothing else is an answer, so an echoed ask or a line elsewhere never counts.
- **`check <branch>`** refuses a branch with no worktree, no commit ahead, uncommitted files or a
  TEMP-style subject. It merges master into the branch in its worktree, never on master. On
  conflicts it stops and leaves them to the captain, except that a conflicting
  `.sova/spec/manifest.json` first goes through the spec tool's `merge-manifest --write`. It then
  runs the typecheck, `pnpm test` without `CLAUDE_CONFIG_DIR`, each touched pi-config extension's
  line from `pi-config/README.md`'s Tests block, and the build, each in its own process group,
  killed whole at its timeout (the larger of a floor and twice the median of its earlier passing
  runs); then the spec tool's `check`, `census --changed --base master`, and each draft's status. A
  test file that fails is run again on master, in the main checkout at master's sha (refused when
  that file is dirty there), cached per master sha and file: one that fails there too is named
  pre-existing and doesn't block. The verdict, `landable at <sha>` or `needs: …`, is recorded
  against the branch's head and master's sha.
- **`land <branch>`** never merges. With a landable check at the current head and the current
  master, it prints the `worktree` tool's merge call; a moved head or master means check again.
  **`landed <branch>`** verifies with git that the checked head is in master, builds the main
  checkout, records whether a restart is needed, and prints the notice for the owner, with the
  sentence "Its worktree folder was removed." to add only when the clean-up's remove succeeds.
  Its `next:` line is the clean-up: `git -C <main checkout> worktree remove -- <path>`, then `git -C
  <main checkout> branch -d -- <branch>`, then `push`. When git's record of that worktree can't
  be written from where the driver runs (a sandboxed captain), it prints instead that the clean-up
  can't run here and leaves the folder, so git never half-removes a tree it can't unregister.
- **`push`** refuses under the hold, when the main checkout isn't on master, and when master isn't a
  fast-forward of origin/master after a fetch. It runs `leak-scan.mjs` and, only when that exits 0,
  runs exactly `git push origin master`. It has no force, tags or all path.
- **`restart-check`** reads the live records (`<agent dir>/sessions/live/`) of the server it runs
  under, found through its process ancestry, else as the restart unit's main pid; only records whose
  heartbeat is at most 30 seconds old count, and its own session's is left out. A session is busy
  when a worker is working or its turn is in flight. Exit 0 means every one is idle, and only then
  does it print the `systemd-run --user --on-active=30s systemctl --user restart <unit>` line; 1
  lists the busy ones; 2 means it found no server or none of its records. It never schedules or runs
  a restart itself.
- **`report`** prints the round report's skeleton from the state.

The two rules it shares with the server, which subjects are temporary and which changed files need a
restart, are copies, held equal to `server/merge-readiness.ts`'s by a test over an enumerated table;
so are the topic batch's format and the topic name's rule, held equal to `shared/topic-message.ts`'s.

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
