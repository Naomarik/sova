# The interview

You run with `align` on. Everything the repository and your measurements can't settle is an
alignment question, never a guess: one question per decision, several decisions in one interview,
each with the options you found (quoted from the repository where they come from it), what each means
for the setup, and **your recommendation with its reason**. Then end your turn; the answers arrive as
the next message. Ask again whenever an answer leaves a field open. Never ask what a file, a command
or a measurement answers, and never ask for a Land or a merge: that is the user's button, after your
proposal.

Ask only the parts this setup touches: a first setup asks the landing questions, then offers the
release and deploy halves ("Set up releases too?", "Set up a deploy too?") with your recommendation
from what you found; a Change Setup asks only about what the user asked to change and what that
change forces (a new check that needs a service: which one).

## Landing (the merge queue)

1. **The target**: the branch every change lands on. Offer the main checkout's branch and the default
   branch on `origin`; recommend the one CI protects.
2. **The checks**, as one decision with every candidate listed: for each, its exact argv, its warm and
   cold time **as you measured them**, what it needs, and whether it is green on the target today.
   Offer: required, optional (picked by path), release-only, or left out. Recommend: required for
   what is fast and catches most breakage (types, lint, unit tests, build), optional for slow suites
   that only some paths reach, release-only for what is slow and broad. A check red on the target
   today: recommend fixing it first or leaving it out, never requiring it blind.
3. **Time budget**: how long a landing may take end to end (the sum of the required checks' warm
   times, plus setup and install). Recommend a split or optional checks when the sum passes ~30 min.
4. **Services the checks need**: each datastore or process, how it runs per copy, and whether its
   data may be seeded from the main checkout. Recommend an on-demand service over anything shared.
5. **Secrets the tests need** (only when a test reads one): copy a gitignored local file into the
   merge copy at setup, skip those tests at landing, or stub them. Recommend skipping at landing and
   running them in a release check or by hand.
6. **How a branch lands**: Merge locally, a pull request (GitHub), a merge request (GitLab), or push
   the branch only. Say what `origin` suggests and that a project that releases through Sova must
   land locally. Recommend Merge locally unless the team reviews on the host.
7. **Push**: push the target to `origin` after each landing (default with an `origin`), or keep it on
   this machine. Say that pushes wait for the project's private names (the merge thread asks for
   them).
8. **Review step**: a read-only reviewer chat beside the checks, with a review kit you write (a
   `PLAYBOOK.md` with the project's review rules), or none. Recommend none on a first setup unless
   the user asks; it adds a chat per landing.
9. **Install**: the lockfiles that trigger the offline install, and its command (measured). No
   question when there's one lockfile and one obvious frozen form: say what you'll write.

## Releases (folded in from the Release playbook maker)

Offer Sova's starter as the default answer to each (`../release-maker/references/release.md`, "The
starter"), beside what `release-maker.mjs candidates` found, with your recommendation:

1. **What a release is here**: who gets it and how (an installer following a channel, a package
   registry, a download page, an app store, only this machine, a deploy of a tagged commit), in one
   sentence.
2. **Tag and scheme**: the tag pattern (the one the history uses, else `v${version}`) and `semver`,
   `calver` or `none`.
3. **Channels**: the moving tags Publish moves (the moving tags found, else `stable`), or none.
4. **Release commit or tag-only**: a commit through the queue (a changelog entry, version bumps), or
   a tag of a landed commit as it is.
5. **Version rule**: how the number is picked from what landed since the last release, deciding every
   case (the release chat picks it alone).
6. **Notes**: where they live (the changelog found), heading, audience, style; what a user must be
   told (what to do differently, what going back costs).
7. **Version files**: each file that holds the version (each one found, quoted), and any other
   per-release edit.
8. **Release-only checks**: what must pass on the release commit beyond the landing checks (the
   optional checks, the full suite, a package dry run), each by merge check id or its own command.
9. **Judgement steps**: what a person must look at before Publish (a live try-out), each a held step.
10. **After publishing**: each thing done once it is out (a release page, a registry publish, building
   and filing the built app, a store submission, an announcement), in order, with its exact commands
   as the user runs them today, quoted, never inferred.
11. **Artifacts**: for built files, where they are built and kept (outside the repository, or under an
   ignored path); never committed.
12. **Deploys after a release**: which deploy targets follow a release (Plan Deploy is offered after
   Publish), and whether a target takes releases only (`releases: "only"`).

## Deploy (folded in from the Project deploy playbook)

Ask, with what `project-deploy.mjs candidates` and `targets.md` found as options:

1. **Targets**: which places it ships to, a name for each, one sentence on what each is; or none.
2. **Branch**: per target, the branch a commit must be on (and pushed) to ship there.
3. **Steps**: per target, the exact commands in order as the user runs them today. Offer every
   candidate quoted (a package script, a task, a deploy script, a CI deploy job) and ask which is
   real, in what order, with what arguments. A shell pipeline becomes a `.sova/bin/` script only
   when the user agrees; its text is then part of what they land.
4. **Build**: what is built first; say that it builds in a fresh checkout of the commit.
5. **Addresses**: a host variable name for every host, user, path, URL, account, project, bucket or
   app a step names. Its value is set on this host by the user (Sova's `host.json`), never in the
   repository.
6. **Credentials**: per target, each credential by name and kind (`env`, `ssh`, `tool-login`) and the
   read-only command that proves it. Never ask for a value.
7. **Verify**: the URL that answers when it's healthy and its status, or none.
8. **Rollback**: its own steps, `redeploy-previous`, or none (the user's reason, word for word).
9. **Tests before shipping**: the smoke selection, the full suite, or none.
10. **Plan steps** (optional): read-only commands that show what a deploy would change.
11. **Never**: what must never happen on that target (restart while jobs run, touch shared data,
    deploy on a weekend). Each answer becomes a step's guard in its script, or a held step.

## Writing a question well

- Lead with the decision in plain words, then the options, then the recommendation: "Which checks
  must pass before a branch lands? Measured in my copy: typecheck 41 s, unit tests 3 min 10 s (green),
  build 1 min 5 s, e2e 14 min (2 flaky of 120). I recommend typecheck, unit tests and build required,
  e2e optional for changes under `src/ui/`."
- Name the cost of each option the user can't see: a 25-minute required check makes every landing
  25 minutes; a check red on main holds every branch; `github-pr` can't release through Sova.
- Never offer an option the server refuses (a check over 1800 s, a shell string, a release on a
  request-landing project, a deploy value in the repository).
