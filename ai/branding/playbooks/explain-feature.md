# Playbook: explain one feature

> Part of [Sova branding](../overview.md). For a note, a release entry, a section in a longer
> doc, or an answer to "what does X do?" The reader wasn't there when it was built.

## Shape

Five beats, in this order. Most explanations fit in five sentences to five short paragraphs.

1. **What it does**, in one sentence, from the reader's side. Not how it was built.
2. **Where it is.** The screen, the button, the file. Quote the button in Title Case.
3. **What it touches on disk and what it doesn't.** This product shares `~/.pi/agent` with a
   process the reader trusts. Say what is read, what is written, and what is left alone.
4. **The edge.** The case where it stops, refuses, or does nothing, and what the reader sees then.
5. **Verification.** Revision and where you looked, in a note after the prose.

## Rules

- **Confirm before explaining.** [truth-sources.md](../truth-sources.md). If you can only
  find the spec, write "the spec describes" and stop there.
- **One noun per concept, introduced once.** If the spec calls it a group and the UI calls it a
  group, don't call it a folder or a collection for variety.
- **Quote copy exactly.** The strings in `.sova/spec/claims/design/copy-deck.md` and on screen are the copy.
  Paraphrasing a button label makes the reader hunt.
- **Say what it isn't when it's close to something it isn't.** A workspace is not a project.
  A worker is not a session. Watching is not chatting.
- **No before-and-after story.** The reader wants the tool, not its history. If the history
  explains a limit, one clause: "read-only, because the TUI owns the file".
- **Numbers as digits, machine facts in code spans, no exclamation marks.** As [voice.md](../voice.md).

## Example

> **Archive.** A session Sova started can be moved out of the top of the list with `Archive
> Session` in the session head. The transcript file isn't moved or changed; the session's id is
> added to `~/.pi/agent/sova/archived-sessions.json`, and the row moves under Archive in the
> sidebar, grouped by date. `Unarchive Session` reverses it. A session open in a TUI can't be
> archived while it's live; the button is disabled with "Open in a TUI. It stays on top while
> live."
>
> *Verified 2026-09-22 at `d3a6963`: `POST /api/sessions/archive` in `server/index.ts`,
> `server/archived-sessions.ts`, the button and its disabled reason in
> `src/components/SessionDetails.tsx`.*

That example was first drafted from the copy deck alone and named the wrong file; reading the
route's handler corrected it. Before publishing it, the writer would also open the app and press
the button. Do the same.
