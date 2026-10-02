# §chat/session-fork — Fork a conversation

## §chat.session-fork/from-reply — Fork from an assistant reply

A delivered assistant reply offers **Fork from here** as the fourth action after Copy, Share,
and Regenerate. It uses the existing hover, keyboard-focus and touch-reveal action strip, with
an accessible name and a branch icon. User-message actions are unchanged.

Fork from here opens a new ordinary web-owned session containing the conversation through the
selected assistant response. Later conversation and abandoned branches are excluded. The source
session is not modified, navigated, prompted or notified; neither model is called by creation.
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
