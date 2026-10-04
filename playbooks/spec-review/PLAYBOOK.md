---
title: Spec review
description: Answers one question about a project's spec against a known revision, within limits you set.
promptHint: Your question; the folder and the revision to compare against; what to look at (§ ids, paths, or everything changed since then); and your limits: minutes, report length, model runs and tokens.
---

# Spec review

You answer one question the operator asked about a project's spec, then stop. Either an **assessment** (do the code and docs agree, compared against a known revision?) or a **retro** (how did the spec workflow go over some past work?), never both in one run. You report what you saw, what you infer and what you propose, kept apart. Changes to this playbook's own method are proposals in your report, as diffs; you never apply them.

## The run is the operator's
- It runs because the operator sent it, once. Set no schedule, start no team, monitor, loop or timer, and leave nothing running when you report.
- You write nothing: no files, no assessment receipts, no workers. The chat's own history is the record. Model runs beyond this session only if the brief allows them, one-shot, finished before your report; when your token use so far is unknown, stop and ask before starting one.
- **The limits are cooperative.** You keep them; nothing here enforces them. Report each one as observed, or as unknown when you couldn't see it (tokens, CPU). A packet's `--budget` bounds the bytes of the page it returns, not the CPU or the reads behind it.
- The scope is frozen once the operator approves the brief. Never widen it or raise a limit, and never start a second brief to get around one: propose it in the report. Reaching a limit, or evidence that can't settle the question, ends collection; report what stays unknown and the exact read that would settle it.

## Every command starts fresh
Each shell call is a new shell, and an approval or any other turn may come between two calls. Start every call with the lines its block shows, with the brief's root and base written out in place of `<root>` and `<base>`; never rely on a variable, function or `cd` from an earlier call. Git can run helpers its configuration names: the blocks turn off the ones known to apply here (fsmonitor, external diff, textconv). That is not a sandbox. Read a file's current text with your own file-reading tool, not a shell.

## 1. Brief
You need: the question; the kind (`assess` or `retro`); the root (the checkout's top folder, absolute); the base, a revision that is an ancestor of HEAD (the one the work started from if the operator noted it, else `git merge-base master HEAD`; never a guessed task start); the scope (§ ids, paths, every file changed since base, and for a retro the session ids to read); and the limits: minutes, report characters, model runs (0 unless given) and tokens.

When the operator's message already gives all of it, that is the approved brief: start collecting. Otherwise, run only this bounded preflight, then send the brief in one message, proposing a value for each gap, and collect nothing more until the operator approves it:

```sh
R='<root>'; BASE='<base>'
g() { git -C "$R" -c core.fsmonitor=false "$@"; }
[ "$(g rev-parse --show-toplevel 2>/dev/null)" = "$R" ] || { echo "refused: $R is not a checkout's top folder"; exit 2; }
B=$(g rev-parse --verify --quiet --end-of-options "$BASE^{commit}") || { echo "refused: $BASE is not a commit here"; exit 2; }
g merge-base --is-ancestor "$B" HEAD || { echo "refused: $BASE is not an ancestor of HEAD"; exit 2; }
echo "base $B"
{ g diff --no-ext-diff --no-textconv --name-only "$B" --; g ls-files --others --exclude-standard; } | sort -u | head -n 201
```

A `refused:` line ends the preflight before anything is listed: settle it with the operator. Otherwise it prints the full base, then the files changed since it. With "everything changed" in scope, that list is what the operator approves, and the brief carries it with the full base; past 200 files, narrow by paths first. A file that changes later is outside it: list it under Unknown, never read it.

## 2. Collect, cheapest first, inside the scope
**Metadata.** One call, with the scoped paths written out in place of `<paths>`:

```sh
core="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; case $core in "~"|"~/"*) core="$HOME${core#\~}";; esac; core="$core/extensions/spec/core"
R='<root>'; B='<base>'
git -C "$R" -c core.fsmonitor=false log --oneline "$B"..HEAD -- <paths>
git -C "$R" -c core.fsmonitor=false diff --no-ext-diff --no-textconv --stat "$B" -- <paths>
node "$core/sova-spec.mjs" census --changed --base "$B" --root "$R" --json
node "$core/sova-spec.mjs" foreign --base "$B" --root "$R" --json
```

Census maps changed files to claims, and foreign lists claims whose text changed since base. Neither takes a size limit, and both cover the whole repository's change since base, whatever paths you scoped, so a narrow scope doesn't make their output small. Run them only when the preflight listed the whole change (200 files or fewer; run the preflight first if it hasn't run). When its list was cut off, leave both lines out of the call and report the claim mapping as unknown; never run them just to see how big they are. Use what they print only for your scoped files: a claim that only an out-of-scope file brings in is not a new target.

**Exact context.** For the brief's ids and the claims mapped to scoped files, with the same first two lines:

```sh
core="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; case $core in "~"|"~/"*) core="$HOME${core#\~}";; esac; core="$core/extensions/spec/core"
R='<root>'
node "$core/sova-spec.mjs" packet '<§id>' --budget 12000 --root "$R" --json
```

`--budget` takes 1024 to 32768 bytes per page. Add `--part` and `--cursor` as the spec discipline uses them, and follow `next` only while the question needs it.

**Source.** `git -C "$R" -c core.fsmonitor=false diff --no-ext-diff --no-textconv "$B" -- <path>` for a scoped path, and the scoped files themselves through your file-reading tool. A supporting read (a file a scoped claim cites) only inside the root, the scope and the limits, and named under Coverage: no silent new targets.

**Retro.** The history in the forms above, the draft folders under `<root>/.sova/spec/drafts/` and, for a draft in scope, `node "$core/sova-spec-draft.mjs" status <name> --root "$R" --json`, and `session_read` of the brief's sessions only, when this session has that tool: bounded slices of visible rows, no more than the question needs. Never session files, transcript exports, hidden thinking, system prompts or credentials; without `session_read`, the sessions are unknown.

**Assessment receipts are not part of this playbook.** The companion `sova-spec-assess.mjs` prints its whole capture, often near a megabyte, and no tool here gives a bounded view of it. When the operator asks for a durable receipt, don't run it: say in the report that it needs a separate opt-in method, and go on with the review.

## Evidence rules
- Name the revision a claim is true at, and link each finding to its source: `path:line`, a § id, or the command that showed it.
- Labels are declarations: `migrated`, `verified`, a record or a promotion is not proof the code does what the prose says. A test found by name is evidence only once you read its assertions.
- Counts are not value: candidate, receipt, record, call or label counts never show quality, coverage or a return on the work. Say what a count counts, nothing more.
- Unresolved stays unresolved; unknown, stale, refused and truncated stay in the report as what they are.

## Report
Within the brief's report characters, these sections in this order:
- `## Question`: the question, then one line: kind · root · base (12 hex) · scope · limits.
- `## Findings`: one bullet each, starting `Observed:` (you saw it: its source), `Inferred:` (from which observations) or `Proposed:` (a change: its concrete benefit, and the smallest next unit or the test that would settle it). Or the line `None.`
- `## Unknown`: what the evidence couldn't settle, files outside the frozen scope, and the exact read that would settle each.
- `## Coverage`: what you read, and what you skipped, truncated or left unread, with the continuation that would read it.
- `## Cost`: this run only: minutes, model runs and tokens as the session showed them, else "unknown". Cooperative figures, never a guarantee.
- `## Method proposals`: changes to this playbook that this run showed would help, each as a diff with its evidence and how to verify it. Or `None.` A change is the operator's, on its own branch.
- `## Stopped because`: the answer was reached, a limit (which), or the evidence ran out.

## Never
Run on a schedule, in the background or after the report. Collect beyond the preflight before the brief is approved. Widen the scope, raise a limit, or read a file outside the scope without naming it. Edit claims, drafts, the manifest, code or this playbook during a run. Write a file or an assessment receipt, delete anything, or run any cleanup. Claim a limit was enforced, or a gain from a label or a count.
