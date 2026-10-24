# §chat/merge-round — The merge round
> Part of the Sova design spec · [overview](../design/overview.md)

Sova's own repository ships one scheduled playbook, **Merge round** (`.sova/playbooks/merge-round/`),
run by the project profile **Merge captain** (`.sova/profiles/merge-captain.json`, One at a time)
when a branch in its repository turns ready to merge (§chat.schedules/merge-ready), every 6 hours,
and after a Claude limit resets (§chat/schedules). A round finds finished branches,
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
- **The board.** Each round reads Sova's merge board (§chat.worktrees/merge-board), the Ready to
  merge chip's own rule set (§chat.worktrees/readiness), through the driver's `status`, whole and
  never filtered through `grep`, `head` or `tail`. A wake whose Reason reads `Ready to merge: …`
  names the branches that just turned ready. A branch to queue is one the board reads Ready to land;
  Ready to merge and Waiting for your OK alone are not finished work. The owner of a branch is the session the board names, never a guess from
  session files or titles. An owner the board can't name yet (Sova hasn't read every session) is
  unknown, left for a later round and never "no owner"; when the board is missing or old, owners
  are unknown and nothing lands that round. A branch whose owner is archived, or whose worktree no
  session tracks, is the user's call: told to the user once and never merged on the captain's own
  say: the user naming a branch to land is that say, and counts as its owner's READY, recorded with
  the driver's `note`. Commits on master the captain didn't land (an owner's own merge) get
  typecheck, tests and build before they are pushed.
- **Verify.** The chip can be wrong (it doesn't know intent, and its checks-passed isn't tied to
  the branch's head), so before accepting a branch the captain reads the owner's transcript
  (`session_read`) and the git state: commits ahead, a clean tree (the sandbox tests' own output
  apart), no TEMP, WIP, `fixup!`, `squash!` or `amend!` subject, and no open alignment questions.
- **Queuing a branch: the Landing card.** The captain queues a branch the board reads Ready to
  land (§chat.worktrees/ready-to-land), only when its owner and the owner's workers are idle,
  through the driver's `ask`. That writes the queue entry Sova reads: Sova then shows the owner's
  session the Landing offer itself (§chat.offers/sova-landing), from the captain's chat, for that
  branch at that head; no agent gets a tool or a permission for it, and the owner's agent never
  needs to know a captain exists. The user answers on the card: **Land It** records the go-ahead
  for that exact commit and sends it to the captain, which is the OK: the branch, checked green at
  that head, lands, pushes and restarts without the user being asked again. **Not Yet** leaves the
  branch until its head changes. The captain doesn't poll: Land It's message wakes it, and `status`
  reads the recorded go-aheads and Not Yets. A branch the user names to land in the captain's own
  chat, or one with no card (Sova refused to show it and said why), is asked the old way: with
  `session_send`, for a `READY <branch> <sha>` or `NOT READY: <why>` pushed with `queue_push` to
  the captain's own topic (`queue_open merge`, the same each round while the session lives,
  §chat.topics/open), piped into the driver's `reply`. In a project whose master turns the merge
  guard on (`"mainMerges": "go-ahead"`, Sova's own), that READY alone lands nothing: only the user's
  Land It at that head, or the user naming the branch to the captain, lets it be checked and landed;
  without either the branch stays queued for the card and the captain tells the user why. The
  captain tells the user to press Land It only for a branch whose card Sova showed (`status` says
  so), naming the owner's chat by its title with a link to it (`#/sid/<id>`); a branch with no owner
  chat (owner archived, or no session tracks its worktree) has no card, so the captain asks the
  user for a typed OK in its own chat instead ("say land <branch> here"). It never
  asks a busy session. Notes arrive
  only between turns, so the captain reads the owner again just before landing; a hold that arrives
  after a landing is reported to the owner and the user, never undone. A session that needs to
  reach the captain is told the topic's name by `session_send`, never given a second topic; the
  captain itself answers with `session_send`, since it can't push to its own topic.
- **Each branch** is merged with master in its worktree, checked (typecheck, the unit tests and
  then all the integration tests (§app.server-runtime/test-tiers), each with timeouts near their
  baseline, each touched pi-config extension's suite, build; a failure that also fails
  on master is named as pre-existing; a new failing file that passes alone twice with the suite's
  runner is named flaky and doesn't hold the branch; an extension suite failing the same way on
  master is master's), leak-scanned over the commits landing would publish,
  then landed with `worktree merge` and built in the main checkout. A step that fails in no time
  didn't run, and its log is read. A branch its owner already merged goes straight to `landed`. A
  branch with a leak in its history, or a commit a scrub cut out of master, never merges: its owner
  re-applies the change on a fresh branch. The owner's worktree stays theirs: uncommitted files go
  back to the owner, and the captain parks them outside the repo only with the owner's OK and
  restores them byte for byte; a symlinked `node_modules` is environment, which it may rebuild and
  report.
- **Specs land with the code.** A branch's spec drafts are its owner's to promote, on that branch,
  before it lands: Sova itself tells the owner once per commit (§chat.worktrees/ready-to-land), and
  the branch reads Landing specs until they are committed, so nobody asks the user for it and there
  is never a second, specs-only landing. The captain promotes none. A check that finds a draft not
  confirmed promoted hands the branch back to its owner with the drafts named; so does a merge of
  master into the branch that conflicts in the spec, for the owner to merge master in itself and
  promote again on top of it. Only the user's **Merge Without Specs…** on the Landing card lands a
  branch with drafts left, which the landed notice then names for a fresh branch. A branch whose
  owner is gone stays the user's call. Unclaimed files and a failing census still hold nothing:
  the merge round's spec checks are a safety net under the owner's own promotion, never a gate of
  their own.
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
- **Restart** when the live server's head lacks master's runtime code, whoever merged it, whatever the
  other sessions are doing (a restart cuts no chat, worker or reply off, §app/chat-processes): the
  line `restart-check` prints, run by the round's session, and confirmed on the next round with the
  head it came back on. A restart another session has claimed is left to it.
- **Always the user's call:** rewriting unpushed master to scrub a hit, each case (the old head kept
  first as a local `backstop/<what>-<sha>` branch; master made one new commit of the intended tree on
  origin/master with `commit-tree` and `update-ref`; proved a fast-forward of origin/master whose
  diff from the old head is only the intended change, with no scrubbed commit reachable and the
  leak scan, typecheck, build and census passing; the leak's branch never merged again; the backstop
  deleted when the user says). A branch is never scrubbed. Also the user's: waiving a hit, each
  time it recurs; names origin already has in public; any deploy
  to a peer; landing a branch with no live owner (owner archived, or no session tracks its
  worktree) or one without the user's go-ahead. Everything else, a branch the user pressed Land It
  on (or its owner answered READY for) and checked green, lands and pushes without asking.
- **Never:** force-push or rewrite pushed history; `filter-branch` or `read-tree` on master, or
  `update-ref` on it outside a scrub the user approved for that case; a private name written inline
  in a command; another session's project instance touched, or its worktree changed beyond the
  check's master merge (and a rebuilt `node_modules`), without its OK.
- **The report** each round: shas merged, push result, restart state, the branches with no live owner (each the first time it is the user's call, with the typed OK that lands it), the branches
  whose Landing card waits for the user (each naming the owner's chat with its link), owners asked
  and their answers, anything handed back and why. A quiet round (nothing asked, checked, landed or
  pushed, and nothing new for the user) reports one line: "Nothing new on the merge board."

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
- **It reads Sova's board, never sessions.** Owners come from Sova's merge board file,
  `<state root>/merge-board.json` (§chat.worktrees/merge-board); it never reads a session file,
  never calls Sova's API about sessions and never holds Sova's token. A board that is missing, not
  version 1, or written more than 5 minutes ago is not read: owners are unknown. Each board reading
  of a branch (owner, owner status, state, reason) is kept in its state record. What the captain
  learns another way it records with `note <branch> owner=<id> chip=ready|waiting|none idle=yes|no
  [source=<word>]`, which names the owner only while it is newer than the board's reading; the
  owner's status comes from the newest reading of that owner. Its only HTTP is `GET /api/health`,
  best effort, to read the head the live server started at.
- **The restart need** is the live server's `head` from `GET /api/health` against master: a
  restart is needed when a file that needs one (§chat.worktrees/readiness's rule) differs between
  them, so a branch its owner merged without the round counts as much as one `landed` recorded.
  When the health can't be read, or names no commit this repository has, it can't be told.
- **`start`** knows this session's first round by `PI_SESSION_ID`: it says whether to run the start
  interview, turns the push hold on when the settings file is missing at that first round, and says
  whether a restart is needed: one pending is confirmed once the restart need is none, and a need
  it finds is recorded as pending. **`names-answered`** lifts the hold once the user has answered.
- **`status`** lists every local branch ahead of master that has a worktree, grouped and sorted by
  what to do next (to check, to land, to queue now, card shown, owner busy, owner archived, no
  session tracks, owner unknown, not ready), with each group's count on its first line and the board's age and
  unread sessions. Each branch shows the board's reason and its owner with that owner's status and
  where that came from. When the board can't be read it says owners are unknown and why, lists git
  facts only, and exits 2. Per branch: ahead and behind,
  uncommitted files (the sandbox tests' `FIRST-RUN.txt` and `NAIVE-RUN.txt` apart), a TEMP, WIP,
  `fixup!`, `squash!` or `amend!` subject, how many files a trial merge with master conflicts in
  (`git merge-tree --write-tree` into a throwaway object directory, so the repository is never
  written), the last commit's age, the recorded owner and ask (for a queued branch, whether Sova showed the Landing card or why not), the user's Land It or Not Yet at the current head, and whether landing it needs a
  restart (§chat.worktrees/readiness's rule). It
  also says whether the main checkout is on master, how many files are dirty there, and how far it
  is from origin/master.
- **`ask <branch> [topic=<name>]`** reads the board again, and refuses a branch with no known
  owner, an archived owner (the user's call), an owner not idle, an owner reading older than 15
  minutes, and an owner asked in the last 10 minutes. For a branch the board reads Ready to land
  (or Landing specs with the owner's reason it can't land them) it **queues** it: it appends
  `{branch, path, head, owner, captain}` to `<state root>/landing-queue.json`, for Sova to show the
  owner the Landing card (§chat.offers/sova-landing), and its `next:` line says not to poll: Land
  It's message arrives by itself. `status` then shows, per branch, whether Sova showed the card or
  why it didn't. Any other branch is asked the old way, which needs the name `queue_open` gave the
  round's topic (a bare base name is refused): it records the topic with the ask and prints the text
  to `session_send`: `Is <branch> ready to merge at its current head? Reply with queue_push, topic
  "<name>", text one line: READY <branch> <the head sha you checked>, or NOT READY: <why>.`, which
  never holds the head's sha. When the branch's worktree holds spec drafts not confirmed promoted
  (the draft tool's `drafts` reading: records pending, records in conflict, whether the draft never
  promoted them or promoted them before and the branch now says them differently, as after taking
  master's spec in a conflict without promoting again, or a reading that fails, the spec tools
  missing included), the text ends with one more sentence naming each such draft with up to four of
  those § ids, or "status unreadable", telling the owner to promote them on its branch and commit
  that before it answers READY, that the user's go-ahead to merge covers it, and that a READY with
  them left is handed back; with none the text is as above. **A recorded go-ahead** (Land It, in
  `<state root>/landing.json`) for the branch at its current head, or at an earlier head when every
  commit since is a clean merge of master (§chat.worktrees/merge-guard's rule, so a go-ahead
  survives the check's own master merge), counts as the owner's READY: the
  branch goes to "to check"; one recorded without specs also lets its check pass with drafts left,
  naming them. A recorded Not Yet at the current head puts it in "not ready" until the head moves.
  **The merge guard.** When master's own copy of `.sova/offers.json` says `"mainMerges": "go-ahead"`
  (§chat.worktrees/merge-guard, read through git, never a working tree), a branch goes to "to check",
  and a green check to "to land", only with the user's go-ahead at its current head: a recorded go-ahead,
  or the user having named the branch (`note … source=user`) with its owner's READY at that head. An
  owner's own READY alone is no go-ahead there: the branch stays to queue, or card shown, for the
  Landing card. With the guard off, an owner's READY at the current head goes to "to check" as before.
  **`reply <branch>`** reads the
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
  nothing else is an answer, so an echoed ask or a line elsewhere never counts. A READY at the
  current head while the worktree still holds drafts not confirmed promoted is not taken: it is
  recorded as handed back, and `reply` prints the hand-back to `session_send` to the owner (each
  draft named, to promote and commit on its branch, then answer READY again on the same topic) and
  exits 1.
- **`check <branch>`** refuses a branch with no worktree, no commit ahead, uncommitted files or a
  TEMP-style subject. It merges master into the branch in its worktree, never on master. On
  conflicts it stops and leaves them to the captain, except the spec's: a conflicting
  `.sova/spec/manifest.json` first goes through the spec tool's `merge-manifest --write`, and when a
  spec file is still conflicted after that (any `claims/*.md` file, or a manifest `merge-manifest`
  refuses) it aborts the merge, so the worktree is as it was, records the branch as handed back, and
  prints the hand-back for the owner: merge master in itself, recover the spec as PROMOTE.md says
  (master's whole spec, the merge committed, its drafts promoted again with the same `--id`s, the
  claims committed), then answer READY again. It exits 1 and never says to resolve a spec conflict
  itself. It then
  runs the typecheck, `pnpm test` and then `pnpm test:int` (§app.server-runtime/test-tiers; a tree
  whose package.json has no `test:int` script skips it and says so), both without
  `CLAUDE_CONFIG_DIR`, each touched pi-config extension's
  line from `pi-config/README.md`'s Tests block, and the build, each in its own process group,
  killed whole at its timeout (the larger of a floor and twice the median of its earlier passing
  runs); then the spec tool's `check`, `census --changed --base master`, and each draft's status,
  which it prints. A draft not confirmed promoted (as `ask` reads it) is a need, `docs not promoted:
  <draft>, …`, and the check prints the same hand-back as `reply`; no spec check result, census or
  unclaimed file is a need. A
  test file that fails, in either tier, is run again on master, in the main checkout at master's sha (refused when
  that file is dirty there), cached per master sha and file: one that fails there too is named
  pre-existing and doesn't block. It also runs `leak-scan.mjs` over the commits landing would
  publish (origin/master to the branch's head): a hit is a need, printed as the scan prints it; a
  scan that can't run is said and doesn't block, since `push` scans again. Each area guide
  (`agents/**/overview.md` in the branch's tree) names in its front-matter the files it `watches`
  and the files to `alsoUpdate` with them; for each area whose watched files the branch changed
  while it changed none of that area's also-update files, it prints `also update: touched <area>
  (…), not <file>`, a question for the owner and never a need. The verdict, `landable at
  <sha>` or `needs: …`, is recorded against the branch's head and master's sha.
- **`land <branch>`** never merges. With a landable check at the current head and the current
  master, it runs the same leak scan again and, only when it finds no hit, prints the `worktree`
  tool's merge call; a moved head or master means check again.
  **`landed <branch>`** verifies with git that the branch's head is in master, however it got there
  (a branch its owner merged has no check on record), builds the main checkout, records the restart
  need (one that can't be told counts as needed), and prints the notice for the owner, with the
  sentence "Its worktree folder was removed." to add only when the clean-up's remove succeeds.
  When the landed branch's worktree still holds drafts not confirmed promoted (a branch its owner
  merged itself, say), it first copies each such draft into
  `<state root>/playbooks/merge-round/drafts/<head sha>/`, since removing the folder deletes the
  worktree's own copy, and the notice goes on to say they didn't land with the code, naming each
  draft with up to four of those § ids, or "status unreadable", and that folder, for the owner to
  promote on a fresh branch from master by copying them into its worktree's `.sova/spec/drafts/`,
  never on master itself. A copy that fails withholds the clean up, so the folder and its drafts
  stay, and the notice names the worktree's own drafts folder instead. With none the notice is
  unchanged. Every `landed` also runs the draft tool's `prune --official --from <folder> --write`
  against the main checkout's spec on each folder of copies under that `drafts/` directory, which
  deletes only the copies the tool confirms are already official there, and removes a folder left
  empty; a copy the tool can't confirm is kept, and a prune that fails deletes nothing and is said.
  Its `next:` line is the clean-up: `git -C <main checkout> worktree remove -- <path>`, then `git -C
  <main checkout> branch -d -- <branch>`, then `push`. When git's record of that worktree can't
  be written from where the driver runs (a sandboxed captain), it prints instead that the clean-up
  can't run here and leaves the folder, so git never half-removes a tree it can't unregister.
- **`push`** refuses under the hold, when the main checkout isn't on master, and when master isn't a
  fast-forward of origin/master after a fetch. It runs `leak-scan.mjs` and, only when that exits 0,
  runs exactly `git push origin master`. It has no force, tags or all path.
- **`restart-check`** works out the restart need, as `start` does, and when a restart is needed, or
  pending and it can't tell, prints the restart line (`systemctl --user restart <unit>`; on macOS
  `launchctl kickstart -k gui/<uid>/<label>`, the label the unit's name without `.service`), with no
  regard to busy sessions: it reads no live records. Exit 0 either way; 2 only when the settings' restart unit
  isn't a plain unit name. It never schedules or runs a restart itself.
- **`report`** prints the round report's skeleton from the state, listing each branch with no live
  owner once per head (`For you, once (no live owner): …`, each with "say land <branch> here to land
  it"), and each branch whose Landing card Sova showed at its current head, waiting for the user
  (`Waiting for your Land It: <branch> at <sha7> in "<owner's title>" (#/sid/<id>)`). `status` and
  `ask` name a queued branch's owner chat the same way, by title and link, never "its card is
  shown" alone. A quiet round prints only `Nothing new on the merge board.`

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
  `pi-config/extensions/spec/core/`, `pi-config/extensions/mode/spec-guard.ts` or
  `pi-config/extensions/spec/tests/replay/`,
  and the branch's tree has `pi-config/extensions/spec/tests/replay/replay.test.mjs`, `check` runs
  `node --test tests/replay/*.test.mjs` in `pi-config/extensions/spec`, through `scripts/nice.mjs`
  and with `SOVA_SPEC_REPLAY=1`, as a step like the others (its log, its timeout); a failure or a
  timeout is a need. Otherwise it prints why it skipped the replay (no such file), or nothing when
  no such path changed.
- **One replay at a time on this machine.** The run holds `<agent dir>/locks/spec-replay.lock`
  (`{pid, at}`, created exclusively), rewriting its `at` every 30 seconds while it holds it. A lock
  whose `at` is older than 3 minutes is stale and taken over, whatever its pid (a holder in a
  sandbox's own PID namespace looks gone to this one); a fresher one is waited for, never a
  failure, and the line says how long `check` waited.

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
