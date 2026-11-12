# Worked example: Sova's own setup, and a Change Setup on it

Sova is a set-up project: its `.sova/project.json` declares every half, and its own playbooks under
`.sova/playbooks/` add to Sova's general methods. A Setup chat on it is always a **Change Setup**.
Read the files themselves before you rely on a line here: they are what runs, this page is how to
read them.

## What it declares, and why each part is there

**Services** (kept, never changed by a pipeline change): three `setup` steps (`mise-trust`;
`node-modules`, which copies the main checkout's `node_modules` with `scripts/copy-tree.mjs`, keyed on
`pnpm-lock.yaml`; `agent-dir`, the copy's own hermetic `.agent`), and one service, `server`
(`pnpm run dev:hermetic`, port base 4810 stride 10, ready on `/api/health`). Its slot 0 **adopts**
`sova-runtime.service`: the live server, which Sova only reads; `up`, `down`, `reset` and `teardown`
of slot 0 are refused, and you never restart it. `test` is `node scripts/run-tests.mjs` with the
smoke selection `shared/project-contract.test.ts`. `share: {"allow": false}`.

**Landing** (`merge`): target `master`, `push: true`, the review kit `.sova/playbooks/review`, and an
offline install keyed on `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`
(`pnpm install --frozen-lockfile --offline`). Nine required checks, in this order: `typecheck`,
`unit` (`rerun: true`), `integration` (the landing set: `--integration --landing --base
${merge.base}`, `rerun: true`), `extensions` (only the changed extensions' suites), `spec-replay` and
`statecharts` (each skips itself unless its paths changed), `build`, `spec`, `leak-scan`. Two
optional: `e2e` (a build, then the browser walkthroughs named by the pick's `select`) and
`integration-group` (`--integration --picked-groups`: one slow group per pick; with none picked, as in a
trial, the slow groups a landing runs for the branch's changes, or Skipped "no slow group applies to
this branch's changes"). The heavy test checks run under `scripts/nice.mjs`, at
lowered CPU priority, so a landing never starves the live server. Every limit is at most 1800 s.

Why it reads this way: fast, broad checks first (a typecheck fails in a minute, before a 25-minute
suite); checks that would be wasted on most branches skip themselves from `$SOVA_MERGE_CHANGED`
instead of being optional, so they still run when their paths change without anyone picking them;
truly slow, path-specific work is optional and picked by a map.

**The merge thread's additions** (`.sova/playbooks/merge-queue/`): what is worth noting on a Sova
landing (`references/noting.md`), the blast-radius map (`references/blast-radius.json`: path globs →
a check id, an optional `select`, a `why`), and "When the queue is idle", the one place anything
restarts Sova (`scripts/restart-sova.mjs`). A new optional check gets its map rule in the same
branch, or the thread never picks it but by judgement.

**Releases** (`release`): the playbook `.sova/playbooks/release`, tag `v${version}`, `semver`, the one
channel `stable` (the installer follows it), a release commit, and seven release-only checks declared
in the section itself (`release-notes`, `release-integration` with every group, `release-extensions`
with every suite, `release-spec-replay`, `release-site`, `release-spec`, `release-leaks`; what each
covers: `.sova/playbooks/release/references/checks.md`). `release.json`: `version`, `notes`, `bump`,
`stamps`, `docs`, `commit` before publish; `try-live` (held: the operator applies the release on the
live server, then Continues); after publish `release-page` (`gh release create --verify-tag`) and
`outside-checks` (held); `release-page-withdrawn` after a Withdraw.

**Deploy** (`deploy`): one target, `site` (the landing page and docs on Cloudflare Pages), on `master`,
`releases: "only"`, `requires: {tests: "none"}`; credentials `cloudflare` (`tool-login`, checked by
`wrangler whoami`) and two `env` credentials (`SOVA_SITE_PAGES_PROJECT`, `SOVA_SITE_VIDEO_DIR`)
checked by the release driver's `env-set`; build `video`, `install`, `site`; one step `pages`; a
`verify` of the public site; rollback `redeploy-previous`.

`project-setup.mjs draw` draws all of it; `check --base master` passes, with one note it carries over:
the site target's verify URL (and its `site` build step's `SOVA_SITE_URL=` argument) name the public
site's address literally, and the deploy lint flags the verify URL (a public site's own address is not private; changing it to a `${host.…}` name is
the user's call, never a side effect of another change).

## A Change Setup, step by step

The user opens Change Setup from Settings → Merge Queue: "Check that the docs site still builds when
a branch touches it, not only at release time."

1. **Read the opening block and draw.** `## Current setup` holds the sections; `draw` gives the
   opening drawing; say in one sentence what you'll look at.
2. **Investigate.** The site is `site/` (Astro, its own `pnpm-lock.yaml`, build = `astro build` plus
   its docs leak check). It already runs at release as `release-site`
   (`sova-release.mjs site-check`: an offline-first install of `site/`, the build, then checks on the
   built landing that are about the release). `merge.install` doesn't cover `site/pnpm-lock.yaml`.
3. **Measure in your worktree.** Run the site's install and build as a check would, from the
   worktree's root with the clean environment (`investigate.md`), cold then warm; note whether the
   install needs the network (a cold store does) and whether `site-check`'s release-specific checks
   pass on master between releases. Record the argv, both times and the exits.
4. **Ask** (one interview), each with your recommendation:
   - required or optional: recommend **optional**, picked by a map rule on `site/**` and `docs/**`,
     since most branches never touch the site and the build costs minutes;
   - which command: recommend a landing check that installs offline and builds only
     (`pnpm --dir site install --frozen-lockfile --offline`, then `pnpm --dir site run build`, in a
     `scripts/merge-checks/` script that writes `SOVA_OUT` and skips with a reason when nothing under
     its paths changed), because `site-check`'s release-tag assertions belong to a release;
   - its limit: twice the warm time you measured.
5. **Draw the change**: `draw --worktree --base master` after writing, the "Picked by the merge
   thread" row marked changed.
6. **Write on your branch**: the check appended to `merge.checks` (`optional: true`), its script,
   a rule in `.sova/playbooks/merge-queue/references/blast-radius.json` and a line in
   `blast-radius.md`. Nothing else changes: the services half, the release and the deploy stay byte
   for byte.
7. **Check**: `fmt`, then `check --base master` (exit 0; the carried-over deploy note stays a note);
   commit by explicit path.
8. **Trial**: `merge.try` on your branch's head, then end your turn until its wake. The trial runs
   every merge check in full, optional ones too, as though every file changed, so the new check
   builds the site there even though its script skips on a landing that doesn't touch `site/`. A
   failed step: read `merge.logs`, fix, commit, try again.
9. **Propose**: the drawing, what you measured, the trial's result (the new check's time in it), the files changed, and that Land is on the branch now that its head passed; once it lands, the next landing that touches the
   site builds it.

Never in this example: editing `.sova/project.json` on master, calling `merge.setup`, restarting or
applying the live server, running `site-pages` or any deploy step, touching the release's own
`release-site` check without the user's word.
