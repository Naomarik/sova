---
title: The Overseer
description: A session that reads every other session and acts on them through Sova, asking first when it matters.
group: Features
order: 12
---

The **Overseer** is a session that reads every other session and acts on them for you. Ask it what needs you, what finished, or where you left off. Ask it to start sessions, send prompts, or tidy up. When a request is ambiguous or risky, it asks first.

It has no shell and edits no files. It acts only through Sova, with limits you set.

## Open it

The **Overseer** button, with the eye icon, sits at the right end of the session list's toolbar. When the list is collapsed, the eye alone is there. `Alt+O` opens it from anywhere. The badge on the button counts the Overseer's own messages you haven't read yet.

The Overseer is always in the normal mode, with no minor modes, so its composer has no mode switch. In its place is **Quick Actions**, a list of ready-made prompts: What Needs Me, What Finished, What's Running, Tidy Up, and Where Was I. You can edit, add, remove, and reorder them in Settings → Overseer.

## What it reads

- **What needs you.** The same news as the sidebar's [Needs you](/docs/needs-you/) list, plus the items worth a decision (a branch ready to merge, a reply that seems to ask you something) and what's just for your information (what's running, a session close to its context limit).
- **Sessions.** The list, one session's details and what's true of it now, its alignments, and a bounded slice of its transcript. Text it reads from another session is treated as untrusted.
- **Your setup.** Groups, remote targets, models, subagent profiles, and recent folders.

## What it can do

- **Start sessions** in any folder, on a remote target, or on another Sova host, with a first prompt, a model, and modes.
- **Send a message** to a session, as if you typed it there. If a turn is running, the message is queued behind it; it steers the running turn only when you've asked it to interrupt.
- **Archive and unarchive** sessions (never a permanent delete), rename them, and move them between groups.
- **Change a session's** model, mode, or subagent profile.
- **Answer a dialog** that's waiting in a session Sova runs. The session's transcript shows "Overseer chose: …". It never answers in a session that's open in a terminal.
- **Keep notes for itself.** Standing notes are instructions it reads every turn; it can add to them, and you can edit them in Settings → Overseer.
- **Keep your ideas and todos.** Say "it'd be nice if…" and it files an idea; say "remind me to…" and it adds a todo. It says what it filed in one line and starts nothing. The **Ideas** and **Todos** buttons in its head open each list.

It can't send to a session that's open in a terminal, archived, or a worker, and it never sends to itself.

## It asks with cards

When it isn't sure, or the act is risky, the Overseer writes what it found and asks with a **card**. A card lists each session it would touch, each with a short note on what it is and why the action fits it. Options are lettered and items are numbered, so you can click, or answer in chat with something like "c_4 b".

Lowering a session's sandbox always needs your click on a card. A typed "yes" isn't enough.

## When you're not there

Runs you didn't start, such as a brief or a scheduled wake-up, are read-only. They can report and ask, but not act, unless you approved ahead of time on a card:

- **An approval for later** lets it do anything to the sessions the card lists until a deadline, at most 7 days away. Its button says so: "Approves any act on these 3 sessions until 6:00 PM".
- **A standing rule** lasts until you revoke it, such as "Send continue to a session after its usage limit resets". Its button reads "Adopts a standing rule: …".

Both come only from your click. The Overseer can't write one itself.

## Limits

Before each act the Overseer checks its limits, and when one is reached it stops and asks you instead. The defaults, per message you send it:

| Limit | Default |
|---|---|
| Sessions created | 5 |
| Prompts to other sessions | 10 |
| Sessions archived | 50 |
| Ideas explored | 2 |
| Links made | 3 |
| Organization changes | 20 |
| Gathering sessions started | 3 |

At most 10 sessions it started or messaged may be working at once. While any are, its composer shows "3 of 10 running"; press it to open the limits in Settings → Overseer.

Every act is written to `~/.pi/agent/sova/overseer-actions.jsonl`, with secrets redacted.

## Start over

Type `/clear` in the Overseer's composer, or press **Clear** in its head, to start a new conversation. The last 20 stay under **History**, read-only. Its settings, standing notes, standing rules, and the action log carry over.

## Settings → Overseer

- **Proactivity**: Off, List Only (the default), or Brief Me. See [Needs you](/docs/needs-you/#proactivity).
- **Model and Thinking** for the Overseer. Its model never becomes the default for your new sessions.
- **Limits**, **Quick actions**, and **Standing notes**.
- **Extra instructions**, added after the Overseer's own prompt from its next run.
