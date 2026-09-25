# stamp

A dim, right-aligned stamp under each user and assistant message in the TUI transcript:

```
 Use the bash tool to run: echo hi. Then reply done.
                                                              2:02 PM · 3m ago
```

`1:43 PM` today, `Mar 4 1:43 PM` on another day, then the age (`just now`, `5m ago`, `2h ago`,
`yesterday`, `3d ago`). Past 7 days the age would only repeat the date, so the stamp stands alone.
No command and no settings.

## The shared formatter

`format.ts` (`clockTime`, `stampTime`, `relativeTime`, `agoTime`, `stampAgo`) imports nothing: no
pi runtime and no node builtins. Sova's `src/lib/format.ts` re-exports it, so every clock in the
web UI and the TUI's stamps read the same. Keep it import-free: Vite bundles it for the browser.

## How it renders

pi draws its own user and assistant messages, and no extension hook sees their time: the
markdown transformer gets text only, and pi keeps one (codefold's). So each stamp is a `custom`
entry, `customType: "stamp"`, `data: {role, timestamp}` (ms), drawn by an entry renderer:

- A user message's stamp is appended when the next message starts (or at `agent_end`), because
  pi persists a message only after extensions have seen its `message_end`.
- An assistant message's stamp is appended at `turn_end`, after its tool results, so it never
  sits between a tool call and its result.
- `timestamp` is the persisted message entry's own time, the time Sova shows. For a reply that
  is when it finished, not when it started. The message's own time is the fallback.
- Entries are written in TUI mode only. Print, JSON, RPC and Sova's embedded runtimes write
  none. Custom entries never reach the model, and Sova renders unknown custom types as nothing.
- `@narumitw/pi-stamp`'s old `pi-stamp` message entries render the same way, so sessions written
  while it was installed keep their stamps. Its tool-timing entries render nothing.

The age is computed at render time. In fullscreen (`tuiMode: "fullscreen"`) the extension also asks
pi to repaint once a minute, so an idle screen stays current. In regular mode it doesn't: there, a
changed line above the viewport makes pi clear and redraw the whole scrollback, so the age
catches up on the next repaint instead.

## Tests

```sh
node --test format.test.ts index.test.ts
```

Both run under Node's type stripping with no pi install: `index.ts` imports pi's types only.
