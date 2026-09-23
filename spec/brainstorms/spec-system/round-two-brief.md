# Round two: decide the remaining design

Research and proposal documents only. No implementation, retrofit, or edits to existing specs/source/reference repositories. Write `round-two.md` in your existing model-owned folder; preserve round-one proposals. Read the judge's `astra-judge/synthesis.md`, this brief, and actual reference files. Work independently initially. Prior caps/doctrine are evidence, not requirements.

## Settled by the user

- Use foldaidev's identifier convention. Do not reopen sigil vs no-sigil or invent dotted IDs instead.
- Pilot by retrofitting Sova's existing `spec/` and comparing effectiveness. Plan the pilot; do not perform it yet.
- Portable to ANY project: no required existing spec, language/framework/source tree, source annotations, or Sova installation.
- All new system artifacts live in `.sova/spec/`. A Sova/Pi minor mode activates the discipline, but is only a consumer of the standalone core.
- Reconciled claims become authoritative incrementally. Missing/stale necessary context is investigated and backfilled on demand, not through mandatory full retrofit. Code/requirements discrepancies must be raised rather than silently canonizing bugs.
- `scope(identifier)` returns actual concise prose assembled through the behavior graph, not only paths. State the known closure and unknown frontier honestly.
- Proposals are not current implementation claims. Matching hashes are not semantic proof.
- Lightweight tooling AND lightweight prose/maintenance are priorities.

## Identifier reference to verify, not blindly copy

Read `~/webapps/foldaidev/docs/identifiers/README.md` (The § grammar / One declaration rule), `spec-graph.mjs` (`idToFile`), `notation.json`, and `spec/foldaidev/revising.md` (Rename a surface).

Reconnaissance found: `§<namespace>/<name>`, lowercase/hyphens, namespace can have one qualification dot. `§control-plane/workers` resolves to `control-plane/workers.md`; `§control-plane.workers/fleet` declares a child heading there; `§section.worktree/chat` resolves to `section/worktree/chat.md`. Headings declare; ordinary mentions cite. Retired identifiers are cut, registered with successor/reason, and not reused. File/heading references also use `path.md` → **Heading**. Scope/kind inventory is data, not hardcoded project names. Separate this convention from foldaidev's source-header checks: source annotations remain forbidden as a requirement. Existing Sova §N comments may be optional discovery evidence only.

## Decisions the team must make

1. **Format and prose discipline:** give an exact minimal unit/section example, relationship representation, authority location, heading boundaries, resolution, and deterministic prose scope output. Evaluate credible alternative formats and choose one. Specify terse writing rules with before/after examples; include conditions/exceptions without verbose scaffolding. Handle a project with no previous spec and Sova's incumbent numbered specs. Avoid duplicating claims or introducing multiple equivalent authoring grammars.
2. **Dirty-tree review records:** compare committed-only vs exact working-byte snapshots (and a simpler good alternative if one exists). Sova often has many uncommitted files. Define exact input set, old/new mappings/edges, dependency invalidation, deletions/renames/new files, races, retained evidence, review provenance, unrelated dirty files, non-Git projects, and receipt self-reference. Choose the smallest honest practical model. Distinguish movement, applicability, correctness, and claimed review.
3. **Advisory versus blocking:** give a small matrix for commands/mode stages. Distinguish malformed graph, missing references, unmapped regions, stale relevant claims, semantic conflict, and failed observations. Unknown global coverage must not make incremental adoption unusable. Explain exact exit/status semantics without a vague green badge. Do not silently import aidv2's no-config policy.
4. **Pilot execution plan, not execution:** retrofit existing Sova spec as the target; compare with the original preserved baseline. Recommend staged or full rollout with concrete evaluation: scope size AND omissions, correct blast radius, planted drift/edge-deletion/new-file cases, reconciliation effort, authoring footprint, comparison of alignment with/without scope, and a no-spec portability fixture. Do not interpret rich text as an authorized product feature; use it as a hypothetical evaluation task. Preserve group composer's deliberately different behavior.

## Integration boundary

Explain the minimal discipline the minor mode loads, how it discovers/install-checks the portable tools, how it composes with alignment, and when it asks permission to bootstrap or reconcile files. No global extension or server edits in this round. Read Pi docs if making API claims. Do not pretend a prompt guarantees compliance.

## Quality bar

Favor a coherent worked example over many knobs. Forward dependency and reverse impact examples must actually match. A failed parse must not shrink scope silently. Missing behaviors inside a mapped file remain a stated blind spot. A shared CSS class is a candidate, not behavior inheritance. Dependency evidence movement can require reviewing consumers without proving them broken. No receipt should certify HEAD bytes while the reviewed input was dirty. Scope budgets must show unread required material.

Keep output decision-oriented (~1500–2500 words if practical): recommendation, alternatives/tradeoffs, concrete artifacts, gate matrix, pilot plan, unresolved choices, verified references and limitations. Cite precise populations if reporting counts; previous proposals' source/spec counts disagree. Do not repeat unverified counts. The separate Astra judge will consolidate after all five complete.
