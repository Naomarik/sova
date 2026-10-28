# §chat/merge-round — The merge round
> Part of the Sova design spec · [overview](../design/overview.md)

Sova's own repository ships one scheduled playbook, **Merge round** (`.sova/playbooks/merge-round/`),
run by the project profile **Merge captain** (`.sova/profiles/merge-captain.json`, One at a time)
when a branch in its repository turns Ready to land or gets the user's go-ahead typed in its own
chat or given with Go on an Overseer card (§chat.schedules/merge-ready), every 6 hours,
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
  order given. That order ranks where a branch came from, never when it lands: the captain waits on
  no landing order the user didn't ask for, and lands approved branches one at a time as each
  becomes ready.
- **The board.** Each round reads Sova's merge board (§chat.worktrees/merge-board), the Ready to
  merge chip's own rule set (§chat.worktrees/readiness), through the driver's `status`, whole and
  never filtered through `grep`, `head` or `tail`. A wake whose Reason reads `Ready to land: …`
  names the branches that just turned Ready to land (§chat.schedules/merge-ready), and one that also
  reads `Go-ahead typed in its own chat: …` names branches the user told, in their own chat, to land,
  and `Go-ahead on the Overseer's card: …` branches the user applied Go on in an Overseer card
  (both checked at once, below). A branch to queue is one the board reads Ready to land;
  Ready to merge and Waiting for your OK alone are not finished work. The owner of a branch is the session the board names, never a guess from
  session files or titles. An owner the board can't name yet (Sova hasn't read every session) is
  unknown, left for a later round and never "no owner"; when the board is missing or old, owners
  are unknown and nothing lands that round. A branch whose owner is archived, or whose worktree no
  session tracks, is the user's call: told to the user once and never merged on the captain's own
  say: the user's word in the captain's chat (below) is that say. Commits on master the captain didn't land (an owner's own merge) get
  typecheck, the unit tests, the integration tests under the landing's group rules (`pnpm test:int
  -- --landing --base origin/master`) and build before they are pushed.
- **Verify.** The chip can be wrong (it doesn't know intent, and its checks-passed isn't tied to
  the branch's head), so before accepting a branch the captain reads the owner's transcript
  (`session_read`) and the git state: commits ahead, a clean tree (the sandbox tests' own output
  apart), no TEMP, WIP, `fixup!`, `squash!` or `amend!` subject, and no open alignment questions.
- **Queuing a branch: the Landing card.** The captain queues a branch the board reads Ready to
  land (§chat.worktrees/ready-to-land), only when its owner and the owner's workers are idle,
  through the driver's `ask`. That writes the queue entry Sova reads: Sova then shows the owner's
  session the Landing offer itself (§chat.offers/sova-landing), from the captain's chat, for that
  branch at that head; no agent gets a tool or a permission for it, and the owner's agent never
  needs to know a captain exists. Sova also adds the branch as a row of the landing card in the
  captain's own chat (§chat.offers/landing-rows), even when the owner's card was refused for a
  reason of that chat alone, and one answer on either settles both. The user answers on the card: **Land It** records the go-ahead
  and sends it to the captain, which is the OK: the branch, checked green, lands, pushes and
  restarts without the user being asked again, and the check's own clean merge of master never
  cancels it. **Not Yet** leaves the branch until its head changes. The captain doesn't poll: Land It's message wakes it, a go-ahead
  typed in the owner's chat or applied on an Overseer card wakes it through the merge-ready trigger (§chat.schedules/merge-ready), and `status`
  reads the recorded go-aheads and Not Yets. No owner is asked in words whether its branch is ready:
  a branch with neither a card nor a row (Sova says why) lands only on the user's word, which the
  captain asks for once. A hand-back goes to the owner, and once the owner commits the fix the branch
  shows Ready to land again and is queued at its new head. Only the user's go-ahead (Land It, Go on an Overseer card's
  Ready to land row, or their word below) lets a branch be checked and landed. The captain mentions Land It only for a branch whose card or row Sova showed (`status` says
  so): for a branch with a row it says to answer "on the card below", naming the owner's chat by its title with a link to it (`#/sid/<id>`), and says the user may
  as well type "land it" there; for any other branch it never tells the user to press a card or wait
  for one, but asks for their word: "land it" typed in the owner's chat, or "land <branch>" in the
  captain's own. A branch with no owner chat (owner archived, or no session tracks its worktree) has
  no card, so the captain asks the user for a typed OK in its own chat instead ("say land <branch> here"). It never
  asks a busy session. Notes arrive
  only between turns, so the captain reads the owner again just before landing; a hold that arrives
  after a landing is reported to the owner and the user, never undone. An owner's hold covers only
  its own branch: a note from another chat asking to go first or to hold other branches is
  information, never a delay of a branch the user approved, and the captain tells that owner and
  the user instead. A session that needs to
  reach the captain (a hold, a question) is told the name of its topic (`queue_open merge`, the
  same each round while the session lives, §chat.topics/open) by `session_send`, never given a second topic; the
  captain itself answers with `session_send`, since it can't push to its own topic.
- **The user's word always lands it.** When the user tells the captain in its own chat to land a
  branch ("merge it", "land feat/x"), that is the go-ahead, and the Landing card is only a
  shortcut for it: the captain records it with the driver's `go`, and the branch goes straight to
  the check and lands once the check passes, without waiting for Ready to land or a card,
  whatever the board reads and whoever owns it, with no confirmation from its owner needed. The
  check still holds it for
  anything it finds, spec drafts that aren't official included, unless the user said to land it
  without its specs (`go <branch> without-specs`, as Merge Without Specs… does). The user's word
  typed in the branch's own chat ("land it", "merge it") is the same go-ahead: that chat's agent
  records it (`worktree land`, §chat.worktrees/tool, kept with the Land Its,
  §chat.worktrees/landing-answers), it wakes the captain, and the captain checks and lands the
  branch exactly as on Land It, card or not. So is Go on a Ready to land row of an Overseer card the
  user applied (§app.overseer/card-land): Sova records it for the commit the row showed, it wakes
  the captain, and the captain checks and lands the branch exactly as on Land It.
- **Each branch** is merged with master in its worktree, checked (typecheck, the unit tests and
  then the everyday integration tests plus each slow group the branch's changes trigger, never the
  tours (§app.server-runtime/test-tiers), or every integration test on a full run the user asked
  for, for that branch or until they say otherwise, each with timeouts near their
  baseline, each touched pi-config extension's suite, build; a test file failing in that run
  is run again on its own with the suite's runner: passing alone it is named flaky and doesn't hold
  the branch; failing alone it is run on master too, and one that also fails there is named
  pre-existing and doesn't hold the branch either, while one that passes on master, or that can't
  be told, holds it; an
  extension suite failing the same way on master is master's), leak-scanned over the commits landing would publish,
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
  is never a second, specs-only landing. The captain promotes none. Whether a draft is official is
  one rule, the draft tool's (§tools.spec/draft-official), the same Sova's own readiness calls. A
  check that finds a draft that isn't official hands the branch back to its owner with the drafts
  named; so does a merge of master into the branch that conflicts in the spec, for the owner to
  merge master in itself and promote again on top of it. Only the user's **Merge Without Specs…**
  on the Landing card, or their word to land it without its specs, lands a branch with drafts
  left, which the landed notice then names for a fresh branch. At landing, once its check passed,
  the drafts that are official are tidied out of the worktree, a copy of its drafts kept aside until
  a later landing finds them official in master, so a draft that
  already landed never holds a later landing there. A branch whose
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
  on, applied Go on in an Overseer card, or told the captain, or the branch's own chat, to land, checked green, lands and pushes
  without asking.
- **Never:** force-push or rewrite pushed history; `filter-branch` or `read-tree` on master, or
  `update-ref` on it outside a scrub the user approved for that case; a private name written inline
  in a command; another session's project instance touched, or its worktree changed beyond the
  check's master merge (and a rebuilt `node_modules`), without its OK.
- **Waiting on a check.** The captain waits for a check's real end and reads its verdict, never a
  timer it guessed: it runs `check` in the foreground with a bash timeout above the limit the
  check prints, or with `--background`, wakes at the printed expected time and then runs `wait`.
  The only check duration it quotes to the user is one the driver printed: the expected time, and
  what a rerun of a failing file adds (§chat.merge-round/check-time).
- **The report** each round: shas merged, push result, restart state, what each check skipped (or
  that it was a full run), the branches with no live owner (each the first time it is the user's call, with the typed OK that lands it), the branches
  whose Landing card or captain row Sova showed and that wait for the user's Land It or typed word (each naming the
  owner's chat with its link, and "on the card below" for a row), the branches
  queued for a card, anything handed back and why. A quiet round (nothing queued, checked, landed or
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
  learns another way it records with `note <branch> owner=<id> idle=yes|no`, which names the owner only while it is newer than the board's reading; the
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
- **`ask <branch>`** reads the board again, and refuses a branch with no known owner, an archived
  owner (the user's call), an owner not idle, an owner reading older than 15 minutes, a branch
  already queued at its head, one whose Landing card Sova refused to show at its head and gave no
  captain row either (it says why, and that the branch lands only on the user's word; a branch Sova
  gave a row stays waiting on it, §chat.offers/landing-rows), and any branch the board doesn't read Ready to
  land (or Landing specs with the owner's reason it can't land them) at its head: no owner is asked
  in words. A branch it accepts it **queues**: it appends `{branch, path, head, owner, captain}` to
  `<state root>/landing-queue.json`, for Sova to show the owner the Landing card
  (§chat.offers/sova-landing), and its `next:` line says not to poll: Land It's message arrives by
  itself. `status` then shows, per branch, whether Sova showed the card or why it didn't, and
  whether it is a row on the card in the captain's chat.
  **A recorded go-ahead** (Land It, the user's word typed in the branch's own chat, or Go on an
  Overseer card's Ready to land row, in `<state root>/landing.json`, §chat.worktrees/landing-answers)
  for the branch at its current head, or at an earlier head when every commit since is a clean merge
  of master, counts. A clean merge has exactly two parents, the earlier head first and a commit already on
  master second, and its tree is exactly the one `git merge-tree --write-tree` makes of those two
  (no conflict, nothing edited by hand); the go-ahead carries through up to 20 of them, so the
  check's own merge of master, or master merged in again after it moved, never cancels the user's
  press, while a commit of the branch's own, an edited or resolved merge, or a merge of anything
  but master needs a new answer. Walking back from the head, the first commit with an answer
  decides by its newest answer, so a Not Yet there is never walked past. One recorded without specs
  also lets its check pass with drafts left, naming them.
  **`go <branch> [without-specs]`** records the user's word in the captain's own chat as their
  go-ahead for the branch at its current head, in the driver's state and in Sova's `landing.json`
  (marked as given in the captain's chat, so the owner's card and the captain's row settle and
  say so, §chat.worktrees/landing-answers), read exactly as a Land It
  (with `without-specs`, as Merge Without Specs…): carried over clean master merges, and the newer
  of it and a Not Yet at that commit decides. It needs no owner, board row or ask: `status` then
  lists the branch under "to check" whatever the board reads, and `land` names the user's word.
  **To check, to land.** A branch goes to "to check" on a go-ahead that counts at its current head, and to "to land" once a check passed at its current head and master's
  current sha. A Not Yet that decides the walk puts it in "not ready" until the head moves, green
  check or not. No answer is demanded at the exact head anywhere, `land` included.
- **`check <branch>`** refuses a branch with no worktree, no commit ahead, uncommitted files or a
  TEMP-style subject. It merges master into the branch in its worktree, never on master. On
  conflicts it stops and leaves them to the captain, except the spec's: a conflicting
  `.sova/spec/manifest.json` or per-area record file (`claims/**/*.json`, §tools.spec/record-layout)
  first goes through the spec tool's `merge-manifest --write`, which stages the files it wrote, and
  when a spec file is still conflicted after that (any `claims/*.md` file, or a record
  `merge-manifest` refuses) it aborts the merge, so the worktree is as it was, records a failed check at that
  head, and prints the hand-back for the owner: merge master in itself, recover the spec as
  PROMOTE.md says (master's whole spec, or with records beside each claim file only the areas that
  clashed, the merge committed, its drafts promoted again with the same `--id`s, the claims
  committed), so the branch shows Ready to land again. It exits 1 and never says to resolve a spec conflict itself.
  After every merge of master, before the merge commit, it reads the spec's records with the spec
  tool (`records`): a spec now holding records both ways (`layout-mixed`) is finished with
  `merge-manifest --write`; when that can't finish it, when the records don't read (an unreadable
  manifest, a bad record file), or when the tool gives no answer, it aborts the merge, so the
  worktree is as it was, and says which. A clean merge is otherwise committed exactly as Git's
  one-step merge commits it. It then
  runs the typecheck, `pnpm test` and then `pnpm test:int -- --landing --base <master sha>`
  (§app.server-runtime/test-tiers: the everyday integration set plus each slow group the branch's
  changes trigger, never Tours; a tree whose package.json has no `test:int` script skips it and
  says so, and a tree without `scripts/test-groups.mjs` runs the whole tier), both without
  `CLAUDE_CONFIG_DIR`. It asks the branch's own runner for the selection first (`--plan`), and the
  check names each group it didn't run and why: `Skipped: Chat processes (no change to its areas)`,
  `Not run at landing: Tours`. A **full run** runs the whole tier instead, every group included,
  and says `full run`: `check <branch> full` for that check, or every check while `full on` is
  stored in its state (until `full off`). It runs each touched pi-config extension's
  line from `pi-config/README.md`'s Tests block, and the build, each in its own process group,
  killed whole at its timeout (the larger of a floor and twice the median of its earlier passing
  runs); then the spec tool's `check`, `census --changed --base master`, and each draft's status,
  which it prints. A draft not confirmed promoted is a need, `docs not promoted: <draft>, …`: one the
  draft tool's `drafts` reading calls not official (its `official` verdict, §tools.spec/draft-official),
  or a reading that fails, the spec tools missing included. The check then prints the hand-back for
  the owner, naming each such draft with up to four of its § ids, or "status unreadable", to promote
  and commit on its branch, so it shows Ready to land again; no spec check result, census or
  unclaimed file is a need. A
  test file that fails, in either tier (in the integration tier, of the groups it chose), is run
  again on its own in the branch's worktree, through
  the same runner on the same runtime (`scripts/run-tests.mjs --runtime <bun|node> <file>`): one
  that passes alone is named flaky in the check's output and doesn't hold the branch. A file that
  also fails alone is run on master, in the main checkout at master's sha, cached per master sha
  and file: one that fails there too is named pre-existing (`Pre-existing on master (not
  blocking): …`) and doesn't hold the branch; one that passes there is a need, `new test failure:
  <file>`. A file whose rerun alone or on master can't be told (it timed out, the runner couldn't
  run it, the file is dirty in the main checkout or that checkout isn't at master) is a need too,
  with the reason. It also runs `leak-scan.mjs` over the commits landing would
  publish (origin/master to the branch's head): a hit is a need, printed as the scan prints it; a
  scan that can't run is said and doesn't block, since `push` scans again. Each area guide
  (`agents/**/overview.md` in the branch's tree) names in its front-matter the files it `watches`
  and the files to `alsoUpdate` with them; for each area whose watched files the branch changed
  while it changed none of that area's also-update files, it prints `also update: touched <area>
  (…), not <file>`, a question for the owner and never a need. When the branch's tree has
  `scripts/fixed-wait-scan.mjs`, it runs it (`--base <master sha> --json`) and prints each new
  fixed wait over 2 seconds in the changed tests (`fixed waits: …`), a note for the owner and never
  a need; a tree without the script prints nothing. The verdict, `landable at <sha>` or
  `needs: …`, is recorded against the branch's head and master's sha, with the groups it skipped
  and whether it was a full run.
- **`land <branch>`** never merges. With a landable check at the current head and the current
  master, it runs the same leak scan again and, only when it finds no hit, prints the `worktree`
  tool's merge call, naming the user's Land It, their word in the captain's chat or typed in the
  branch's own, or "Apply on the Overseer's card" (and the commit it was given at), or else
  that none is recorded, so it lands only on the user's word; a moved head or master means check again, and a Not Yet that decides the walk
  above refuses it.
  **`landed <branch>`** verifies with git that the branch's head is in master, however it got there
  (a branch its owner merged has no check on record), builds the main checkout, records the restart
  need (one that can't be told counts as needed), and prints the notice for the owner, with the
  sentence "Its worktree folder was removed." to add only when the clean-up's remove succeeds.
  It first runs the draft tool's `prune --official --from <folder> --write` against the main
  checkout's spec on each folder of copies earlier landings kept under
  `<state root>/playbooks/merge-round/drafts/`, which deletes only the copies the tool confirms are
  already official there, and removes a folder left empty; a copy the tool can't confirm is kept,
  and a prune that fails deletes nothing and is said. Then it copies the worktree's whole drafts
  folder, once, into `drafts/<head sha>/`, since removing the folder deletes the worktree's own copy.
  When the worktree still holds drafts not confirmed promoted (a branch its owner merged itself,
  say), the notice goes on to say they didn't land with the code, naming each
  draft with up to four of those § ids, or "status unreadable", and that folder, for the owner to
  promote on a fresh branch from master by copying them into its worktree's `.sova/spec/drafts/`,
  never on master itself. A copy that fails withholds the clean up, so the folder and its drafts
  stay, and the notice names the worktree's own drafts folder instead. With none the notice is
  unchanged. When a check passed at the landed head and the copy was kept, the tool's `prune
  --official --write` tidies the drafts it confirms official out of the worktree; a prune that fails
  is said.
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
- **`full on|off`** stores, or clears, the round's full-run flag in its state; while it is on every
  `check` is a full run.
- **`report`** prints the round report's skeleton from the state; its `Checks` line names, for
  each branch checked, the groups that check skipped and why, or `full run`. It lists each branch with no live
  owner once per head (`For you, once (no live owner): …`, each with "say land <branch> here to land
  it"), and each branch whose Landing card Sova showed at its current head, waiting for the user
  (`Waiting for your Land It (or "land it" typed there): <branch> at <sha7> in "<owner's title>"
  (#/sid/<id>)`; for a branch with a captain row, `Waiting for your answer on the card below: <branch>
  at <sha7> (owner "<owner's title>" (#/sid/<id>))`); no other line of the driver tells the user to press a card or wait for one: a branch
  whose card isn't showing lands on the user's word, typed in the owner's chat or given to the captain. `status` and
  `ask` name a queued branch's owner chat the same way, by title and link, never "its card is
  shown" alone. A quiet round prints only `Nothing new on the merge board.`

Whether a draft is official is no copy: the driver reads the draft tool's `drafts`, and the
server calls the same function of that tool (§tools.spec/draft-official).
The two rules it shares with the server, which subjects are temporary and which changed files need a
restart, are copies, held equal to `server/merge-readiness.ts`'s by a test over an enumerated table.

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

## §chat.merge-round/check-time — How long a check takes, and waiting for its end

`check` says how long it expects to take, from what it measured, so nobody guesses:

- **The expected time.** Before its first step it prints `Expected: about …`, the sum over the
  steps it will run of the median of each step's earlier passing runs, as the driver's state keeps
  them, with the integration step kept per group set: `test-int` for the whole tier,
  `test-int:core` for the everyday set alone, `test-int:core+trial` with Chat processes, so a check
  of one set is never estimated from another's runs. A set with no runs yet takes the runner's
  `--plan` estimate from the branch tree's recorded file times. A step with neither is named as
  unknown. The same line gives the time limit, the sum of the steps' timeouts.
- **Reruns.** Before it reruns a failing file on its own, and again before it runs one on master,
  it prints how much longer that adds and the run's limit: the file's recorded time in the branch
  tree (in the main checkout, for a run on master), or that its time is unknown.
- **`check <branch> --background`** starts the same check as a detached process, its output in a
  log under `<state root>/playbooks/merge-round/background/`, and prints its pid, that log and the
  expected time once the check has printed it. One background check per branch at a time.
- **`wait <branch> [--timeout <s>]`** blocks until that background check ends, then prints its
  output and exits with its exit; at the timeout it exits 1 saying it is still running. With no
  background check it says so (exit 2).

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
