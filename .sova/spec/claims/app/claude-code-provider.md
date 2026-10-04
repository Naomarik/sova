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
provider's built-in Claude Code models, which the extension registers without asking the CLI, and
Settings → Accounts' status line says the CLI could not be run (§app.claude-logins/cli-status).

Sova's own `<agent dir>/sova/settings.json` no longer holds a provider switch: a stored
`experimental.claudeCodeProvider` is ignored, never written and never required. Its `experimental`
object is a set of named boolean switches Sova knows (`adversarialReview`, §chat.alignment-review/flag),
each off unless stored `true`.
`PUT /api/settings` takes `{experimental: {...}}`: a known key must be a boolean (else 400), an
unknown key is ignored, and a body without an `experimental` object is a 400. The write re-reads the
file and replaces only the known keys the request carries, so any other key, old or another
writer's, stays.
