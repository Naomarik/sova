# §app/claude-code-provider — The Claude Code provider
> Part of the Sova design spec · [overview](../design/overview.md)

A session whose own model runs on the claude-code provider (`pi-config/extensions/claude-code/provider`)
talks to a persistent Claude CLI child through the bridge. The stream adapter turns the CLI's frames
into pi's assistant messages, and the bridge decides where each pi message ends. Usually one pi
message is one CLI assistant message. A message that calls tools ends at the CLI message's end,
while the CLI turn stays open for pi's results. This surface holds what the provider promises about
that exchange. How the bridge launches a child, and what happens across a server restart, is
§app.worker-restore/claude-bridge-restart.

## §app.claude-code-provider/invalid-tool-input — A tool call whose arguments are not valid JSON

Claude sometimes streams a tool call whose arguments, once complete, are not valid JSON or are not
a JSON object. The provider never runs such a call. It is left out of pi's message and is never
matched to a `tools/call`. Nothing repairs, trims or guesses its arguments, and it never reaches pi
with `{}`. The CLI rejects the same bytes itself and asks the model again within the same CLI turn.
The pi message stays open across that retry, on the same CLI child: there is no restart, and the
child is not counted as out of step with pi. The retry continues the same pi message, which holds,
in order, the text and thinking of the rejected attempt and then everything the retry says.

- When a CLI message has both valid and invalid calls, the pi message ends as a tool call with
  only the valid ones. pi answers those, and the CLI answers the invalid one itself.
- A CLI message whose calls were all rejected does not end the pi message. The next CLI message
  decides how it ends. That can be the retry, or a reply in text instead, which ends the message as
  a stop (or at the length limit) and keeps that text.
- If the CLI dispatches a `tools/call` that matches no valid call by its exact arguments, while a
  rejected call of the same tool is outstanding, that call is failed at once ("arguments were not
  valid JSON; nothing ran") and never runs.
- An abort while the CLI is between the rejected attempt and its retry interrupts the CLI, as any
  abort does.
- **Bound.** After 3 CLI messages in a row within one pi message whose tool calls were all rejected,
  the provider interrupts the CLI turn. It ends the pi message as an error: `Claude sent invalid
  JSON arguments for tool "<name>" 3 times in a row`. The next prompt restarts the child with
  folded history.
- **Diagnostic only.** A rejected call is recorded only as a diagnostic on the pi message
  (`claude-code.invalid-tool-input`: the tool's name, the call's id, the arguments' length in bytes,
  and where parsing failed). It is never shown and never sent to a model. Its raw arguments are not
  kept. The CLI's own transcript keeps their first 2048 bytes.
- **Usage.** The pi message's usage is the last CLI message's, as for every message, so context
  fill and compaction stay right: the retry's input already includes the rejected attempt. When a
  later CLI message's usage replaces that of an attempt whose calls were all rejected, the
  attempt's token counts go on its diagnostic (`usage`), never into the message's usage. A
  project's cost therefore does not price that API call.

## §app.claude-code-provider/always-on — The provider is always on

Claude Code's models are first-class in Sova with no setting. Every hosted session that loads
extensions starts with the claude-code extension's `claude-code-provider` flag set (a special
loadout that loads no extension gets no flag at all), the server registers the provider once at
startup so `GET /api/models` offers `claude-code-cli/*` before any session opens, and
`GET /api/models` never filters them out. With no `claude` CLI on `PATH` (or one that can't run)
startup and every session carry on and nothing is logged for it; the picker still lists the
provider's Claude Code models, Sova's catalog (§app.claude-code-provider/catalog), which the
extension registers without asking the CLI, and
Settings → Accounts' status line says the CLI could not be run (§app.claude-logins/cli-status).

Sova's own `<agent dir>/sova/settings.json` no longer holds a provider switch: a stored
`experimental.claudeCodeProvider` is ignored, never written and never required. Its `experimental`
object is a set of named boolean switches Sova knows (none right now: adversarial review moved to
`alignment.review`, §chat.alignment-review/flag), each off unless stored `true`.
`PUT /api/settings` takes `{experimental?: {...}, alignment?: {review?}}`: each part present must be
an object and a known key a boolean (else 400), an unknown key is ignored, and a body that is not an
object is a 400. The write re-reads the file and replaces only the known keys the request carries,
so any other key, old or another writer's, stays.

## §app.claude-code-provider/catalog — Sova's own Claude model catalog

Sova keeps its own list of the Claude models it offers, one entry per real model, in the
claude-code extension's `catalog.ts` (imports nothing, so the extension, the server and the web app
all read the same file). An entry is the model's id as the CLI's own model table names it, which is
also what `--model` is given (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`,
`claude-haiku-4-5`), the ids the API answers with for it (`claude-haiku-4-5-20251001` for Haiku
4.5), its family and version, its name as the CLI names it (`Opus 5.5`, `Sonnet 5.5`, `Fable 5.1`,
`Haiku 4.5`), its context window (1,000,000 where the CLI's table says the model is natively 1M,
else 200,000), its output cap, the efforts it takes, whether it is the current model of its family
or a previous one, and its price key. There are no aliases (`opus`, `sonnet`, `haiku`, `fable`) and
no `[1m]` forms: a natively 1M model is 1M by its id alone.

- **Every list is the catalog.** The chat model picker's `claude-code-cli/*` models, `agent_models`,
  and every Settings row that picks a Claude Code model (Subagents, Decisions, Overseer, Summaries,
  Session titles) offer the catalog's current and previous entries, with their efforts, and nothing
  else. They are there at once, with no `claude` process and offline; the CLI's model list never
  adds, removes or renames one (§app.claude-code-provider/catalog-drift).
- **Built-in defaults follow the catalog.** Every built-in Claude choice (Delegate's routes, the team
  coordinator and the monitor's fallback, the Overseer's idea explorer, the alignment reviewer, the
  Project verbs playbook, the summary line and session titles, the Claude worker default) names its
  family's current entry, so one catalog change moves them all. A choice the user saved stays as
  saved.
- **A model the catalog doesn't know** (a shape-valid id such as `claude-opus-6` before the catalog
  lists it) is still used, never refused: a Settings row says "— not verified" and, under it, "Not
  verified: {model} is not in Sova's Claude catalog. It will still be used."; `agent_spawn` and
  `team_create` start it and their result says the same.
- Adopting a new model is a change to `catalog.ts`. `pnpm run claude:catalog` (a dev script, no
  model call) reads the installed CLI's own model table and prints how it differs from the catalog.

## §app.claude-code-provider/model-names — One name for each Claude model

Wherever Sova shows a Claude model (under any provider: `claude-code-cli`, `claude-code`,
`anthropic`), it shows the catalog's name: "Opus 5.5", "Sonnet 5.5", "Fable 5.1", "Haiku 4.5". That
holds for the chat model picker and the composer's model chip, Settings' model selects, the session
header, the session list's rows and the assistant's author line, worker rows and their transcripts
in the session pane, the Agents page, the Usage and Costs tables, the subagent profile footprint and
section summaries, workspace panes and their announcements, and /explain captions. Agent-facing tool
text (`agent_models`, `agent_spawn`, `team_create`) keeps the ids an agent passes, with the name
beside them in `agent_models`. The name is of the model that answered when Sova knows it (a reply's
recorded answer, a restored worker's transcript), else of the model asked for. An answer id the catalog lists under
another id (`claude-haiku-4-5-20251001`) and an old id in a file Sova didn't rewrite
(§app.claude-code-provider/legacy-ids) read as their catalog model. "1M" never appears: the window
is the model's own. A Claude id the catalog doesn't know, and every other provider's model, keeps
its short id as before. Where a name stands for an id (a picker row, a select option), the id is
still shown beside it in mono or in its `title`.

## §app.claude-code-provider/legacy-ids — Old Claude ids are read, never written

Files written before the catalog name Claude models by CLI alias (`opus[1m]`, `opus`, `sonnet`,
`haiku`, `claude-fable-5-1[1m]`). A frozen table in `catalog.ts` maps each to the catalog model it
meant, and it is only ever read: it is never listed, never offered, never written to a file and
never passed to `--model`. `opus` and `opus[1m]` meant Opus 5 until 2026-09-21T18:00Z and Opus 5.5
from then; `sonnet` (and `sonnet[1m]`) meant Sonnet 5 until 2026-10-01T18:00Z and Sonnet 5.5 from
then; `haiku` meant Haiku 4.5; `fable`, `fable[1m]` and `claude-fable-5-1[1m]` meant Fable 5.1, and
any `<catalog id>[1m]` means that catalog model. The answer a record carries decides when it is one
of the alias's models; the date applies only to a record with no answer.

- **Unmigrated sessions reopen on their model.** A chat whose recorded model (its last model change
  or reply) is an old Claude Code id opens on the catalog model the table maps it to, never on the
  server's default model.
- **Settings files are read through it.** A subagent profile, Delegate's or the spec writer's
  routing, the team defaults, model favorites, the new-chat default, the Overseer's explorer, the
  summary line and the decision and title models read an old id as its catalog model, for what they
  show, check and start; the next save writes the catalog id. So an older Sova on a synced peer that
  saves an alias back changes nothing anyone sees.
- **Typed as input, it is resolved.** `agent_spawn` and `team_create` given any old id for a Claude
  Code worker — an alias such as `opus`, `opus[1m]`, `sonnet` or `haiku`, or a `<catalog id>[1m]`
  form such as `claude-opus-5-5[1m]` (or a pi worker's `claude-code-cli/` ref to one) — start the
  worker on the catalog model the table maps it to (`claude-opus-5-5`), with no message and no
  warning, and that catalog id is what the worker is given and what is recorded for it.
- **History is labelled and priced by it.** A usage record or a worker whose model is an old id is
  named, grouped and priced as its catalog model.

## §app.claude-code-provider/pinned-model — Every `claude` process is given a catalog id

Every `claude` process Sova or its extensions start for a model call is given `--model` with a
catalog id (or, for a model the catalog doesn't know, the id as given): the chat provider's child,
Claude Code workers, the summary line's summarizer, decisions and session titles. An old id that
reaches a spawn is replaced by its catalog model first, and a chat child's launch is judged by that
id, so a chat whose model changed only from an old id to its catalog id restarts its child at most
once. The usage ledger records the id passed as the model asked for.

## §app.claude-code-provider/model-identity — Which model answered, and a mismatch

The model that answered is the API's own id on each reply (a message's `responseModel`, a worker
transcript's model), mapped to its catalog model by the catalog's answer ids. When it is a different
catalog model from the one asked for (a request for Opus 5.5 that Opus 4.8 answered), Sova only says
so and never stops the turn or the worker: the author line names the model that answered and its
`title` reads "Asked for {asked}; {answered} answered."; a worker row shows ⚠ beside its model with
the same `title`; and in the Usage and Costs tables the calls stay on a row of their own, named by
the model that answered, marked ⚠ with the same `title`, never merged into either model's row.

## §app.claude-code-provider/catalog-drift — The CLI's model list only notifies

The `claude` initialize model list (an initialize-only call, cached 60 s, no model request) is read
only to notice drift, never to build a list. Settings → Subagents shows one quiet note under its
intro when the list names a model the catalog doesn't know ("Claude Code offers {name}
({id}), which Sova's catalog doesn't know yet.") or resolves a family's alias to another model than
the catalog's current one ("Claude Code now runs {family} as {id}; Sova's catalog still says
{current}."). Nothing changes when the list omits a catalog model or can't be read.

## §app.claude-code-provider/system-prompt — The system prompt the CLI is given

The provider gives the Claude CLI the session's current system prompt (pi's system entries
replayed, later ones folded into the first) in its `initialize` request, with one cut:
pi's own stock preamble, the sentence that tells the model it is "an expert coding assistant
operating inside pi", is left out. Only that exact text is cut, and only as a whole opening
paragraph of the prompt's `preamble` section (or of a prompt pi recorded as one flat text),
wherever that section sits among the others; everything else goes in its order, byte for byte.
Every other prompt arrives whole: a custom preamble (a SYSTEM.md, a baton or gathering
session's own instructions), a prompt with no tagged sections, and one with a line like `<script>`
or `<tools>` anywhere in it. The fold budget that decides when a long Claude Code session is
compacted counts the same prompt the CLI is given.
