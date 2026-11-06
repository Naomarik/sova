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
from boot (§app.model-levels/sova-boot). For `ollama-cloud` the same core also keeps the model list
itself current: Sova's server checks Ollama Cloud's list once a day (§app.model-levels/server-check),
new models join on their own (§app.model-levels/new-models) and Settings → Models says how the last
check went (§app.model-levels/settings-line).

## §app.model-levels/scope — Which providers it covers

- It covers every provider that `models.json` defines with its own `models` list and that has no
  built-in base in pi: every model pi lists for the provider is one of those entries. A built-in
  provider (even one `models.json` adds models to or overrides) is never touched; its levels stay
  pi's catalog's.
- Within a covered provider, every model `models.json` lists exists, except one the metadata source
  reports as retired, which is left out of the list (§app.model-levels/retired). For `ollama-cloud`
  only, a model Ollama Cloud's own list names that `models.json` lacks is added as well
  (§app.model-levels/new-models). Nothing else is added or removed; the local `ollama` provider's
  list stays exactly what `models.json` says.
- Of a model `models.json` lists, only three things change: `reasoning`, `thinkingLevelMap` and
  `compat.supportsReasoningEffort`. Everything else, provider-level compat included (for example
  `supportsDeveloperRole: false`, so the system prompt still goes as a `system` message), stays what
  pi composed from `models.json`. A model the check added takes the provider's settings from
  `models.json` the same way, and its own fields from the check.

## §app.model-levels/sources — Where a model's levels come from

- A provider whose `baseUrl` is Ollama's (host `ollama.com`, or port 11434) is asked through
  Ollama's own metadata: `GET /api/tags` to see that it answers, then `POST /api/show` for each model
  `models.json` lists (for `ollama-cloud`, every model its list names, §app.model-levels/server-check).
  A model's `thinking.values` and `capabilities` decide its levels.
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
  and the model is filled in when that lands. For `ollama-cloud` no chat fetches: the model is
  filled in at the server's next check, or at once on Check Now (§app.model-levels/server-check).
- A model the check added never overrides `models.json`: an entry there with the same id is the
  model, and every field it writes is kept as written; the check fills only what it leaves out.
  `models.json` itself is never rewritten.

## §app.model-levels/cache — Fetching, caching and offline

- What the sources answered is kept in `<agent dir>/model-levels.json`, per provider with the time
  it was fetched, and written atomically. Levels apply from it at once, at every session start and
  before every turn, with no network wait.
- A provider's metadata is fetched again in the background when it is more than 24 hours old (never
  blocking a session's start), at most once at a time per process and per device, and the result
  applies as soon as it lands. `ollama-cloud` is the exception: no chat process (a chat Sova hosts,
  a pi worker or a TUI) fetches it any more; only Sova's server does, on its own timer
  (§app.model-levels/server-check), and every process applies what the file holds.
- A fetch that fails keeps the last metadata, and the same process tries that provider again no
  sooner than an hour later; a model no source answered for this time keeps what it had. Nothing is
  fetched with `PI_OFFLINE` set or `SOVA_MODELS_FETCH=off` (or `0`, `false`), nor, with that switch
  unset, in a test process; `SOVA_MODELS_FETCH=on` (or `1`, `true`) allows it there. A TUI, with
  neither set, fetches. With no
  metadata at all (first run offline), every model behaves exactly as it did without the extension.

## §app.model-levels/retired — Retired models drop out

- A model Ollama answers with "retired" is left out of the provider's model list, so it is no longer
  offered anywhere that lists models (the model picker, Settings → Models, subagent model choices),
  whether `models.json` lists it or the check added it. Its `models.json` entry is not edited; were it
  un-retired, it would come back at the next fetch.
- A chat sitting on a model that has since retired reopens on the default model for new sessions
  (§chat.model-menu/saved-default) and says so in the chat, naming the retired model.

## §app.model-levels/sova-boot — Sova's model list from boot

- Sova's shared model runtime applies the same levels from the metadata file as soon as it is
  created, before any chat opens, and starts the same background fetch (for `ollama-cloud`, the
  server's daily check, §app.model-levels/server-check); `GET /api/models` reports each model's
  `thinkingLevels` from it.
- Whenever the metadata file changes, whichever process wrote it, the server applies it again, so
  Sova's model list (`GET /api/models`, the picker, Settings → Models) follows a finished check with
  no restart. Thinking levels and retired-model hiding hold the same for a model `models.json` lists
  and one the check added.
- At boot Sova also refreshes pi's own built-in catalogs from the network once, in the background,
  as pi's TUI does at its start, so built-in providers' levels follow pi.dev rather than only what a
  TUI last stored.
- Both boot fetches follow the same rule as the extension's own (§app.model-levels/cache), and so
  does the extension in every session Sova hosts, the Claude Code provider's warm-up session
  included: with `SOVA_MODELS_FETCH=off` neither the boot fetches nor any hosted session's extension
  fetch anything, and the levels already cached still apply.
- pi workers load the extension too (it is in every pi worker's extension list), so a worker sends
  the level it is given in the same way.

## §app.model-levels/server-check — Sova's server checks Ollama Cloud's list

- While it runs, Sova's server checks Ollama Cloud's model list once a day on a timer, and at once
  on Check Now (§app.model-levels/settings-line). It calls only Ollama's free listing endpoints:
  `GET /api/tags` for the list, then `POST /api/show` for each model it names; never a model.
- For each model the metadata file doesn't know yet, it learns its context size (Ollama's show
  answer, else models.dev's `limit.context`), its output limit (models.dev's `limit.output` when
  models.dev has the model, else 32,768 tokens), whether it takes images (Ollama's `vision`
  capability) and whether it thinks, with its levels (§app.model-levels/mapping). A model whose
  context size neither source gives is not added yet; the next check tries it again.
- What it learned, the time of the check and what changed (models new to the list, models it now
  reports retired) are written to the metadata file (§app.model-levels/cache).
- If Ollama can't be reached or answers with an error, the last known list stays as it is, the
  failure and its reason are recorded, and the server tries again an hour later on its own.
- Only `ollama-cloud` is checked this way. The local `ollama` provider is unchanged: its models stay
  `models.json`'s, with levels as §app.model-levels/cache says. Nothing is checked with `PI_OFFLINE`
  set or `SOVA_MODELS_FETCH=off`, as there.

## §app.model-levels/new-models — New Ollama Cloud models join on their own

- A model Ollama Cloud's list names that `models.json` lacks (and that isn't retired) joins the
  model picker, Settings → Models and subagent model choices, named `<model> (Ollama Cloud)` (for
  example `glm-5.4 (Ollama Cloud)`), with the context size, output limit, image support and thinking
  levels the check learned.
- It arrives switched on: the model policy has no entry for it, so it is enabled and allowed for
  subagents, unless the Ollama Cloud provider itself is off (§app.settings-dialog/models).
- Settings → Models marks it **New** for a week from the check that first listed it.
- Hand-written settings always win (§app.model-levels/precedence): once `models.json` lists the same
  id, that entry is the model.

## §app.model-levels/settings-line — The check's line in Settings → Models

- Under the Ollama Cloud provider group, Settings → Models shows one line about the server's last
  check (§app.model-levels/server-check): when it ran and what changed ("Checked 2 hours ago · 3 new,
  1 retired"; "… · no changes"), or, when the last check failed, when and why ("Last check failed
  5 minutes ago: {reason}. Retrying at 4:30 PM."). Before any check: "Not checked yet".
- The same round checks Ollama Cloud's API key, the one reading Settings → Accounts' Ollama Cloud
  tab shows too; when it wasn't accepted the line adds it: "… · the API key was refused" or "… ·
  the API key couldn't be checked" (on a failed check, as a sentence of its own).
- A **Check Now** button beside it runs the check at once; while it runs the button is disabled and
  the line says "Checking…". It is disabled too while fetching is switched off
  (§app.model-levels/cache), and a request that fails says "Couldn't check: {reason}". It runs at
  once, never staged for Save Changes (§app.settings-dialog/save-bar). When the
  check finishes, the line, the model rows and the picker update in place.
- No notice is sent anywhere else about new or retired models: this line and the New marks
  (§app.model-levels/new-models) are the only places that say so.
