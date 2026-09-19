# Native teams in Pi — implementation plan

Status: Fable high-effort review accepted; batch 1 ready. 2026-09-19.

## Review decisions (authoritative over draft below)

Review: `docs/native-teams-plan-review.md` (Claude Fable 5.1, high). Accepted with these resolutions:

1. One active workspace slot shared by `/agents` and `/team`; refuse a second open with a clear notice. Generalize lifecycle/permission hiding before UI wiring.
2. Action states are `requested`, `accepted-or-queued`, `failed`, `unknown`. Never claim delivery/execution distinctions unsupported by `SteerResult`.
3. Compose deterministic team/objective/member role/declared ownership header into each prompt BEFORE backend validation. Explain declared ownership is advisory. Dynamic addition does not silently rewrite existing worker context.
4. Team-wide stop deferred; milestone 1 stops exact selected members only, with inline double-x confirmation. Existing agent_kill remains available.
5. Follow review's strict team_create/team_add/team_list schemas (one role per member; no count/fork/extensions/agentType), teams span independent run groups. Defaults explicit and backend-native.
6. Metadata display restores from active branch only, counters reserve across all entries. Restored members are unavailable/history, never live-adopted by ID. Live records removed from manager by retention remain explicitly pruned/unavailable.
7. `/team <objective>` queues an extension-origin planning message via sendMessage followUp/triggerTurn; bare `/team` never triggers a model call.
8. Reuse width-safe component widget and existing throttled refresh. No context percentages. Wake-per-member and Claude bypassPermissions defaults documented.
9. Parallel ownership only on disjoint new UI/widget/docs modules after batch 1. Do not touch runners/contracts/Claude source for this milestone. Regression test additions to Claude dialog tests are allowed in final verification if needed.
10. Baseline changed during review due to another session's fixes (167 subagents / 127 Claude tests pass per reviewer). Coordinate with peers and take fresh baseline before edits. Opus discovery resolved `opus[1m]` to `claude-opus-5[1m]`.

## Goal

A native `/team` workspace for a Pi-led team of Claude Code (or mixed Pi/Claude) workers: explicit roles/ownership, roster, selected-worker activity, direct follow-up/redirect input, bounded coordination history, and a compact widget outside the workspace. Reuse the existing subagents manager and Claude runner; no tmux automation or duplicate process manager.

## Boundaries for the first milestone

- Session-scoped only: reload, session replacement, and quit still stop owned workers. Clearly disclose this in UI/docs. No live reattachment claims.
- Parent and user coordinate workers. No native Claude peer-tool/MCP bridge in this milestone; label direct input as user instruction, not peer communication. Peer transport is a later separately tested milestone.
- No autonomous operator/orchestrator, polling LLM loops, auto-compaction, git operations, or permission changes.
- Existing `/agents`, tools, caps, rollback, permission prompts, shutdown, and backend behavior must remain compatible.
- Preserve all existing uncommitted work. No commits or reload while implementation workers are running.
- UI cannot claim tests passed, ownership enforced, actual context window percentages, peer delivery, or process survival unless backed by observed state. Ownership is declared scope, not a filesystem lock.

## Proposed architecture

Extend the shared subagents extension with isolated team state and TUI modules. Keep one authoritative manager for all worker creation/control. A team is an explicit record with stable ID/name, objective, creation time, and member references (worker ID, role, assignment, owned paths). Dynamic additions join that team without treating unrelated runs as members. Use exact worker IDs for actions. Store compact metadata/counters in Pi custom entries for historical identity only, not process restoration. Team views handle unavailable/pruned workers explicitly.

Prefer extracting reusable spawn/steer operations inside index.ts to copying their implementation. UI and team tools share these operations and preserve validation-before-spawn/transaction rollback. Team membership commits only after successful worker creation. Persist metadata without creating dangling membership on failed batches. Bounded human-origin action records track requested/accepted/queued/unknown/failed separately from completion; worker outcome remains authoritative.

Commands/tools (review before finalizing):
- `/team` opens native workspace (team selector, roster, selected transcript).
- `/team <objective>` starts a parent planning turn with explicit team-tool instructions, never silently starts model work on merely opening the workspace.
- Model-facing `team_create`, `team_add`, `team_list` (or one small action tool) provide objective, role, assignment, ownership and backend-native spawn settings through shared manager path.
- Workspace actions: select member, follow-up editor, redirect editor, explicit confirmation for stop; use established modal/editor permission-dialog hiding behavior.
- Compact widget above normal editor: name, working/idle/error counts and short activity, bounded member rows. Clear on shutdown; no blocking/polling model activity.
- Overview: assignments/declared ownership and actual worker status. Activity view uses bounded runner transcripts. Action history is NOT a peer message bus.

## Batches and verification gates

### 0. Review and baseline
1. Fable at high effort reviews plan against source/docs, reports blockers and scope improvements without editing source.
2. Update plan with review decisions before implementation.
3. Run existing subagents and Claude offline suites and smoke tests. Record pre-existing failures.
4. Read Pi extension/TUI docs completely and relevant examples before implementing UI. Workers use exact discovered Opus alias at high effort; confirm resolved model where possible.

### 1. Team state and shared manager operations
- Implement bounded state model, stable identity, member metadata and session/history semantics.
- Reuse existing manager spawn/control path for team create/add; expose validated tool interface.
- Tests: invalid/duplicate membership; exact IDs; atomic failure/rollback; live cap; dynamic addition; mixed backends; pruning/unavailable workers; persistence cannot adopt unrelated workers; normal tools unchanged.
- Gate: focused new tests plus full existing offline suites.

### 2. Native workspace and direct controls
- Native team/roster/selected transcript view with responsive width/height and keyboard navigation.
- Clear empty/no-selection/unavailable/error/idle-success vs idle-failure states.
- Direct follow-up and redirect editors, honest acceptance feedback, stop confirmation. No pretend peer-send mode.
- Preserve permission-dialog visibility; one shared action path and no conflicting overlays.
- Tests: navigation, transcript follow/scroll, small terminals, terminal text sanitization, correct recipient IDs/modes, cancelled editors, delivery unknown, permission overlay hide/restore, cleanup.
- Gate: component/integration tests plus offline regression suites.

### 3. Widget, workflow, documentation and smoke
- Compact team status widget, explicit `/team` argument behavior, scoped add workflow, bounded action/history display.
- Document session lifetime, ownership advisory nature, no peer transport, shared-filesystem risks, model defaults and permissions.
- Tests: throttled refresh, cleared widget/shutdown, command behavior and UI actions with fake runners.
- Run loading/shutdown smoke tests. Add opt-in minimal live team smoke with tiny tasks if practical; keep spend bounded and stop only its owned workers.
- Gate: independent Opus review, fix findings, rerun affected and complete suites. Record exact commands/results and any unverified interactive behavior.

## Later milestones (not implied complete by milestone 1)

1. Authenticated team-scoped worker messaging with provenance, delivery receipts, loop/backpressure limits and role authority. Probe Claude native peer tools separately; prefer explicit MCP/host routing if needed.
2. Supervisor process for durable teams, reconnect, crash recovery and explicit owner transfer.
3. Optional dependency scheduling, context management based on actual model metadata, dedicated operator conversations, and external views.

## Execution log

- Initial inspection: repository already has modified subagents files and untracked Claude extension; preserve as baseline.
- CLI installed: Claude Code 2.1.277.
- Baseline verification: subagents offline 159/159 pass; Claude offline 119/119 pass; both extension loading/shutdown smoke scripts pass. Logs: `/tmp/pi-teams-baseline-*.log`.
- Pre-implementation source snapshot for preserving/comparing dirty baseline: `/tmp/pi-teams-preimplementation/`.
- Parent read full Pi extension and TUI documentation and overlay QA example.
- **Batch 0 complete:** Fable review (`native-teams-plan-review.md`) accepted with decisions recorded above.
- **Batch 1 complete:** State/shared spawn and control seams, strict team tools, persistence; Pi worker completed after Claude session limit. Verified 202 subagents + 127 Claude + smoke; details `native-teams-batch1.md`. Full real-TUI all phases remains gated on batches 2/3.
- **Next:** complete. `/reload` activates `/team`.
- **Batches 2/3a/3b complete:** native workspace (`team-modal.ts`), widget (`team-widget.ts`), `/team <objective>` planning message, smoke harnesses. Details: `native-teams-batch2.md`, `native-teams.md`, `native-teams-batch3b.md`, `native-teams-verification.md`.
- **Final independent review:** `native-teams-final-review.md` — verdict Ready; its 3 findings (README discoverability, one inaccurate doc claim, one missing composed-length-limit test) were all fixed afterwards: READMEs now document teams, doc claim corrected, real Claude `MAX_CLAUDE_INPUT_CHARS` rejection test added.
- **Final verified state:** subagents 267/267, claude-code 127/127, all smoke/UI scripts pass, `team-ui-smoke --phase all` A0–A7 + B1–B11 + Z1 pass, `team-smoke --live` passed with one bounded haiku member, `git diff --check` clean.

- Model discovery: Fable `claude-fable-5-1[1m]`; Opus `opus[1m]` (CLI-advertised alias; resolved generation to be checked).
