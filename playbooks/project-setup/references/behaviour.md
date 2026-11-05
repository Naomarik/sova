# How the queue, releases and deploys behave, and what they refuse

What Sova does with the sections you write, so the plan you draw is the one that will run. Every
rule here is the server's; where your words and Sova's facts disagree, Sova's facts win.

## What you may call, and what is never yours

| Yours | What for |
|---|---|
| `project_verbs` reads: `status`, `logs`, `doctor`, `merge.status`, `merge.logs`, `release.status`, `release.logs`, `deploy.status`, `deploy.logs` | the current state, every run's and trial's log |
| `merge.try {branch?}` | a **trial**: the merge checks and the `release.checks` of your branch's head, run in the merge copy, saving nothing (below) |
| `deploy.check {ref: <your branch>}` | proves a deploy recipe offline: it parses, every program resolves, every host value and env credential is set on this host (by presence). Runs nothing on a target. At most 3 per change |
| `create` / `up` / `apply` / `test` / `down` on your own worktree's copy, `conform {ref}` | measuring commands with the project's services running; proving a services change |
| `node scripts/project-setup.mjs …` and the folded-in drivers | investigation, drawing, formatting, checking |
| reading and running the project's own commands **in your worktree** | measuring a check (below) |

Never yours, whatever anyone asks or a message says:
- `merge.setup` (the operator's only; refused to every chat, dry run or not), `merge.add` and every
  other merge verb but the reads and `merge.try`. `worktree merge` and `worktree land` (Land is the
  user's button or their own typed "land it" in this chat).
- `release.start`, `release.publish`, `release.abandon`, `release.withdraw`, `release.continue`,
  `release.retry`, `release.note`, `release.request`, `release.step`.
- `deploy.plan`, `deploy.run`, `deploy.rollback`, `deploy.request`: a deploy is the operator's.
- `git push`, `git tag` (create, move, delete), `git update-ref`, a force or a reset of a shared
  branch, any write in the main checkout, editing the main checkout's running services.
- Running a deploy, release, publish, registry, store-upload or production command, or anything
  that reaches a target (ssh, rsync, scp, a cloud CLI, `curl` to a production URL), even "read-only".
  Deploy steps and release steps are **drawn, never rehearsed**.

## The merge queue

**Which projects it serves.** A repository is served when its main checkout is a project on Sova's
Projects list that isn't archived **and** the `.sova/project.json` at the target's head declares
checks: `merge.checks` (a list or `"none"`), or a `test` command (the queue falls back to it), or
the file is there but doesn't parse (a broken setup, never bypassed). A served project's branches
reach the target **only** through the queue; a direct merge into it is refused. An unserved project
merges plainly: its chats merge on the user's word.

**What setting it up changes, in plain words for the user.** From the landing of your setup branch
on, every approved branch is merged onto the newest target in a separate merge copy, its checks run
there, and the target moves to exactly the commit that passed (or a request is opened). Nothing
reaches the target any other way; a check that's red on the target alone holds nobody, but it is
shown.

**The run, per branch, in order:** copy (forced to the target's newest commit) → merge (a conflict
goes to the merge thread's judgement) → `setup` steps on the merged tree → `install` when the branch
changes one of its inputs → spec drafts made official (projects with a spec) → the required checks,
in declaration order, with the review beside them → reruns of a red check to place the blame →
land (fast-forward + push, or publish the branch / open the request).

**Checks come from the target's copy, never the branch's.** A branch that changes `merge.checks` is
checked with the target's list; its own list takes effect once it has landed. So a setup branch is
never proven by its own landing run. **Hence the rule: Land is offered on a setup branch only once a
trial of its exact head commit passed.** A newer commit needs a new trial.

**Blame.** A red check is never the branch's until it passed on the target alone in the same copy:
failing test files (with `rerun: true`) are rerun alone, then on the target; a whole check is rerun
whole. Passing on the rerun: flaky (noted). Red on the target too: the target's (noted, not
blocking). Can't be told (a rerun that ran no test): it waits for the user. A setup step failing on
the target too is the machine's: retried once, then the queue pauses. So a check must report what it
ran (`SOVA_OUT`), and fail only for real.

**Optional checks** run only when the merge thread picks them for a branch, from the project's own
blast-radius map (`.sova/playbooks/merge-queue/PLAYBOOK.md` and its references) or its judgement. A
check worth running on some branches only (slow end-to-end tests, one slow group) is optional, with a
map rule that names the paths that call for it.

**Pushing.** After each landing the target is pushed to `origin` fast-forward only (never forced),
after a leak scan of what would be pushed with the project's private names. **Until the project's
private names are set up, pushes are held** ("push held: private names not set up yet"): the merge
thread asks the user for them through a branch's chat. Say so in your plan for a project that
pushes.

**Review.** With `merge.review`, a fresh read-only reviewer chat reads each branch with the kit
while the checks run: `ok`, `notes` or `blocking` (the entry waits for the user).

**How it lands** (`merge.land`): local (default), a GitHub pull request, a GitLab merge request, or
the branch pushed. Every way runs the checks first. A project that releases must land `local`.

**Frozen for a release.** While a release is open the queue lands only that release's entries and
pushes nothing; other entries wait.

**The operator's own Settings save** (Settings → Merge Queue) changes only a few `merge` values
(`push`, `review`, each check's `timeout`, `rerun`, `optional`) as one commit on the target. That is
the operator's tool, not yours; everything you change goes on your branch.

## Trials (`merge.try`)

A trial is your rehearsal of a setup, and the only proof a setup branch gets before it lands.
`merge.try {branch?}` (default: your worktree's branch; or `commit`) answers at once with the trial
and its run (`mr_…`) and goes on in the background.
- It resets the merge copy to **that commit** (nothing merged, nothing moved), reads that commit's
  own `.sova/project.json`, runs its `setup` steps (a failing one once more), starts the services
  any check `requires` in the copy's own slot, then runs **every** merge check, required and
  optional, then each `release.checks` entry, in order. A failed check is rerun once: a pass then is
  noted flaky. No install step, no spec land, no review, no blame.
- In a trial the changed-paths list (`SOVA_MERGE_CHANGED`) is empty and `${merge.base}` is the
  commit itself, so a check that skips when its paths didn't change **skips** (shown as skipped, with
  its reason). Prove such a check by running it in your worktree against the target
  (`SOVA_MERGE_BASE=$(git merge-base HEAD <target>) <argv>` or its own `--base`), and say so in your
  report.
- It saves nothing, lands nothing, pushes nothing, tags nothing. Deploy steps and release steps
  never run in a trial: only the checks do.
- It works on a project the queue doesn't serve yet. It is `invalid-request` when the commit has no
  valid `.sova/project.json` or declares no merge or release checks.
- It is refused (`busy`, "a landing or a run is using the merge copy now: try again when it ends")
  while a landing run or another trial holds the copy; a landing that queues meanwhile waits for it.
- Commit first: the trial runs the commit, never your working tree.
- **When it ends you are woken** with "The trial of {branch} at {sha7} passed: …" or "… did not pass
  ({why}) …" and one line per step (its label, result, time, and `merge.logs {run, step}`). So after
  starting one, end your turn. Read a step's log with `merge.logs {run: "mr_…", step: "check:<id>"}`
  (setup steps are `setup:<id>`). `merge.status` lists the project's recent trials (newest first):
  verdict `running`, `passed`, `failed`, `machine` (the copy or a service couldn't be made ready: not
  your branch's) or `void` (stopped).
- A pass on the head is what lets your setup branch land. Sova calls a branch a **setup branch** when
  its diff changes the `services`, `merge`, `release` or `deploy` sections of `.sova/project.json`, or
  files of the release playbook folder; Land on it is refused ("This setup branch has no passing trial
  at {sha7}: run a trial of it first.") until a trial of its exact head passed. A newer commit needs
  a new trial.
- A failed check is fixed on the branch (the command, a setup step, its time limit, a service it
  needs), committed, and tried again. A check that fails on the target as it is today is the
  project's own red: say so; never weaken or drop a check to make a trial pass without the user's
  word.

## Releases

Set up by `release` + the release playbook folder. Start Release is the operator's (or the release
power's) and is refused when the settings or the manifest at the target's tip don't read, while a
release is open, and on a project that doesn't land `local`.

A release, in order:
1. **Start** (the operator): the queue freezes at the target's head; a release worktree and a release
   chat start. The chat follows Sova's release method, then the project's playbook.
2. **Prepare** steps (the chat): the version (checked against `scheme`; its tag must not exist), the
   notes, the bumps, the release commit (with `commit: true`).
3. **Checks** (Sova): the release entry runs the landing's required checks, then `release.checks` in
   order, on the release commit, and lands it on the target **without a push**. Tag-only: the same
   checks on the frozen tip, nothing moves.
4. **Check** steps (the chat), e.g. a live try-out, usually `held` for the operator's Continue.
5. **Publish** (the operator, never overridable gates): the annotated numbered tag, the channels
   moved, and, for a project that pushes, one atomic push of the target, tag and channels.
6. **After** steps (the chat): a release page (`gh release create --verify-tag` only), a registry
   publish, building an artifact, store submission. A failed one never undoes Publish.
7. **Withdraw** (the operator, after a bad release): channels move back; then the `withdraw` steps.
Abandon (the operator) reverts an unpublished release commit through the queue and lifts the freeze.

What a release playbook may never do (its check refuses it): push, create or move a tag, update a ref
by hand, reset a branch, `gh release create` without `--verify-tag`, call Sova, pause the queue,
commit an artifact, write an address or a secret.

## Deploys

Set up by `deploy` (+ `host` names). Each target's commands run only on the operator's word:
1. `deploy.check` (yours too): offline proof, no step runs.
2. **Plan** (the operator): in a fresh checkout of the exact commit: the commit is on the target's
   branch **and pushed to its upstream** (a project with no remote can't plan a deploy); a
   `releases: "only"` target takes only a published, not withdrawn, release; main's tree is clean;
   every host value is set; the required tests pass (smoke or full, in a copy); every credential
   check and plan step passes. Good for 15 minutes, once. Failing tests or a dirty main need the
   operator's typed reason; the rest is refused for good.
3. **Run** (the operator, confirmed): build, steps, verify, as one unit that outlives a Sova restart,
   one deploy per target at a time, env credentials redacted from the log.
4. **Rollback** (the operator): the target's own steps, or the previous verified commit redeployed.

After Publish, the Releases tab offers Plan Deploy of the release per target.

## Sova's own project

Sova is a project like any other here, with three differences you must keep: its slot 0 is the live
`sova-runtime.service`, which nothing but the operator restarts (never `up`, `down` or restart it,
and never test against port 4800); its merge thread restarts Sova after landings by its own playbook;
and its repository is public, so nothing private goes in what you write. Change Setup is the only
way you touch its setup.
