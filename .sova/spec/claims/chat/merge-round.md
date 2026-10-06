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
ask, and what to tell the user. It starts each round from what is there, never from memory: the
driver's `status`, what master has that origin/master doesn't, any local `backstop/*` branch a scrub
left, the owners' sessions and the user. It lands one branch at a time and goes back to `status`
after each landing, since every other branch is then checked against the new master.

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
  files, recorded by its full session id. A branch ahead of master that no session reports is listed
  as **unowned** and never merged on the captain's own say: the user naming a branch to land is
  that say, and counts as its owner's READY. Commits on master the captain didn't land (an owner's
  own merge) get typecheck, tests, build and census before they are pushed.
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
  passes every check, merges without asking the user. Notes arrive only between turns, so the
  captain reads the owner again just before landing; a hold that arrives after a landing is
  reported to the owner and the user, never undone. A session that needs to reach the captain is
  told the topic's name by `session_send`, never given a second topic; the captain itself answers
  with `session_send`, since it can't push to its own topic.
- **Each branch** is merged with master in its worktree, checked (typecheck, tests with timeouts
  near their baseline, each touched pi-config extension's suite, build; a failure that also fails
  on master is named as pre-existing; a new failing file that passes alone twice with the suite's
  runner is named flaky and doesn't hold the branch; an extension suite failing the same way on
  master is master's), leak-scanned over the commits landing would publish, its drafts promoted,
  then landed with `worktree merge` and built in the main checkout. A step that fails in no time
  didn't run, and its log is read. A branch its owner already merged goes straight to `landed`. A
  branch with a leak in its history, or a commit a scrub cut out of master, never merges: its owner
  re-applies the change on a fresh branch. The owner's worktree stays theirs: uncommitted files go
  back to the owner, and the captain parks them outside the repo only with the owner's OK and
  restores them byte for byte; a symlinked `node_modules` is environment, which it may rebuild and
  report.
- **Drafts.** The owner promotes its branch's drafts before the landing; records the landing's own
  draft still leaves pending, the captain promotes on master, with evidence by the owner in the
  owner's own verification words and never more. Another session's draft is never the captain's
  to promote. After a landing the census of record is `census --changed --base <master before
  it>`. A turn that landed or promoted ends with the `Also changes:` line copying the foreign §
  list the merge or promote printed; a push-only or answer-only turn has none.
- **Clean up.** Once a branch is landed and its owner is done with the worktree, the captain removes its worktree from the main checkout
  with exactly the two commands `landed` prints: `git worktree remove -- <path>`, never `--force`,
  then `git branch -d -- <branch>`. Git's own refusals (uncommitted or untracked files, a lock, a
  branch git doesn't find merged) are reported as printed and never retried or forced, and the
  folder then stays. The owner's notice says "Its worktree folder was removed." only when the
  remove succeeded. No tool or grant does this: it is plain git, and the owner's readiness reads
  the gone folder as merged from git (§chat.worktrees/readiness).
- **Push.** Through the driver's `push`: `leak-scan.mjs` runs before every push, and over a
  branch's own unpublished commits before it lands; any hit means push (or land) nothing and report
  the commit, file and line, never the matched value. A hit the user waives, asked again each time
  it recurs, is pushed by hand for that push only and named as waived in the report. Never
  `--force`, `--tags` or `--all`.
- **Restart** when the live server's head lacks master's runtime code, whoever merged it: only when
  every hosted session is idle, scheduled outside the server with `systemd-run` as the turn's last
  call, and confirmed on the next round with the head it came back on. A restart another session
  has claimed (its workers deploying) is left to it.
- **Always the user's call:** rewriting unpushed master to scrub a hit, each case (the old head kept
  first as a local `backstop/<what>-<sha>` branch; master made one new commit of the intended tree on
  origin/master with `commit-tree` and `update-ref`; proved a fast-forward of origin/master whose
  diff from the old head is only the intended change, with no scrubbed commit reachable and the
  leak scan, typecheck, build and census passing; the leak's branch never merged again; the backstop
  deleted when the user says). A branch is never scrubbed. Also the user's: waiving a hit, each
  time it recurs; names origin already has in public; a restart while sessions are busy; any deploy
  to a peer; landing an unowned or unconfirmed branch. Everything else, a branch its owner calls
  ready and checked green, lands and pushes without asking.
- **Never:** force-push or rewrite pushed history; `filter-branch` or `read-tree` on master, or
  `update-ref` on it outside a scrub the user approved for that case; a private name written inline
  in a command; another session's project instance touched, or its worktree changed beyond the
  check's master merge (and a rebuilt `node_modules`), without its OK.
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
  plain unit name holding no private name. A local path under the home directory is printed as
  `~/…`, and as `"$HOME"/…` in a command it prints, so the home path never shows and the path still
  works; a path that holds a private name beyond that home prefix is refused, never printed.
- **It never reads sessions.** The session tools stay the only way to read them: the captain
  records what it read with `note <branch> owner=<id> chip=ready|waiting|none idle=yes|no
  [source=<word>]`. Its only HTTP is `GET /api/health`, best effort, to read the head the live
  server started at.
- **The restart need** is the live server's `head` from `GET /api/health` against master: a
  restart is needed when a file that needs one (§chat.worktrees/readiness's rule) differs between
  them, so a branch its owner merged without the round counts as much as one `landed` recorded.
  When the health can't be read, or names no commit this repository has, it can't be told.
- **`start`** knows this session's first round by `PI_SESSION_ID`: it says whether to run the start
  interview, turns the push hold on when the settings file is missing at that first round, and says
  whether a restart is needed: one pending is confirmed once the restart need is none, and a need
  it finds is recorded as pending. **`names-answered`** lifts the hold once the user has answered.
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
  pre-existing and doesn't block. It also runs `leak-scan.mjs` over the commits landing would
  publish (origin/master to the branch's head): a hit is a need, printed as the scan prints it; a
  scan that can't run is said and doesn't block, since `push` scans again. The verdict, `landable at
  <sha>` or `needs: …`, is recorded against the branch's head and master's sha.
- **`land <branch>`** never merges. With a landable check at the current head and the current
  master, it runs the same leak scan again and, only when it finds no hit, prints the `worktree`
  tool's merge call; a moved head or master means check again.
  **`landed <branch>`** verifies with git that the branch's head is in master, however it got there
  (a branch its owner merged has no check on record), builds the main checkout, records the restart
  need (one that can't be told counts as needed), and prints the notice for the owner, with the
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
  lists the busy ones; 2 means it found no server or none of its records. It works out the restart
  need first, as `start` does, and prints the line only when one is needed, or pending and it can't
  tell. It never schedules or runs a restart itself.
- **`report`** prints the round report's skeleton from the state.

The two rules it shares with the server, which subjects are temporary and which changed files need a
restart, are copies, held equal to `server/merge-readiness.ts`'s by a test over an enumerated table;
so are the topic batch's format and the topic name's rule, held equal to `shared/topic-message.ts`'s.

## §chat.merge-round/landing-suites — Extension suites and the spec replay at landing

`check`'s extension suites run at lowered CPU priority, so a landing never starves the live server
or the other sessions on a busy machine:

- **Each command of a touched extension's Tests line** runs through the branch's own
  `scripts/nice.mjs`, the same lowering `pnpm test` gets; a tree without that script runs it
  unchanged.
- **The spec replay suite is a landing gate.** When the commits `check` would land touch
  `pi-config/extensions/spec/core/`, `pi-config/extensions/mode/spec-guard.ts`,
  `pi-config/extensions/claude-code/spec-hooks.ts` or `pi-config/extensions/spec/tests/replay/`,
  and the branch's tree has `pi-config/extensions/spec/tests/replay/replay.test.mjs`, `check` runs
  `node --test tests/replay/*.test.mjs` in `pi-config/extensions/spec`, through `scripts/nice.mjs`
  and with `SOVA_SPEC_REPLAY=1`, as a step like the others (its log, its timeout); a failure or a
  timeout is a need. Otherwise it prints why it skipped the replay (no such file), or nothing when
  no such path changed.
- **One replay at a time on this machine.** The run holds `<agent dir>/locks/spec-replay.lock`
  (`{pid, at}`, created exclusively). A lock whose process is gone, or older than 6 hours, is
  stale and taken over; a live one is waited for, never a failure, and the line says how long
  `check` waited.

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
