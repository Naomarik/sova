# Promoting a draft

The procedure and every refusal code are in [DRAFTS.md](DRAFTS.md). Don't repeat them here. What the tool can't check for you:

- **Decide what was implemented yourself.** Nothing here is automatic. Promote only the IDs you verified against the running code. A go-ahead from the user is not permission to commit.
- **Order.** Commit the code first. Then run `evidence --commit <rev>` against a commit whose blobs match the tree *now*. That's usually `HEAD`, which isn't necessarily the commit that first implemented it. Then promote. Then commit the claims on their own, by explicit path (`.sova/spec/manifest.json .sova/spec/claims/...`), never `-A`.
- **Preflight.** `status <name>` shows no `conflict`, and each selected ID's evidence is `valid`. `check <name>` has no findings other than `requires-uninvestigated`. A clean preview isn't a guarantee: some refusals are computed only when no other refusal fires, and `lock-occupied`/`race`/`plan-changed` show up only on `--write`.
- **Selection.** Select with `--id`, and never use `--all` on a draft that mixes promoted and unpromoted work. Set `authority: accepted` on new or rewritten prose yourself (promote also accepts `migrated` on rewritten text, which is wrong). Put the implementation files in each record's `code`, not in `--path`.
- **Conflicts can't be hand-fixed**, because `base/` is immutable. Either revert that file in the draft's `spec/` to its `base/` bytes and promote the rest, or start a new draft from current.
- **Never edit `claims/` or `manifest.json` by hand.**
- **Commit message:** a subject naming what changed and the draft(s) it was promoted from; the records, grouped by what they now say; the commits verified against and what was actually driven or observed; then the gaps found while verifying that this change doesn't close, each one left for its own draft.
