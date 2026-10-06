# Golden exception log

The only way an expected file under `expected/` may change. One line per intended output change, added in
the same change as the re-record (`node scripts/harness-golden.mjs record --accept <probe>` refuses until a
line added since HEAD names the probe):

`- <date> <probe> <fixture(s)>: <why the output changes> — <reviewer>`

A changed fixture (a re-run of `make-synthetic.ts` or `faux-record.mjs`) changes its expected files too, and
gets a line naming every probe it re-records.

## Log

- 2026-10-05 (all) (all): first record, on feat/harness-integration 51f575e plus test-only exports — G0a/G0b
- 2026-10-05 (all) large-10mb: outputs over 256 KiB stored as digests, fork prefixes hashed per target, fork/regenerate/rewind sample their targets past 200 entries; new generated `large` set recorded. Synthetic, faux and cc expected files unchanged (all under the limit) — G0 follow-up
- 2026-10-05 (none) faux/*/events.json: each event serialized as it is emitted, with only true cycles marked (the recorder's one `seen` set across the run had turned every shared object, e.g. a user message_end's message and a reply's usage, into "[cycle]"); session.jsonl and every expected file unchanged (no probe reads events.json) — W3.0
- 2026-10-05 baton-view (all): the view gains `drawings: {html}` from the row's abilities (§app.baton/outsider-view, feat/baton-screenshot); the probe's rows carry no abilities, so every view adds `"drawings":{"html":false}` and nothing else changes — merge of master into feat/baton-screenshot
- 2026-10-05 rows rows-each transcript-rows watch synthetic/all-types: the claude-login switch row carries `loginNote: true` (the server marks the Claude login note, §app.claude-logins/switch-login; the web no longer reads the entry shape); no other row changes — feat/new-session-keep
