# vision-delegate

Lets a text-only model work with images by delegating the looking to a small
vision model and putting its words back into the conversation.

Pi's transport drops image blocks for models whose `input` does not include
`"image"`, so a session on `glm-5.3` or a Codex model simply never sees a
screenshot — pi only leaves a note saying the image was omitted. This extension
fills that gap in three places:

| Path | Trigger |
| --- | --- |
| `look_at_image` tool | The model explicitly asks about an image file on disk |
| `tool_result` hook | A `read` result carries image blocks the active model cannot see |
| `input` hook | Images attached in the TUI, on a session whose model cannot see them |

The original image blocks are **never removed**, only described alongside:
switching to a vision model with `/model` later must still show the attachment.
The transport strips them for the text-only model on its own.

Installed globally through a symlink:

```text
~/.pi/agent/extensions/vision-delegate -> ~/pi-config/extensions/vision-delegate
~/.pi/agent/vision-delegate.json       -> ~/pi-config/vision-delegate.json
```

Run `/reload` after installation.

## Settings

`~/.pi/agent/vision-delegate.json`:

```json
{
  "fallbacks": ["zai/glm-5.3-flash", "anthropic/claude-haiku-4-5"],
  "exhaustedAbovePct": 90,
  "contextChars": 2000
}
```

- **`fallbacks`** — ordered `provider/modelId` candidates. An entry that does not
  resolve in this session's registry, or that does not accept image input, is
  skipped and reported rather than tried.
- **`exhaustedAbovePct`** — a subscription window at or above this percentage
  makes the provider count as exhausted, and the next fallback is used.
- **`contextChars`** — how much of the recent conversation travels with an
  explicit `look_at_image` question (the automatic descriptions send none).

Every field is optional; a missing file or a malformed value falls back to the
default for that field alone.

## Choosing the model

`picker.ts` walks the fallbacks in order and takes the first entry that resolves,
accepts images, and is not exhausted. Usage comes from the shared cache
`usage-status` writes (`~/.pi/agent/cache/usage-status.json`), re-read at every
pick because it is refreshed out-of-band every ~3 minutes.

| Provider | Usage bucket |
| --- | --- |
| `anthropic` | `claude` (5h, 7d, 7d-scoped — the worst window counts, not only the binding one) |
| `openai-codex` | `openai` (all windows, plus an explicit `limitReached`) |
| `zai` | `zai` (5h) |
| `ollama-cloud` | `ollama` (monthly) |
| anything else (`fireworks`, `opencode`, local `ollama`, ...) | no subscription limit we can see |

A missing or corrupt cache means *unknown*, never *exhausted*. When every
vision-capable candidate is exhausted the first one is used anyway and the result
says so — a degraded answer beats no answer.

## Behaviour

- Answers are prefixed with `[via provider/id]`; automatic descriptions with
  `[image described by provider/id]`.
- Both hooks cap at three images per event and disclose the number skipped.
- Both hooks fail soft: any picker or model error warns through `ctx.ui.notify`
  and passes the content through completely unchanged.
- `look_at_image` still works when the active model *does* have vision (explicit
  delegation can be deliberate), but the result notes the detour was unnecessary.

## Files

- `settings.ts` — settings file loading and per-field defaults
- `picker.ts` — pure fallback/exhaustion policy over the usage cache
- `describe.ts` — pure prompt building, conversation excerpting and formatting
- `index.ts` — pi wiring: the tool and the two hooks

## Tests

```sh
cd extensions/vision-delegate && node tests/run.mjs
```

No model requests: the registry and `complete` are faked. The runner resolves the
globally installed pi package through the same jiti loader the subagents tests use.
