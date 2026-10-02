# §chat/work-chain-setting — Work rendering preference

## §chat.work-chain-setting/preference — Compress thinking & tool calls

Settings → General offers **Compress thinking & tool calls**, a browser-local switch, on by default. It persists in `localStorage["sova:compress-work"]`: only exactly `"false"` disables compression; absent, unreadable, and corrupt values mean on. Blocked or full storage never breaks boot or an in-memory choice.

Every open transcript reads the same reactive preference, including settled history, streaming entries, workspace panes, hidden-row disclosures, and subagent transcripts; flipping it needs no reload. On selects the existing compact work timeline. Off selects the original Thinking and ToolCard render path, its original gap, classes, and estimates, with no timeline rail, group line, timeline attributes, or extra live wrapper. Folding a compressed run cannot hide any cards while compression is off. No server, protocol, or pi settings file is changed.
