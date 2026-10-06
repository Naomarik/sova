# §app/model-levels — Thinking levels for models pi has no catalog for
> Part of the Sova design spec · [overview](../design/overview.md)

pi knows each built-in provider's models, their thinking levels and what to send for each level
from its own catalog (bundled data, refreshed from pi.dev). A provider defined only in
`models.json` (today `ollama-cloud` and the local `ollama`) has no such catalog: without help pi
offers its generic ladder (off, minimal, low, medium, high) for a model marked `reasoning`, only
"off" for one that isn't, and sends nothing for any level when the provider sets
`compat.supportsReasoningEffort: false`. The Thinking group (§chat.composer/composer-flyout) and the
request then disagree with what the model really has.

The fix is a pi-config extension (`pi-config/extensions/model-levels/`), so it holds in the TUI, in
every session Sova hosts and in every pi worker, whether Sova is running or not. Its core imports
nothing but node builtins, and Sova's pi adapter imports the same core, so Sova's model list is right
from boot (§app.model-levels/sova-boot).

## §app.model-levels/scope — Which providers it covers

- It covers every provider that `models.json` defines with its own `models` list and that has no
  built-in base in pi: every model pi lists for the provider is one of those entries. A built-in
  provider (even one `models.json` adds models to or overrides) is never touched; its levels stay
  pi's catalog's.
- Within a covered provider, `models.json` decides which models exist. A model the metadata source
  reports as retired is left out of the list (§app.model-levels/retired); nothing else is added or
  removed.
- Only three things of a model change: `reasoning`, `thinkingLevelMap` and
  `compat.supportsReasoningEffort`. Everything else, provider-level compat included (for example
  `supportsDeveloperRole: false`, so the system prompt still goes as a `system` message), stays what
  pi composed from `models.json`.

## §app.model-levels/sources — Where a model's levels come from

- A provider whose `baseUrl` is Ollama's (host `ollama.com`, or port 11434) is asked through
  Ollama's own metadata: `GET /api/tags` to see that it answers, then `POST /api/show` for each model
  `models.json` lists. A model's `thinking.values` and `capabilities` decide its levels.
- A model Ollama gives no thinking values for without ruling thinking out (for example one whose
  `/api/show` names the thinking capability but lists no values) or doesn't answer for, and every
  model of a provider that isn't Ollama's, is looked up on models.dev: the models.dev provider whose
  `api` equals the provider's `baseUrl`, matched by model id, and its `reasoning` and
  `reasoning_options`.
- Only free metadata endpoints are called; never a model.

## §app.model-levels/mapping — From metadata to pi's levels

- **off** maps to `"none"` when the model can turn thinking off (Ollama lists `false`, or models.dev
  lists a `toggle`), and is absent otherwise.
- Every effort value named like a pi level (minimal, low, medium, high, xhigh, max) maps to itself;
  every other pi level is absent from the ladder.
- A model whose only "on" value is boolean `true` (or a models.dev toggle with no efforts) gets one
  "on" rung, **high**, sent as `"high"`. A model that is always on (Ollama lists only `true`) gets
  high alone, so it offers one level and the Thinking group is hidden.
- A mapped model is a reasoning model and gets `compat.supportsReasoningEffort: true`, so the
  chosen level is sent as `reasoning_effort` (off as `"none"`) even when the provider sets it false
  for everything else.
- A model Ollama says can't think is not a reasoning model. Budget-only or empty option lists, and a
  model no source knows, stay as `models.json` has them.
- So, with today's metadata: deepseek-v4.1-flash and kimi-k3 offer off, low, high, max; glm-5.3
  low, high, max; gpt-oss low, medium, high; nemotron off, high; minimax-m2.7 high alone.

## §app.model-levels/precedence — What the user writes wins

- A `reasoning`, `thinkingLevelMap` or `compat.supportsReasoningEffort` written on a model's own
  entry in `models.json` is kept as written; only the fields it leaves out are filled in.
- `modelOverrides` still apply last, over the filled-in model, as pi applies them to any model.
- A model added to `models.json` appears at the next session start (or the next turn). The
  metadata file has nothing for it yet, so its provider is fetched again in the background at once,
  and the model is filled in when that lands.

## §app.model-levels/cache — Fetching, caching and offline

- What the sources answered is kept in `<agent dir>/model-levels.json`, per provider with the time
  it was fetched, and written atomically. Levels apply from it at once, at every session start and
  before every turn, with no network wait.
- A provider's metadata is fetched again in the background when it is more than 24 hours old (never
  blocking a session's start), at most once at a time per process and per device, and the result
  applies as soon as it lands.
- A fetch that fails keeps the last metadata, and the same process tries that provider again no
  sooner than an hour later; a model no source answered for this time keeps what it had. Nothing is
  fetched with `PI_OFFLINE` set or `SOVA_MODELS_FETCH=off` (or `0`, `false`), nor, with that switch
  unset, in a test process; `SOVA_MODELS_FETCH=on` (or `1`, `true`) allows it there. A TUI, with
  neither set, fetches. With no
  metadata at all (first run offline), every model behaves exactly as it did without the extension.

## §app.model-levels/retired — Retired models drop out

- A model Ollama answers with "retired" is left out of the provider's model list, so it is no longer
  offered anywhere that lists models. Its `models.json` entry is not edited; were it un-retired, it
  would come back at the next fetch.

## §app.model-levels/sova-boot — Sova's model list from boot

- Sova's shared model runtime applies the same levels from the metadata file as soon as it is
  created, before any chat opens, and starts the same background fetch; `GET /api/models` reports
  each model's `thinkingLevels` from it.
- At boot Sova also refreshes pi's own built-in catalogs from the network once, in the background,
  as pi's TUI does at its start, so built-in providers' levels follow pi.dev rather than only what a
  TUI last stored.
- Both boot fetches follow the same rule as the extension's own (§app.model-levels/cache), and so
  does the extension in every session Sova hosts, the Claude Code provider's warm-up session
  included: with `SOVA_MODELS_FETCH=off` neither the boot fetches nor any hosted session's extension
  fetch anything, and the levels already cached still apply.
- pi workers load the extension too (it is in every pi worker's extension list), so a worker sends
  the level it is given in the same way.
