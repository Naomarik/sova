# Drawing the plan

Before you write anything, and again when you propose, you show the user the whole pipeline as a
drawing they can check at a glance: what happens to each approved branch, then each release step and
who does it, then each deploy. The drawing is of what **will** run, with real commands and limits,
never a generic picture. The Merge Queue and Releases tabs show the authoritative proposal from your
branch's files; your drawing is how the user agrees to it before you write it.

## Start from the driver

`node scripts/project-setup.mjs draw` prints a `vis steps` block for the setup at HEAD (on a set-up
project: the current setup, your opening drawing). After you write: `draw --worktree --base <target>`
draws the file on disk and marks each row that is new or changed against the target. `--plain` gives
the same as a numbered list. Take its output as the skeleton and edit the words; never draw a step
the definition doesn't hold, or leave out one it does.

Call `vis_guide` with `steps` (and `flow` when you add a flow) before you draw by hand: the parser is
strict, and a line it can't read shows the block as source. When the vis drawing kinds aren't
available in this chat, send the `--plain` list.

## What the drawing holds

**Each approved branch** (one row, lane `Each approved branch`):
merge onto the newest target in the merge copy → each `setup` step → the install (and its inputs) →
spec drafts made official (only with a spec) → **each required check: its label, its command, its time
limit, what it needs started first** → the review (when declared) → how it lands (the target moves to
the tested commit / a pull request / a merge request / the branch pushed) → the push (leak scan first;
held until private names are set up). Then a second row for the optional checks, "Picked by the merge
thread", each with what calls for it. Its outcome cell: the measured total ("about 6 min").

**A release** (lane `A release`), each step labelled with who acts and when:
- **Before publish**: the prepare steps (version, notes, bumps, commit) and the check steps;
- **Sova**: Sova's own steps, `checks` (the landing set + the release checks, by name) and `Publish`
  (the tag, the channels, the push: on the operator's click);
- **After publish**: the after steps (a release page, a registry, a build, a store submission);
- **Held for you**: every `held: true` step, toned `warn`;
- a separate row "After a withdraw" when the playbook has withdraw steps.
Its outcome: "release commit, semver" or "tag-only".

**Deploy** (lane `Deploy (yours)`), one row per target: Plan (your click: branch, pushed, releases
only, tests, credential checks) → plan steps → Run (your click, confirmed) → build steps → steps →
verify. Its outcome: the rollback.

## Marking

- Tones carry meaning, never alone: `ok` a part that works today, `warn` held for the user or a
  known risk, `error` not set up or failing, `muted` Sova's own steps, `accent` the user's clicks,
  `info` optional or picked.
- `mark` at most three things, each with a short note: in a Change Setup, the rows that change ("2
  checks added: lint, e2e"; "deploy: rollback now keeps the previous jar"); in a first setup, the
  one decision still open or the one risk the user must weigh ("e2e is flaky: 2 of 120 failed once").
- Never a `|` or a double quote inside a label (the driver replaces them).

## Two drawings for a bigger change

When a change reshapes the pipeline (a request instead of a local landing, a new release, a second
target), draw before and after side by side with `vis flow` panels:

```vis flow
title: How a branch lands, before and after
== Before ==
a "Approved branch" -> t "Tests" -> m "main moves"
== After ==
a "Approved branch" -> l "Lint" -> t "Tests" -> b "Build" -> p "Pull request on GitHub"
```

## A worked drawing

A Node web app, first setup, after measuring (warm times in the labels):

```vis steps
title: What will happen, once you land the setup branch
caption: Sova runs the landing and the release checks; Publish and every deploy wait for you.
mark "Landing" "about 6 min end to end"
== Each approved branch ==
"Landing" ok | "Merge onto newest main in the merge copy" -> "Install when package-lock.json changes: npm ci --offline" -> "Typecheck: npm run typecheck (≤ 5 min)" -> "Unit tests: npx vitest run (≤ 15 min)" -> "Build: npm run build (≤ 10 min)" -> "main moves to the tested commit" -> "Push (leak scan first)" | "3 required checks"
"Picked by the merge thread" info | "Browser tests: .sova/bin/e2e (≤ 30 min, needs web)" | "when src/ui/ changes"
== A release ==
"Release v${version}" ok | "Pick the version · Before publish" -> "Write the notes · Before publish" -> "Bump package.json · Before publish" -> "Make the release commit · Before publish" -> "Sova: checks (landing set + e2e)" muted -> "Sova: Publish v${version}, moves stable (your click)" accent -> "Publish the GitHub release page · After publish" | "release commit, semver"
== Deploy (yours) ==
"Deploy production" info | "Plan (your click): on main, pushed, a release, smoke tests, fly checked" accent -> "Run (your click, confirmed)" accent -> "deploy: fly deploy --remote-only" -> "verify https://${host.APP_HOST}/health → 200" | "rollback: previous verified commit"
```

Under the drawing, in words: what you measured, what is still a question, and what the user will see
once it lands (every branch through the queue; Start Release on the Releases tab; Plan Deploy on the
Deploy card).
