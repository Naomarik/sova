# §chat/session-fork — Fork a conversation

## §chat.session-fork/from-reply — Fork from an assistant reply

A delivered assistant reply offers **Fork from here** as the fourth action after Copy, Share,
and Regenerate. It uses the existing hover, keyboard-focus and touch-reveal action strip, with
an accessible name and a branch icon. User-message actions are unchanged.

Fork from here opens a new ordinary web-owned session containing the conversation through the
selected assistant response. Later conversation and abandoned branches are excluded. The source
session is not modified, navigated, prompted or notified; neither model is called by creation.
Creating a fork of a Claude Code chat only seeds, in memory, the fork's first turn to resume the
source's live CLI session (§chat.session-fork/claude-resume).
The new chat can run the existing playbooks independently.

The fork has its own session id and a parent-session reference. It inherits the selected branch's
applicable model, thinking level, mode, sandbox and tracked worktree state. Worktrees remain
shared filesystem locations, not duplicated checkouts. It is not registered as the source's
worker, organization agent or Overseer. The source's worker/team registries and pending wake
schedules do not become executable state in the fork; historical messages describing that work
remain readable.

The action keeps a visible reason while unavailable, including an in-flight fork, a running
source turn or compaction, or an unsupported source. Creation failures stay on the selected
reply and are announced. A successful action opens the fork on the same host as the source.
A newly streaming reply has no action until a canonical persisted reply is available.

## §chat.session-fork/cache-affinity — Cache reuse without shared conversation identity

A UI-created fork records its inherited prompt-cache affinity as non-context session metadata
in the fork only. The source's key is its session id, or the inherited key it already carries.
Nested forks keep that lineage, even when forking an inherited reply before the metadata entry;
rewinding a fork does not change its cache affinity.

In Sova-hosted requests, only an automatically generated `prompt_cache_key` matching the fork's
own session id is replaced with the inherited key. An explicit different key is respected, and
no field is added to providers such as Zai that do not send it. Conversation/session identity,
messages, system instructions and tool declarations remain independent and unchanged; this hook
does not register a tool or change the system prompt. Codex additionally uses the session id for
transport affinity: fork requests use inherited request affinity over SSE without sharing the
source's WebSocket, previous-response continuation or Agent/session identity. The source's
transport is not changed. Other providers keep their transport unchanged. The metadata creates
no transcript row, main-model message or extra model call.

This preserves the opportunity to reuse an identical warm prefix on the first fork request;
provider eviction, expiry or changed instructions can still cause a cache miss. Cache reuse is
verified against a warm-parent control rather than inferred from the existence of a cache key.

## §chat.session-fork/background — Background forks keep the parent's cache

A background fork, a hidden child that works in a copy of the conversation and reports back
without opening a session (/explain's worker today), uses the same cache affinity as a
UI-created fork, from the same code. The copy it forks records the parent's inherited cache key
as the same non-context metadata, so a parent that is itself a fork passes its lineage on. The
child asks OpenAI-style providers for that key, and on Codex also sends it as its request
affinity on whichever transport the child uses; the child has its own process, so no WebSocket
or continuation state is shared with the parent. The child declares the parent's tools and
system prompt exactly as the parent's transcript declared them, and what it may do is decided
per call by the run's policy, so neither the policy nor the gate changes the request prefix.
A Claude Code parent with a live, idle CLI session is resumed and forked there instead of
replayed.

Its first request is expected to read the parent's warm prefix from cache on Zai, Codex,
Ollama Cloud and Claude Code alike, verified against the parent's last request; provider
eviction or expiry can still cause a miss.

## §chat.session-fork/claude-resume — A Claude Code fork resumes its source's CLI session

A UI-created fork of a Claude Code chat whose CLI session is live and idle in the same Sova
picks up from that CLI session for its first turn (resumed and forked, so the source's record
is never extended), instead of replaying the conversation to a fresh CLI as one message, so
its first request reads the source's warm prompt cache. It does so only while the source's CLI
session is still exactly at the forked reply: forking an earlier reply, a source that has moved
on, been stopped or restarted since, or a fork opened in another folder replays the history as
before. The fork's own conversation and session id stay independent of the source.
