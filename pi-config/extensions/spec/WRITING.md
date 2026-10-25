# Spec: the writing procedure

Read this before your first edit that changes behavior. Your prompt's spec part (`mode/spec-mode.md`) is how to find your way; this is how to write. `$core` is the trusted tools directory that part's shell line sets; never a guessed path.

Exempt from drafts, not census: work changing no behavior (refactor, tests, tooling), decided from passages you read, never memory; a test that fails or flakes because of product code is that code's behavior fix, never test-only; say you claim the exemption.

Before coding:
1. Find roots with `where` and 3–5 of the task's words, never one (`where password reset email expiry`), or a path or name; if no hit fits, try other words once, then `map` (also for a whole-area task). `toc` each `--dir out` (an area: `--dir down`), and `impact --near` any you will change. `read` each root and every `requires` line whose "what" doesn't rule it out, and any other line touching the task; `toc` what you read to go further. Every `read` after the first adds `--no-frame`. Work from read passages as written; finish fragments at `end == total`.
2. Track unread/unknowns: an unread link isn't absent, "uninvestigated" isn't none. `done`/exit 0: selected stream only, never complete context or reading proof; 1: more/gaps; 2, refused/untrusted. `cause: manifest-not-found` means no spec: start a draft.
3. Reconcile what the task relies on against source. Labels are declared, never proof: `migrated` text is the requirement with its implementation unreviewed; `candidate` is a proposal. A test found by name is candidate evidence until you read its assertions.
4. Behavior no claim covers gets a new claim in a feature draft before coding. Write its sentence before the first code edit; `new` alone isn't enough. When the task's go-ahead already agrees to it, run `agree` on it then, before that edit, not at the end.

While coding, a `[spec census]` note on a tool result is the census, run for you: act on it. Any § the task didn't create is foreign, your new claim's parent included, wherever you put the claim. Read it with `read`; plumbing (a request, hook, helper or CSS class) never counts. Where the task needs a change that contradicts its text or adds what a user sees that it lacks, even one your new claim describes, update it in your draft without asking (the go-ahead covers it and restamps any `agreed`), never for a gap it already had or a defect; list each foreign § your draft or workers edit in your reply: "Also updates §X: <what>".

Documentation changes only through drafts, never by editing current `claims/` or `manifest.json`: `node "$core/sova-spec-draft.mjs" <command> --root <project root> --json`.
- `new <name> --write` copies the whole current spec (or starts one); edit only `.sova/spec/drafts/<name>/spec/`. `status`, `diff`, `check` never write.
- Documenting what the code already does is its own baseline draft, never mixed into a feature draft. Claim only files the task changed (each record's `code`); unchanged dependencies are not spec'd; `requires` names only existing claims. Write `"requires": []` only after investigating; otherwise omit the key.
- Draft agreement approves intent, not current truth. After implementing, verify each changed promise. Relabel each record as it will read once current: explicit `authority`: `accepted` for new or rewritten prose (the task's go-ahead adopts it), `migrated` only for text still as ported, never `candidate`; `evidence` to what you did. Then `evidence <name> --id '<§id>' --by <who> --verification <text>` with `--commit <rev>` (Git: the implementation's existing commit), `--snapshot` (no Git) or `--doc-only` (notes, sections, agreed records without code, `embeds`/`about`/`core`/`notOwned`-only changes), plus `--write`. For decisions the user agreed to, `agree <name> --id '<§id>' --by <who> --verification <text> --write` stamps `agreed` with where the go-ahead is (`$SPEC_AGREE_SOURCE` if set, no `--source`; else `--source <ref>`, never a description; else report it ready, never stamp) and promotes what maps no code (`$core/../PROMOTE.md`).
- `promote <name> --id '<§id>'` previews; `--plan <sha> --write` applies. Promote only what is implemented and verified. A refusal is resolved, never forced. A `manifest.json` conflict: follow the census note. After an interruption, `recover`, then `recover --write`.

Before finishing:
- Read each § the census note's `Unread § your change landed in` line (once, after your last edit) marks read first; its `census --changed --related` command lists the rest. Every changed file in the boundary is claimed; any outside it whose change a user sees is spec'd.
- Before promoting, read `$core/../PROMOTE.md`; promote what you verified, or say in your reply why not. A branch isn't done or ready to land until its drafts are promoted on it, by you, after its checks pass; nothing at landing promotes for you. A draft whose branch already landed is promoted on a fresh branch from the default branch, never on the default branch itself.

The task's go-ahead authorizes its drafts, evidence and promotions as one bounded batch; no dialog per claim, and nothing at session start. A go-ahead to build or merge covers committing them with the code, never asked separately; told not to commit, leave evidence pending; never commit unrelated changes. Review packets: `sova-spec-review.mjs`, see `$core/../README.md`. No check, record, evidence or promotion proves correctness; no tool checks meaning.

Machine inspection, beside the reading commands: `node "$core/sova-spec.mjs"` also takes `check`, `census`, and whole-chain `packet`/`scope '<§id>'` (machine inspection); `--spec <dir>` reads a draft.

## Workers

A worker gets only the passages and unknowns relevant to its part, quoted literally.

If you are a worker: a parent session started you, and it promotes on its own branch before calling it ready. Your brief is your go-ahead. Work in the draft your brief names, or say which one you started. Promote, commit or record `--commit` evidence only when your brief says to, and then only on its branch, never by landing on the default branch; otherwise say what is ready to promote. List each foreign § you updated in your final report.
