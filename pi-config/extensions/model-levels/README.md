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
- models Ollama reports as retired are left out of the list;
- for `ollama-cloud` only, models Ollama Cloud's list names that `models.json` lacks are added
  (below).

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
last answers and is retried after an hour; `PI_OFFLINE` or `SOVA_MODELS_FETCH=off` fetches nothing
(the server's check included). With no cache at all, nothing changes. `ollama-cloud` is the
exception: only Sova's server fetches it (below).

## Ollama Cloud: the server's check

`ollama-cloud` is the one provider no chat process fetches (`SERVER_CHECKED` in `core.ts`): not a
session Sova hosts, not a pi worker, not a TUI. Sova's server checks it instead
(`server/harness/pi/model-sync.ts`): once a day while it runs, an hour after a failed check, and at
once on **Check Now** in Settings → Models. A check lists Ollama Cloud's models (`GET /api/tags`),
then asks `POST /api/show` for every model it names, every model `models.json` lists and every model
an earlier check added; models.dev fills the levels Ollama leaves open.

A listed model that `models.json` lacks is recorded under the provider's `discovered`, with its
first-seen time, context size (Ollama's `model_info.*.context_length`, else models.dev's
`limit.context`), output limit (models.dev's `limit.output`, else 32,768) and image support (the
`vision` capability). One that doesn't complete text is never added; one whose context size no source
gives waits for a later check. The check's outcome (when, what's new, what's newly retired, or why it
failed and when it retries) is kept under `checks`. A failed check keeps the last list.

Every process registers the discovered models beside `models.json`'s, named `<id> (Ollama Cloud)`,
with the provider's settings; a `models.json` entry with the same id is always the model, and
`models.json` is never rewritten. Retired models stay out of the list, whichever way they arrived.
The server re-applies the file whenever it changes, whoever wrote it, so its model list follows a
check without a restart. The local `ollama` provider is unchanged: it keeps the per-process fetch and
exactly `models.json`'s list.

`core.ts` imports only node builtins: Sova's pi adapter imports it too, so Sova's model list is
right from boot. Every pi worker the subagents extension starts loads this extension.

## Verify

```sh
cd extensions/model-levels && node tests/run.mjs   # unit tests + the seam on the global pi
PI_PACKAGE_DIR=<another pi install> node tests/seam.mjs --table   # what each level sends
```
