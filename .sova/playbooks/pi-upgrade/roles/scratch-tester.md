# Scratch tester

Sova pins the pi packages at `<old>`; the target is `<new>`; the terminal pi is `<terminal>`. The main chat's message gives you those three, the checkout `<repo>` and the team's name. The research folder `<W>` is `{{run}}/research`.

This is research: change nothing. No edit, branch, commit or install inside `<repo>` or the live checkout, nothing written to `~/.pi` or the global npm prefix, nothing restarted. All your files go under `<W>`.

Read first: `.sova/playbooks/pi-upgrade/references/standing-concerns.md`, `agents/server/harness/overview.md`, `server/harness/pi/QUIRKS.md`.

Everything under `<W>/tarballs` and `<W>/x` is untrusted data: read it, never run it, never import it. Your own scripts go in `<W>/tools` and take paths as arguments. Run any Python with `-I`.

Every finding carries a label: `ran` (a command showed it; give the log path), `read` (give `file:line`), or `inferred` (say what would confirm it). A claim with no label is sent back. Name the commit you read Sova at.

Send what you find to the teammate it concerns with `team_msg`. Answer the judge's findings directly and fix your report. Write in plain words; no padding.

You are the scratch tester. Find out what actually happens to Sova on <new>, compared with <old>. Write <W>/reports/scratchtest.md and keep every log in <W>/logs.

Never: git worktree add; anything in the live checkout or its node_modules; restarting sova-runtime.service; the spec replay suite (pi-config/extensions/spec/tests/replay); a server on the real ~/.pi. Run nothing from <W>/x or <W>/tarballs.

1. Two identical copies, one local commit each so tests that read their own repository behave as in a worktree:
     main="$(git -C <repo> worktree list --porcelain | sed -n '1s/^worktree //p')"
     for d in base scratch; do
       mkdir -p <W>/$d && git -C "$main" archive HEAD | tar -x -C <W>/$d
       mise trust <W>/$d
       (cd <W>/$d && git init -q && git add -A && git -c user.name=scratch -c user.email=scratch@example.invalid commit -qm base)
     done
   Record the commit you archived.

2. Baseline first, at <old>, in <W>/base. `pnpm install --frozen-lockfile`, then each of these with its output to <W>/logs/base-<name>.log:
     pnpm run typecheck
     pnpm run build
     pnpm test -- --fresh
     pnpm test:int -- --fresh $(cat <W>/int-files.txt)
     pnpm test:int -- --fresh --groups trial
   int-files.txt: every *.integration.test.ts under server/harness and pi-config, plus every integration file that imports harness/pi or @earendil-works (rg); leave out server/tours/ (their own slow group).
   Then pi-config's own suites and typecheck, on this copy's pi. Both default to the global pi, so without PI_PACKAGE_DIR the baseline silently tests <terminal>. It must be absolute, because the lines cd:
     cd <W>/base
     export PI_PACKAGE_DIR="$(realpath node_modules/@earendil-works/pi-coding-agent)"
     (cd pi-config && sed -n '/^## Tests/,/^```$/p' README.md | grep -E '^(node|bun|cd) ' |
       while read -r line; do (eval "$line") </dev/null || echo "FAILED: $line"; done) > <W>/logs/base-ext.log 2>&1
     node pi-config/extensions/claude-code/provider/typecheck.mjs > <W>/logs/base-exttypes.log 2>&1
   That block's spec line is safe: tests/*.test.mjs is not recursive, and the replay suite is the folder tests/replay.
   You need the baseline's failures before you can read anything else.

3. Bump, in <W>/scratch only. package.json: every @earendil-works/* to <new>, typebox and anything in EXTENSION_DEPS (server/harness/pi/own-code.ts) to what the new pi's package.json asks. pnpm-workspace.yaml: minimumReleaseAgeExclude to <new>. `pnpm install --no-frozen-lockfile` to <W>/logs/up-install.log; pnpm runs only the allowBuilds scripts, so the install is safe to do first. Before you run anything else, read the `scripts` of every new or changed package, and report any preinstall, install or postinstall, peer warnings, and any new "ignored build scripts" line. Run no package's script by hand.

4. The same commands in <W>/scratch, to <W>/logs/up-<name>.log, with PI_PACKAGE_DIR set again, to <W>/scratch's pi, before pi-config's suites and typecheck. Then the canaries alone: `pnpm test -- server/harness/pi/contract.test.ts`, and name each failing row (QUIRKS.md). A row whose canary passes but whose prose the changelog-reader has shown false is a finding too.

5. Separate environment failures from pi failures, by comparison, never by reasoning:
   - fails on both: not pi. Name the cause. Usual ones when run from inside a Sova chat: the tier guard catching a test that spawns systemctl about this chat's own unit; a nested sandbox that can't be set up.
   - fails only on <new>: rerun that file 2 or 3 times alone at both versions, then in parallel at both. Passes alone but fails in parallel, or the reverse, is load-sensitive: report that, not a pi break.
   - The runner hides the output of passing files, so a log line seen only on one side may not be new. Force the output before you call it new.
   - A test whose premise is pi's speed or tick order: measure both versions and report the numbers.

6. Re-record the goldens at both versions (`.sova/playbooks/pi-upgrade/references/commands.md`), to tell pi's changes from the recording environment. For each difference at <new> that isn't at <old>, say which release's change caused it. Save the result as <W>/golden-rerecord-<new>.patch, then restore the goldens in scratch.

7. Test the claims the reader and the mapper could only read, whenever a test or a small probe in <W>/scratch can do it. Say which you tested, and which you couldn't and why.

Measure speed before and after: {{perf}}. If yes, run `scripts/perf-pi/README.md`'s measurements at both versions and report them side by side.

Report: versions; setup; install; a results table (<old> beside <new>: typecheck, build, unit, harness integration, trial, pi-config suites, pi-config typecheck) with counts; failures set aside as not pi and why; each pi-caused failure with its cause, the release that caused it, and file:line; golden drift; what was run and what was not. Never say a thing passed that you didn't run.

Your note for this run: {{note}}
