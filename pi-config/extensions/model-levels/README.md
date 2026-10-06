# model-levels

Correct thinking levels for the models pi has no catalog for.

pi knows a built-in provider's models, their thinking levels and what to send for each level from
its own catalog. A provider defined only in `models.json` (here `ollama-cloud` and the local
`ollama`) has none: pi offers its generic ladder (off, minimal, low, medium, high) for any model
marked `reasoning`, only "off" for the rest, and with the provider's
`compat.supportsReasoningEffort: false` it sends nothing for any level.

This extension fills in, for every model of such a provider:

- `reasoning`, `thinkingLevelMap` and `compat.supportsReasoningEffort`, from Ollama's own
  `/api/show` (`thinking.values`, `capabilities`) for a provider on `ollama.com` or port 11434, and
  from models.dev (`reasoning_options`, the provider whose `api` is the `baseUrl`) for what that
  leaves open;
- off → `"none"` when the model can turn thinking off, every effort named like a pi level to
  itself, a boolean-only model one rung (`high`), and `supportsReasoningEffort: true`;
- models Ollama reports as retired are left out of the list.

Everything else of a model (provider compat such as `supportsDeveloperRole: false`, windows,
costs) is what pi composed from `models.json`. A `reasoning`, `thinkingLevelMap` or
`compat.supportsReasoningEffort` written on a model's own entry wins, and `modelOverrides` still
apply last. Built-in providers are never touched.

## Cache and network

The answers are kept in `~/.pi/agent/model-levels.json`. They apply at once at every session start
and before every turn. A provider's copy older than 24 hours (or missing a model `models.json`
lists) is fetched again in the background: `GET /api/tags`, one `POST /api/show` per model, and
models.dev's `api.json` only when needed. These are free metadata calls; no model is ever called.
One fetch at a time per process and per device (`model-levels.lock`); a failed fetch keeps the
last answers and is retried after an hour; `PI_OFFLINE` fetches nothing. With no cache at all,
nothing changes.

`core.ts` imports only node builtins: Sova's pi adapter imports it too, so Sova's model list is
right from boot. Every pi worker the subagents extension starts loads this extension.

## Verify

```sh
cd extensions/model-levels && node tests/run.mjs   # unit tests + the seam on the global pi
PI_PACKAGE_DIR=<another pi install> node tests/seam.mjs --table   # what each level sends
```
