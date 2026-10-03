# compact-handoff

`/compact-handoff [focus]` compacts a session after the agent writes down what the summary would
lose, and puts that note back right after the summary.

1. The command refuses while a turn, a compaction or queued messages are in flight. Otherwise it
   starts a turn with a hidden instruction (`compact-handoff-request`): persist anything durable
   with the normal tools, then end the reply with the note inside `<handoff>…</handoff>`.
2. When that run settles, the newest `<handoff>` block in the replies after the instruction is the
   note. A stopped or failed turn, or no block, compacts nothing. The note is written to
   `<agent dir>/compact-handoffs/<session id>.md` (0700/0600, atomic, newest wins) and to the
   session's `compact-handoff` custom entry `{v: 1, path, note, at, leafId}`, then the session
   compacts with the focus as the summary's instructions. A prompt that started first wins: the
   note is saved, nothing is compacted.
3. After every compaction (this one, `/compact`, threshold, overflow), the newest
   `compact-handoff` entry on the branch comes back as a hidden `compact-handoff-note` message
   with its age and path. If the reply that wrote it is still in the kept tail, only that
   preamble and the path are sent. It never starts a turn.

The extension writes the file itself on the machine running pi, never through the agent's tools,
so a sandboxed session (agent dir read-only to tools) and a remote one (tools on the far host)
save the same way. Builtins and the pi extension API only.

Tests: `node tests/run.mjs` (no pi session, no model).
