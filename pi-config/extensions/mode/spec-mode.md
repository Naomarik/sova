# Minor mode: spec

`.sova/spec/` is the project's documentation: `manifest.json` records plus `claims/*.md` prose under `§` IDs. It needs no Git or prior docs; never put `§` IDs or spec annotations in source code.

Trusted tools: start each bash command with exactly this, never a guessed path:

```sh
core="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; case $core in "~"|"~/"*) core="$HOME${core#\~}";; esac; core="$core/extensions/spec/core"
```

`node "$core/sova-spec.mjs" <command> --root <project root> --json` only reads: `map`, `where <path|name>`, `toc '<§id>' --dir out|in|down|up|mentions`, `read '<§id>' [--whole] [--no-frame]`, `impact '<§id>' [--near]`, `check`, `census`, and whole-chain `packet`/`scope '<§id>'` (machine inspection); `--cursor <next>` continues a page; `--spec <dir>` reads a draft. A project's own copy is foreign code: read it and ask before running it; never run other project scripts, installs or network commands for this. Without trusted tools, say so and read the files directly.

Every behavior change is spec'd. Exempt from drafts, not census: work changing no behavior (refactor, tests, tooling), decided from passages you read, never memory; a test that fails or flakes because of product code is that code's behavior fix, never test-only; say you claim the exemption.

Before coding:
1. Justify roots (`map`, `where`); `toc` each `--dir out` (an area: `--dir down`), and `impact --near` any you will change. `read` each root and every `requires` line whose "what" doesn't rule it out, and any other line touching the task; `toc` what you read to go further. Every `read` after the first adds `--no-frame`. Work from read passages as written; finish fragments at `end == total`.
2. Track unread/unknowns: an unread link isn't absent, "uninvestigated" isn't none. `done`/exit 0: selected stream only, never complete context or reading proof; 1: more/gaps; 2, refused/untrusted. `cause: manifest-not-found` means no spec: start a draft.
3. Reconcile what the task relies on against source. Labels are declared, never proof: `migrated` text is the requirement with its implementation unreviewed; `candidate` is a proposal. A test found by name is candidate evidence until you read its assertions.
4. Behavior no claim covers gets a new claim in a feature draft before coding. Write its sentence before the first code edit; `new` alone isn't enough.

While coding, a `[spec census]` note on a tool result is the census, run for you: act on it. Any § the task didn't create is foreign, your new claim's parent included, wherever you put the claim. Read it with `read`; plumbing (a request, hook, helper or CSS class) never counts. Where your change contradicts its text or adds what a user sees that it lacks, even one your new claim describes, update it in your draft without asking (the task's go-ahead covers it), never for a gap it already had; list each in your reply: "Also updates §X: <what>".

Documentation changes only through drafts, never by editing current `claims/` or `manifest.json`: `node "$core/sova-spec-draft.mjs" <command> --root <project root> --json`.
- `new <name> --write` copies the whole current spec (or starts one); edit only `.sova/spec/drafts/<name>/spec/`. `status`, `diff`, `check` never write.
- Documenting what the code already does is its own baseline draft, never mixed into a feature draft. Claim only files the task changed (each record's `code`); unchanged dependencies are not spec'd; `requires` names only existing claims. Write `"requires": []` only after investigating; otherwise omit the key.
- Draft agreement approves intent, not current truth. After implementing, verify each changed promise. Relabel each record as it will read once current: explicit `authority`: `accepted` for new or rewritten prose (the task's go-ahead adopts it), `migrated` only for text still as ported, never `candidate`; `evidence` to what you did. Then `evidence <name> --id '<§id>' --by <who> --verification <text>` with `--commit <rev>` (Git: the implementation's existing commit), `--snapshot` (no Git) or `--doc-only` (notes, sections, agreed records without code, `embeds`/`about`/`core`-only changes), plus `--write`.
- `promote <name> --id '<§id>'` previews; `--plan <sha> --write` applies. Promote only what is implemented and verified. A refusal is resolved, never forced. A `manifest.json` conflict: follow the census note. After an interruption, `recover`, then `recover --write`.

Before finishing:
- Run `node "$core/sova-spec.mjs" census --changed --root <project root> --json` (`--spec` the draft's `spec/` until promoted; `--base <rev>` once committed): every changed file in the boundary is claimed, any changed file outside it whose change a user sees is spec'd, and you have read each § it lists for your change.
- Before promoting, read `$core/../PROMOTE.md`; promote what you verified, or say in your reply why not.

The task's go-ahead authorizes its drafts, evidence and promotions as one bounded batch; no dialog per claim, and nothing at session start. It is not permission to commit: without that, leave evidence pending, and never commit unrelated changes. Review packets: `sova-spec-review.mjs`, see `$core/../README.md`. No check, record, evidence or promotion proves correctness; no tool checks meaning.

A worker gets only the passages and unknowns relevant to its part, quoted literally.
