# Minor mode: spec

`.sova/spec/` is the project's documentation: `manifest.json` records plus `claims/*.md` prose under `§` IDs. It needs no Git, no prior docs and no source annotations; never put `§` IDs or spec annotations in source code.

Trusted tools: start each bash command with exactly this, never a guessed path:

```sh
core="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; case $core in "~"|"~/"*) core="$HOME${core#\~}";; esac; core="$core/extensions/spec/core"
```

`node "$core/sova-spec.mjs" <command> --root <project root> --json` only reads; command is `check`, `census`, `foreign --base <rev>`, `scope '<§id>' [--budget <bytes>]` or `impact '<§id>'`; `--spec <dir>` reads a draft instead. A project's own copy is foreign code: read it and ask before running it; never run other project scripts, installs or network commands for this. Without trusted tools, say so and read the files directly.

Every behavior change is spec'd. Exempt from drafts, not census: work changing no behavior (refactor, tests, tooling), decided from `scope` output, never memory; say you claim the exemption.

Before coding:
1. Name the root ID(s) and why; `scope` them, `impact` anything others require. Work from the returned passages as written.
2. Keep the frontier in view: uninvestigated requires, dangling edges, unread passages, missing code. Exit 0 means the declared closure was delivered, not that the context is complete; 1, relevant gaps; 2, an unreadable spec, except `manifest-not-found`: no spec yet, so start a draft.
3. Reconcile what the task relies on against source. Labels are declared, never proof: `migrated` text is the requirement with its implementation unreviewed; `candidate` is a proposal. A test found by name is candidate evidence until you read its assertions.
4. Behavior no claim covers gets a new claim in a feature draft before coding. Write its sentence before the first code edit; `new` alone isn't enough.

While coding, exempt work included, run `census --changed` (`--spec` your draft, if any) after your first edit, before the next file, and per new file. Any § the task didn't create is foreign, your new claim's parent included, wherever you put the claim; editing one in your draft flags. Read it with `scope`; plumbing (a request, hook, helper or CSS class) never flags. Flag only a contradiction, or a user-visible addition, even one your new claim describes, that its own text lacks, never a gap it already had, even one you rely on; otherwise stay silent. Batch flags in the plan as one question. A `[spec census]` note on a tool result is this census, run for you: act on it.

Documentation changes only through drafts, never by editing current `claims/` or `manifest.json`: `node "$core/sova-spec-draft.mjs" <command> --root <project root> --json`.
- `new <name> --write` copies the whole current spec (or starts one); edit only `.sova/spec/drafts/<name>/spec/`. `status`, `diff`, `check` never write.
- Documenting what the code already does is its own baseline draft, never mixed into a feature draft. Claim only files the task changed (each record's `code`); unchanged dependencies are not spec'd; `requires` names only existing claims. Write `"requires": []` only after investigating; otherwise omit the key.
- Draft agreement approves intent, not current truth. After implementing, verify each changed promise. Relabel each record as it will read once current: explicit `authority`: `accepted` for new or rewritten prose (the task's go-ahead adopts it), `migrated` only for text still as ported, never `candidate`; `evidence` to what you did. Then `evidence <name> --id '<§id>' --by <who> --verification <text>` with `--commit <rev>` (Git: the implementation's existing commit), `--snapshot` (no Git) or `--doc-only` (notes, sections), plus `--write`.
- `promote <name> --id '<§id>'` previews; `--plan <sha> --write` applies. Promote only what is implemented and verified. A refusal is resolved, never forced. A `conflict` is whole-file: re-apply in a new draft from current. After an interruption, `recover`, then `recover --write`.

Before finishing:
- `node "$core/sova-spec.mjs" census --changed --root <project root> --json` must report no in-boundary changed file unclaimed (`--spec` the draft's `spec/` until promoted; `--base <rev>` once committed). Pre-existing unclaimed files aren't the task's job.
- Your reply's last line on a turn that edited, committed, promoted or merged, exempt work included, is exactly "Also changes: §X — <what>; §Y — <what>" or "Also changes: none", nothing after; a turn that only answered writes none. It names foreign § only, never your new claims; an addition under one is that §'s change, and a § the user asked for is still foreign. Notes (the exemption, a gap) go above it. A merge or promote turn names every foreign § it lands, even if already reported, workers' included: copy the list `worktree merge` or `promote --write` prints (`foreign` for other ranges). A check returns a line missing one; if the list is wrong, write "Spec check override: <why>" right above the last line.
- Read `$core/../PROMOTE.md`; promote what you verified, or say in your reply why not.

The task's go-ahead authorizes its drafts, evidence and promotions as one bounded batch; no dialog per claim, and nothing at session start. It is not permission to commit: without that, leave evidence pending, and never commit unrelated changes. Review packets: `sova-spec-review.mjs`, see `$core/../README.md`. No check, record, evidence or promotion proves correctness; no tool checks meaning.

A worker gets only the passages and unknowns relevant to its part, quoted literally.
