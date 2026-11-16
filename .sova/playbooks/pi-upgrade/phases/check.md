# Check it went smoothly

Thorough, not overextended: this list and no more. The merge queue runs the full landing checks after the user's Land; this check is for what those can't see.

1. `pnpm run typecheck`, `pnpm run build`, `pnpm test`, `pnpm test:int --changed`. A package change triggers the chat-process and tour groups: expect a long run, and run it as a background job.
2. The canaries: `pnpm test -- server/harness/pi/contract.test.ts`, and every QUIRKS row the research flagged, read against the new code even where its canary passes.
3. pi-config's own suites and its provider typecheck on the branch's pi (`references/commands.md`). The queue's `extensions` check can't stand in for this: it runs only changed extensions, on the global pi.
4. The branch's own test copy of Sova (`project_verbs up`; copy `auth.json` in by hand), on a throwaway `zai/glm-5.3` chat: a new chat; a chat recorded on the old pi, copied in; a steer mid-reply; a compaction; an extension-started run; a worker. Leave them in the copy.
5. Only if "Measure speed before and after" is on, or speed was a win or a risk: `scripts/perf-pi/README.md`, before and after.
6. Each risk in the report: show it is fixed, or say why it doesn't apply.

Compare every failure with master under the same conditions before calling it the upgrade's. Report the table (`roles/verifier.md`), then stop: say what still blocks landing (Sova's note names it), or that the user can press Land or type "land it" in this chat. Only their Land lands it, through the merge queue.
