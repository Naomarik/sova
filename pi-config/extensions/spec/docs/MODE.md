# The `spec` minor mode, end to end

The spec minor mode is a discipline for coding agents. Behavior is written into `.sova/spec/` and agreed
before code, and every change goes through a draft. The mode has two halves:
- **Text.** It puts one text into the agent's system prompt.
- **Mechanical checks.** It runs the census after tool calls, so the text holds without the model remembering it. Nothing runs at the end of a turn: a turn ends when the model stops.

Workers get a reduced copy of both. This page names each piece, where it lives, and how they connect.
The behavior itself is specified under §tools/spec (`.sova/spec/claims/tools/spec.md`). This page
describes the code, not the requirement.

Paths are relative to `pi-config/extensions/` unless they start with `.sova/` or `server/`.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| The guide | `mode/spec-mode.md` | The text injected while the mode is on. It is the only copy: everything else quotes or loads it. |
| Loading | `mode/minor.ts` | Reads `spec-mode.md` once at load (`SPEC_INSTRUCTIONS`, trailing whitespace trimmed) and extracts its one `sh` block as `SPEC_CORE_SHELL`, the line that finds the trusted tools. |
| Prompt composition | `mode/prompt.ts` | `composePrompt` appends minor blocks after the major mode's in registry order; with a spec writer set, the spec block gains the writer paragraph (`buildSpecWriterPrompt`). `composeWorkerPrompt` gives a worker the spec block plus `SPEC_WORKER_NOTE`. |
| Session hooks | `mode/index.ts` | `before_agent_start` injects the block. `tool_call`/`tool_result` run the census. Worker modes are published on an event. |
| The census note | `mode/spec-guard.ts` (`CensusHook`, `CENSUS_SKIP_TOOLS`) | After a tool call that can write, it compares the work tree's `git status` with the last look. On the first changed file in the spec boundary, and on each new file, it runs `sova-spec.mjs census --changed` and appends a short `[spec census]` digest to that tool result. At the first call after the session's last edit it runs `census --changed --related` once and adds one line, `Unread § your change landed in`, naming the foreign § the session's own files landed in that it hasn't `read` (`specReads` over its shell commands), at most 5 marked read first, the rest named. |
| Forbidden writes | `mode/spec-guard.ts` (`SpecWriteGuard`) | It says so, in the same digest, when the current spec is written by hand, or when commits that a draft's evidence names are rewritten. |
| pi worker checks | `mode/spec-worker.ts` | The same census for a pi worker. Workers start with `--no-extensions`, so the spawn path loads this file with `-e`. |
| Worker brief | `subagents/spec-brief.ts` | A fixed excerpt of `spec-mode.md` for a code-writing worker whose prompt doesn't already carry the spec block. Each rule is found by an anchor and quoted whole, so the brief is generated, never hand-copied. |
| Claude Code worker checks | `claude-code/spec-hooks.ts` | The worker half of the guard for Claude Code workers. `UserPromptSubmit` marks the turn's baseline and `PostToolUse` runs the census step. Each hook is a fresh process, so state lives in one file per Claude session. |
| Merge note | `worktrees/spec.ts` | When a worktree merge is recorded, it adds the landing's warnings to the merge note: changed files no claim maps, draft records left behind, hand-resolved §, orphaned evidence. This applies in any project with a spec, mode on or off. |
| Spec writer setting | `mode/spec.ts`, `server/spec-settings.ts` | Which worker (backend · model · effort) writes draft claims and evidence while spec is on. The legacy file is `<agent dir>/mode-spec.json`; Sova's Settings → Subagents now edits it per profile. `null` means the session writes the spec itself. |
| The tools | `spec/core/*.mjs` | Read-only `sova-spec.mjs`, `sova-spec-draft.mjs` (drafts, evidence, promotion, `merge-manifest`), the review and assessment companions, and the modules they load. |
| Manifest merge driver | `.gitattributes`, `sova-spec-draft.mjs merge-manifest` | `.sova/spec/manifest.json` merges record by record in Git, through a driver each clone defines once (below). |

## How they connect

1. **Load.** `minor.ts` reads `spec-mode.md` beside it when the mode extension loads, and Sova's server
   imports the same module. If the file doesn't hold exactly one single-line `sh` block, or that line
   appears again outside it, the load throws. So a malformed guide stops both pi and the server from
   starting; it never ships half-read.
2. **Inject.** With spec on, `index.ts`'s `before_agent_start` appends the composed block to the
   system prompt (`prompt.ts`). The block is `spec-mode.md` byte for byte, plus the writer paragraph
   when a spec writer is set. `mode/index.test.ts` pins the text:
   - every flag it spells is parsed by the command it is paired with;
   - its `--doc-only` cases are the draft tool's own;
   - its word count is capped.
3. **Find the tools.** The guide's `sh` line resolves `$core` to `<agent dir>/extensions/spec/core`, where
   `pi-config/install.sh` links these tools. The agent runs only that trusted copy. A project's own
   vendored copy under `.sova/spec/tools/` is foreign code, read before it is run.
4. **Census while working.** After each tool call (bash included), `CensusHook` compares `git status`.
   - Tools that cannot write are skipped by name (`CENSUS_SKIP_TOOLS`). A skipped call doesn't move the
     baseline.
   - The digest's "No draft yet" line prints once per session per work tree; a census that can't run is said
     once per cause per work tree.
   - At the first call after the last edit (a call that can write but changed nothing of the session's
     own), `unreadStep` ranks the touched foreign § by the changed lines (`census --changed --related`)
     and says the unread line once per set of landed §; § the session ran `sova-spec.mjs read` on drop
     out. This replaces the census the guide used to ask for by hand before finishing.
   - `PI_SPEC_CENSUS_HOOK=0` turns the census off.
5. **Workers.** The subagents extension listens for the session's mode event. While spec is on, a
   code-writing worker gets these:
   - its mode prompt: the spec block plus `SPEC_WORKER_NOTE`, or, when that prompt doesn't carry the
     block, the generated brief;
   - its census: `spec-worker.ts` for a pi worker, or `spec-hooks.ts` through `--settings` for a Claude
     Code worker.
6. **Merge.** A recorded worktree merge names the changed files no claim maps and any draft records
   left behind.
   - Git merges `manifest.json` through the driver.
   - If the driver refuses (both sides changed one record differently), the procedure in `../PROMOTE.md`
     applies: take master's manifest and claims, re-apply in a new draft, promote.

## The merge driver, once per clone

```sh
git config merge.sova-spec-manifest.driver \
  'node pi-config/extensions/spec/core/sova-spec-draft.mjs merge-manifest --root . --base %O --ours %A --theirs %B --write'
```

`.gitattributes` routes `.sova/spec/manifest.json` to `merge=sova-spec-manifest`. Worktrees share the clone's
config. Without the driver, Git falls back to its line merge.

## Where the requirements live

| Piece | Claim |
|---|---|
| What the guide teaches about reading | §tools.spec/mode-reading |
| The census note | §tools.spec/census-note |
| The unread line after the last edit | §tools.spec/unread-landed |
| The census's ranking by changed lines | §tools.spec/census-rank |
| A turn ends when the model stops | §tools.spec/no-turn-end-check |
| Workers get the minor modes | §chat.mode-menu/workers |
| The merge note | §chat.worktrees/merge-card |
| The spec review playbook | §tools.spec/review-playbook |
| The tools themselves | the H2s under §tools/spec |
