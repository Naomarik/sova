# Chat thread

## Purpose

The conversation with a worker: your turns, its turns, and the tools it ran. Tool turns are mono and visually quieter than either speaker — they're evidence, not dialogue.

Rendered: `site/components/chat.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.thread` | Message column | `--space-4` gap |
| `.message` | One turn, ≤72ch | Column of head + body |
| `.message-head` | Author and time | Muted caption |
| `.message-author` | Author name | Ink, semibold |
| `.message-body` | The turn itself | Bordered surface |
| `.message-user` | Right-aligned, tinted | Your turns |
| `.message-tool` | Mono, sunken | Evidence, not dialogue |

## Tokens used

- `--color-accent-tint` — User turn background.
- `--color-sunken` — Tool turn background.
- `--measure` — 72ch turn width.
- `--font-mono` — Tool turns.

## Variants & states

### Tool turn

```html
<div class="message message-tool">
  <div class="message-head"><span class="message-author">Tool</span><span>14:07</span></div>
  <div class="message-body">read src/api/runs.ts · 214 lines</div>
</div>
```

Every state is rendered together in the site page's state matrix. The `-hover`, `-focus`,
`-active` and `-disabled` helper classes are **documentation scaffolding only** — production
code uses the real pseudo-classes.

## DO / DON'T

- **DO** Keep tool turns quieter than speech — they are evidence the user skims, not prose they read.
- **DO** Name the worker — "opus-1" is accountable; "Assistant" is not.
- **DO** End a turn with the state it left behind — "Nothing merged — it's waiting on you".
- **DON'T** Let a turn exceed 72ch — past the measure the eye loses the line.
- **DON'T** Style tool output as speech — it implies the worker said it rather than did it.
- **DON'T** Hide tool turns by default — the record of what was actually run is the trust mechanism.
