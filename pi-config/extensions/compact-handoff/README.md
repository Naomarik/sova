# compact-handoff

`/compact-handoff [focus]` compacts a session after a background fork of it writes down what the
summary would lose, and puts that note back right after the summary. `/compact-handoff cancel`
stops a run.

1. The command refuses while a turn, a compaction, queued messages or an earlier run are in
   flight, or when the session has no conversation on disk yet. Otherwise it starts a background
   fork through the shared fork core (`../subagents/fork/`, the same one /explain uses): the fork
   works in a copy of the session, on its warm prompt cache, under a read-only policy (read,
   search, a read-only shell line; no writes, no web), and is told to end its reply with the note
   inside `<handoff>…</handoff>`. The note holds only what the summary would flatten (the user's
   exact corrections, fine distinctions, why an option was rejected, unverified claims, traps,
   where an older summary is wrong), never the state the summary keeps; with nothing to add it is
   `Nothing beyond the summary.` A Claude Code session resumes its live, idle CLI session, else
   folds (and says so). If the fork can't start, the command says so and does nothing else.
2. Nothing of the fork's turn enters the session. The run's row is a hidden `compact-handoff-run`
   custom entry `{v: 1, id, status, at, focus?, path?, error?}`, appended at the start
   (`running`) and again under the same id at the end (`saved`, `failed`, `cancelled`); a run its
   session stopped is settled as `interrupted` at the next prompt. The TUI draws each entry as a
   line; Sova renders the newest per id as one row.
3. When the fork settles, the last `<handoff>` block of its final reply is the note. A failed or
   stopped fork, or no block, saves and compacts nothing. The note is written to
   `<agent dir>/compact-handoffs/<session id>.md` (0700/0600, atomic, newest wins) and to the
   session's `compact-handoff` custom entry `{v: 1, path, note, at, leafId}`, then the session
   compacts with the focus as the summary's instructions — at once when idle, else at its next
   idle settle (a prompt that slips in first postpones it again).
4. After every compaction (this one, `/compact`, threshold, overflow), the newest
   `compact-handoff` entry on the branch comes back in full as a hidden `compact-handoff-note`
   message with its age and path. (A note from before the fork whose reply is still in the kept
   tail gets only the preamble and path.) It never starts a turn. A `Nothing beyond the summary.` note is saved and
   compacts like any other, but its compaction instructions don't mention a note and nothing comes
   back, then or later; as the newest entry it also keeps an older note from coming back.

The fork's files (the session copy and its own session) live in
`<agent dir>/compact-handoffs/.runs/<run id>/`, removed when the run ends; a failed run's stays
for a day, then the next run sweeps it.

The extension writes the note itself on the machine running pi, never through the agent's tools,
so a sandboxed session (agent dir read-only to tools) and a remote one (tools on the far host)
save the same way.

Tests: `node tests/run.mjs` (no pi session, no model, no child).
