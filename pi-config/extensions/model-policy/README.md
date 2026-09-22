# model-policy

One file decides which models may be used on this machine, and which of them subagents may be
given. This extension owns that file's shape and enforces the global half in the session it is
loaded into.

## The file

`~/.pi/agent/model-policy.json`, written by pi-web's **Settings → Models** tab:

```json
{
  "version": 1,
  "disabledProviders": ["anthropic"],
  "disabledModels": ["openai/gpt-5.2"],
  "subagentDisabledProviders": ["zai"],
  "subagentDisabledModels": ["ollama/qwen3-coder"]
}
```

The bare keys are **global**: those providers and models may not be used anywhere, by anyone. The
`subagent*` keys **narrow** what is still globally allowed down to what a worker may be given, so a
model can be yours to drive by hand and out of bounds for workers. Global therefore covers
subagents too, and the subagent entry is kept rather than folded in — turning a model back on
restores the preference it had.

Providers are bare names; for a non-pi worker backend the backend id **is** the provider name,
which is what makes `claude-code` one name covering every Claude worker, its default model
included. Models are `provider/modelId` refs; a backend model also matches its bare id. Comparison
is case-insensitive. Anything missing, corrupt, of another version or of a foreign shape reads as
"nothing disabled": a policy file nobody can understand must not take model selection down with it.

While the file does not exist, the pre-Models-tab file `~/.pi/agent/subagents/settings.json` is read
instead, and its two lists are treated as the subagent dimension — which is what they always meant.
Nothing becomes globally disabled by that migration.

## What enforces it

| Where | What happens | Who |
| --- | --- | --- |
| This extension, any pi session | Six boundaries, below | `index.ts` |
| Command palette | Disabled models are not listed | `../command-palette/index.ts` |
| Subagents and teams | Discovery hides them, and `agent_spawn`/team creation refuses them — explicit, agentType-defined, or inherited from the parent | `../subagents/policy.ts` |
| topic-outline | A disabled summarizer backend is refused **at the call**, and the next one in the chain takes the outline | `../topic-outline/summarizers/policy-gate.ts` |
| vision-delegate | A disabled vision fallback is skipped, with its reason | `../vision-delegate/picker.ts` |
| pi-web | The model picker lists only enabled models; the chat socket refuses `set_model`, and a chat already on a disabled model refuses to send | `server/model-policy.ts` |

The six boundaries this extension holds, and why those (checked against pi 0.86.1's own control
flow, and against a real `pi --mode rpc` session pointed at a fake provider):

1. **`model_select`** — picking a disabled model puts the previous model back and says why. If the
   previous model is disabled too, or there wasn't one, the session stays where it is and refuses
   to run. A `restore` is never rewritten: a resumed session keeps its model and is refused at its
   next turn instead.
2. **`input`** — every message the user sends, refused before the turn starts. **All** text, not
   only prose: pi's interactive mode handles its own commands (`/model`, `/thinking`, `/new`,
   `/compact`, …) inside `onSubmit` and returns before any `prompt()`, and `prompt()` dispatches
   extension commands before the input hook. What reaches this event is exactly what reaches the
   model — prose, `/skill:name`, `/template`, unknown `/words` — each expanded *after* the hook. So
   `/model` still works while a session is blocked, and a skill or a prompt template cannot smuggle
   a turn through.
3. **`context`** — the backstop, and the last cancellable point before the provider request. Turns
   start without user input all the time: `pi.sendMessage(…, {triggerTurn: true})` (what a subagent
   wake-up uses), a `turn_end` or `agent_before_settle` continuation, a retry. Throwing is not an
   option — the extension runner catches handler errors at *every* hook — so the stop is
   `ctx.abort()`, which closes the run's effect gate synchronously. `context` runs immediately
   before the request is admitted, and admission checks that gate, so the request is never made.
4. **`session_before_compact`** — compaction is a provider call of its own, and on the prompt path
   it runs before every other hook. It is cancelled with the supported `{cancel: true}`.
5. **`session_before_tree`** — `/tree` summarizes the branch it leaves with another request to the
   same model. Moving between branches is not itself a model call, so it is not cancelled: pi takes
   an extension's summary in place of its own, and navigation keeps working with nothing sent.
6. **`cache_warming_decision`** — warming re-sends a prefix captured while the model was still
   allowed; turning the model off stops it.

Nothing anywhere picks another model for you. A refusal names the model and the switch that has to
move; the session stays where it is.

## Limits

- Pi's own `/model` list and `ctrl+p` cycling belong to pi: a disabled model is still **listed**
  there, and this extension answers by putting the previous model back the moment one is chosen.
- A pi session that does not load this extension (a bare `pi -e` run, another machine's config) is
  not covered for the global rule. The subagent rules still are: they live in the extension that
  spawns workers.
- A stopped turn ends as an **abort** — pi's own cancellation path — so the transcript shows an
  aborted turn beside our reason rather than a tailored error.
- topic-outline's chain counts a policy denial as a backend failure, so a summarizer turned back on
  rejoins at the end of its backoff (a minute or more) rather than instantly. A delay in
  preference, never a wrong call.

## Tests

```sh
cd extensions/model-policy && node --test policy.test.ts index.test.ts
```

No model requests, no files outside a temp directory.
