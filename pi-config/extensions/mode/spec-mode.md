# Minor mode: spec

`.sova/spec/` is the project's documentation: `manifest.json` records plus `claims/*.md` prose under `§` IDs. It needs no Git, no prior docs and no source annotations; never put `§` IDs or spec annotations in source code.

Trusted tools: start each bash command with:

```sh
core="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; case $core in "~"|"~/"*) core="$HOME${core#\~}";; esac; core="$core/extensions/spec/core"
```

`node "$core/sova-spec.mjs" <command> --root <project root> --json` only reads; command is `check`, `census`, `scope '<§id>' [--budget <bytes>]` or `impact '<§id>'`; `--spec <dir>` reads a draft instead. A project's own copy is foreign code: read it and ask before running it; never run other project scripts, installs or network commands for this. Without trusted tools, say so and read the files directly.

Every behavior change is spec'd. Exempt: work changing no behavior (refactor, tests, tooling); say you claim the exemption.

Before coding:
1. Name the root ID(s) and why. Run `scope`, and `impact` on anything others require. Work from the returned passages as written.
2. Keep the frontier in view: uninvestigated requires, dangling edges, unread passages, missing code. Exit 0 means the declared closure was delivered, not that the context is complete; 1, relevant gaps; 2, an unreadable spec, except `manifest-not-found`: no spec yet, so start a draft.
3. Reconcile what the task relies on against source. Labels are declared, never proof: `migrated` text is the requirement with its implementation unreviewed; `candidate` is a proposal. Old docs that redirect into `.sova/spec/` are not a second authority. A test found by name is candidate evidence until you read its assertions.
4. Behavior no claim covers gets a new claim in a feature draft before coding.

Documentation changes only through drafts, never by editing current `claims/` or `manifest.json`: `node "$core/sova-spec-draft.mjs" <command> --root <project root> --json`.
- `new <name> --write` copies the whole current spec (or starts one); edit only `.sova/spec/drafts/<name>/spec/`. `status`, `diff`, `check` never write.
- Documenting what the code already does is its own baseline draft, never mixed into a feature draft. Claim only files the task changed (each record's `code`); unchanged dependencies are not spec'd; `requires` names only existing claims. Write `"requires": []` only after investigating; otherwise omit the key.
- A feature's proposal stays in its draft; agreement approves intent, not current truth. After implementing, verify each changed promise. Relabel each record as it will read once current: explicit `authority`: `accepted` for new or rewritten prose (the task's go-ahead adopts it), `migrated` only for text still as ported, never `candidate`; `evidence` to what you actually did. Then `evidence <name> --id '<§id>' --by <who> --verification <text>` with `--commit <rev>` (Git: the implementation's existing commit), `--snapshot` (no Git) or `--doc-only` (notes, sections), plus `--write`.
- `promote <name> --id '<§id>'` previews a plan; `--plan <sha> --write` applies it. Promote only what is implemented and verified. A refusal is resolved, never forced. A `conflict` is whole-file: re-apply in a new draft from current. After an interrupted promotion, `recover`, then `recover --write`.

Before finishing:
- `node "$core/sova-spec.mjs" census --changed --root <project root> --json` must report no in-boundary changed file unclaimed (`--spec` the draft's `spec/` until promoted; `--base <rev>` once committed). Pre-existing unclaimed files aren't the task's job.
- Read `$core/../PROMOTE.md`; promote what you verified, or say in your reply why not.

The task's go-ahead authorizes its drafts, evidence and promotions as one bounded batch; no dialog per claim, and nothing at session start. It is not permission to commit: without that, leave evidence pending, and never commit unrelated changes. Review packets: `sova-spec-review.mjs`, see `$core/../README.md`. No check, record, evidence or promotion proves correctness; no tool checks meaning.

A worker gets only the passages and unknowns relevant to its part, quoted literally.
