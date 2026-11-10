# §app/claude-code-provider — The Claude Code provider
> Part of the Sova design spec · [overview](../design/overview.md)

A session whose own model runs on the claude-code provider (`pi-config/extensions/claude-code/provider`)
talks to a persistent Claude CLI child through the bridge. The stream adapter turns the CLI's frames
into pi's assistant messages, and the bridge decides where each pi message ends. Usually one pi
message is one CLI assistant message. A message that calls tools ends at the CLI message's end,
while the CLI turn stays open for pi's results. This surface holds what the provider promises about
that exchange. How the bridge launches a child, and what happens across a server restart, is
§app.worker-restore/claude-bridge-restart.

Pi owns the conversation and the tools; the Claude CLI is only the model. The chat's child is
launched with no built-in tools (`--tools ''`), so every tool the model can call is one of pi's,
served through Sova's in-process MCP server (`sdkMcpServers: ["sova"]`, `provider/mcp-host.ts`).
A chat's MCP servers (§app/mcp) reach the model the same way: their tools are pi's tools like any
other, and the CLI never starts, connects to or reads a server of its own.
Each call's history is the one pi hands the provider after its extensions' `context` hooks have
run, so whatever an extension adds to a chat (tools, rewritten context, modes) reaches Claude Code
chats too. Claude Code workers run the same way: each is a pi worker on this provider, so the tools
it calls are Sova's too (§app.subagents-pane/claude-code-workers).

## §app.claude-code-provider/continuity — When the Claude process restarts

One CLI child carries a chat across its turns, and within a turn the same child stays across
every tool call: the CLI's call is held open until pi's result arrives on the next provider call.
Before each turn the bridge checks that pi's history is a clean extension of what the child has
already seen. It starts a new child when there is no live child, the child fell out of step with
pi, its Claude login is leaving this device, an interrupted turn has not settled, the model,
effort, system prompt, tool set or cwd changed, the history diverged (a rewind, branch, compaction
or foreign append), pi answered only some of the child's tool calls or a result matches no held
call, or there is nothing new to send. A new child gets the whole history folded into one user
message, clipped to the fold budget, except in two cases where it resumes a Claude session
(`--resume <id> --fork-session`, under its own new session id) and sends only the new user
messages. The first child of a forked session resumes the parent's Claude session when the
transcript extends exactly the prefix that session heard, with the same cwd and no tool results
after it. And a chat picks up its own last Claude session (§app.worker-restore/claude-bridge-restart)
when its child was closed while idle (more idle children than the bridge keeps), ended, or went with
a server restart: after each turn whose result is a success, with no tool call left open and the
child in step with pi, the bridge saves a resume record for the pi session (the Claude session id,
how many pi messages it heard and their fingerprint, the cwd, the login, and the fingerprint of the
model, effort, system prompt, tools and cwd), in memory and in
`<agent dir>/claude-code/resume/<pi session id>.json`; it drops the record as soon as it sends the
child anything else, and whenever the child falls out of step or a turn is aborted. A new child
resumes from the record only when the model, effort, system prompt, tools and cwd are unchanged, it
runs on the same login, and pi's history is exactly the recorded messages, then one finished
assistant reply, then user messages only; never for a chat whose history opens with a memory view
(those rebuild their history on purpose). Otherwise, and when the CLI fails to resume the record, it
folds as before and the turn still completes. Each new child's first usage record says how it
started and why (§app.insights/usage-ledger `launch`). A replaced live
child's fold opens "Your session was restarted, so this is a condensed, lossy replay of the
conversation so far", and a first child for a conversation that already has history opens "This
conversation started before you joined it"; reasoning is left out and long tool output keeps only
its head and tail. A restart costs a few seconds to launch the child, and the folded history is a
new prompt, so it is sent without help from the prompt cache. A history that starts with a memory
view message (§chat.memory/turn, the declared shape of `provider/memory-view.ts`) and is otherwise
only user messages is never folded: the view's guide and stable prefix are appended to the system
prompt the child is given, past the CLI's own prompt boundary (`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`,
a separate element of the initialize `systemPrompt`), so on Anthropic's first-party API the CLI
sends them as a second system block under its own cache mark (no mark added) and a rebase re-writes
that block alone, the chat's system prompt read from the cache (elsewhere the CLI joins the two into
one block as before); its newer lines and the messages after it go as the child's first
user message, as written, with no restart preamble; a mid-turn restart folds the rest with the view
reduced to its newer lines.

## §app.claude-code-provider/oneshot-uncached — One-off summaries skip the prompt cache

A one-shot request on the bridge (pi's compaction and branch summaries: no tools, under a session
id no pi session announced) runs its child with Claude Code's prompt caching off
(`DISABLE_PROMPT_CACHING=1` in its environment), since its input is read once and never again:
it is sent as plain input instead of being written to the cache, which costs more. Its spend is
recorded as before. A chat's own children, workers and the topic outline's `claude -p` keep the
cache as they are.

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
- **A tool the CLI doesn't have.** A call under a name the CLI doesn't have is handled the same
  way. Every tool the model can reach is pi's under its `mcp__sova__` name, so a call under any
  other name (a bare `bash` or `project_verbs` the model copied from prose) is one the CLI answers
  itself ("No such tool available") and asks the model again. The provider never runs it: it is
  left out of pi's message, never matched to a `tools/call`, and recorded only as a
  `claude-code.invalid-tool-input` diagnostic whose reason says the tool is unknown. The retry
  continues the same pi message on the same CLI child, with no restart and no out-of-step mark, and
  the bound below counts it like a call with invalid arguments (its error then says the tool isn't
  one Claude has).
- **Bound.** After 3 CLI messages in a row within one pi message whose tool calls were all rejected,
  the provider interrupts the CLI turn. It ends the pi message as an error: `Claude sent invalid
  JSON arguments for tool "<name>" 3 times in a row`. The next prompt restarts the child with
  folded history.
- **Diagnostic only.** A rejected call is recorded only as a diagnostic on the pi message
  (`claude-code.invalid-tool-input`: the tool's name, the call's id, the arguments' length in bytes,
  and where parsing failed). Where parsing failed is the same on Bun as on Node for the two shapes
  seen live: for arguments cut off it is the end of the input, and for a complete object or array
  with characters after it, the first character left over. For any other fault it is given only
  when the runtime's JSON parser names it (Node does, Bun does not). It is never shown and never
  sent to a model. Its raw arguments are not
  kept. The CLI's own transcript keeps their first 2048 bytes.
- **Usage.** The pi message's usage is the last CLI message's, as for every message, so context
  fill and compaction stay right: the retry's input already includes the rejected attempt. When a
  later CLI message's usage replaces that of an attempt whose calls were all rejected, the
  attempt's token counts go on its diagnostic (`usage`), never into the message's usage. A
  project's cost therefore does not price that API call.
- **No timing.** When the retry continues the pi message, the message also carries a
  `measurement-invalid` diagnostic (reason `invalid-tool-retry`), so reply timing
  (§app.insights/reply-timing) records nothing for it: its time includes the rejected attempt.

## §app.claude-code-provider/always-on — The provider is always on

Claude Code's models are first-class in Sova with no setting. Every hosted session that loads
extensions starts with the claude-code extension's `claude-code-provider` flag set (a special
loadout that loads no extension gets no flag at all), the server registers the provider once at
startup so `GET /api/models` offers `claude-code-cli/*` before any session opens, and
`GET /api/models` never filters them out. With no `claude` CLI on `PATH` (or one that can't run)
startup and every session carry on and nothing is logged for it; the picker still lists the
provider's Claude Code models, Sova's catalog (§app.claude-code-provider/catalog): the built-in list
and whatever Sova last remembered from Claude Code's table (§app.claude-code-provider/model-table),
which the extension registers without running the CLI, and
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

Sova keeps its own list of the Claude models it offers, one entry per real model. It starts from a
built-in list in the claude-code extension's `catalog.ts` (imports nothing, so the extension, the
server and the web app all read the same file) and grows by itself from Claude Code's own model
table (§app.claude-code-provider/model-table). An entry is the model's id as that table names it,
which is also what `--model` is given (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-2`,
`claude-haiku-5-5`), the ids the API answers with for it (`claude-haiku-4-5-20251001` for Haiku
4.5), its family and version, its name (`Opus 5.5`, `Sonnet 5.5`, `Fable 5.2`, `Haiku 5.5`,
§app.claude-code-provider/model-names), its context window (1,000,000 where the table says the
model is natively 1M, else the window the table states, 200,000 when it states none), its output cap, the efforts it takes, whether it is the current
model of its family or a previous one, and its price key. There are no aliases (`opus`, `sonnet`,
`haiku`, `fable`) and no `[1m]` forms: a natively 1M model is 1M by its id alone.

- **Every list is the catalog.** The chat model picker's `claude-code-cli/*` models, `agent_models`,
  and every Settings row that picks a Claude Code model (Subagents, Decisions, Overseer, Summaries,
  Session titles) offer the catalog's offered entries, with their efforts, and nothing else. They
  are there at once, with no `claude` process and offline: the built-in list plus what Sova last
  learned. No one edits Sova for a new model.
- **Built-in defaults follow the catalog.** Every built-in Claude choice (Delegate's routes, the team
  coordinator and the monitor's fallback, the Overseer's idea explorer, the alignment reviewer, the
  Project verbs playbook, the summary line and session titles, the Claude worker default) names its
  family's current entry, so one catalog change moves them all. A family's current entry is its
  newest offered entry that is built in or has passed Sova's test
  (§app.claude-code-provider/default-test); the newest model in a picker can be a newer one that
  hasn't. With every model of a family dropped, it is the built-in list's current one. A choice the
  user saved stays as saved.
- **A model the catalog doesn't know** (a shape-valid id typed by hand, such as `claude-opus-6`
  before Claude Code's table lists it, or a table model Sova doesn't offer, such as
  `claude-mythos-5`) is still used, never refused: it reads as its name where it has one
  (§app.claude-code-provider/model-names), with a 200,000 window and no effort control; a Settings
  row says "— not verified" and, under it, "Not verified: {model} is not in Sova's Claude catalog.
  It will still be used."; `agent_spawn` and `team_create` start it and their result says the same.
- `pnpm run claude:catalog` (a dev script, no model call) reads the installed CLI's own model table
  and prints how it differs from the built-in list. Nothing depends on running it: a release may
  add a model to the built-in list, and a model not on it still arrives by itself.

## §app.claude-code-provider/model-table — New Claude models arrive from Claude Code's own table

Claude Code carries a fixed table of its models inside its own program. Sova reads that table at
every start, and while it runs looks at the program file's date every 5 minutes, reading the table
again only when the file or its date has changed. A read makes no model call and needs no login and
no network, so what Sova learns can change only when Claude Code itself does. The model list `claude` gives
apps at initialize is never read, for the list or for any name or identity: it depends on the
account and has been seen to change between asks.

- **What is added.** The table names each family's latest model (`latest_per_family`), and adoption
  stops there. A standard id (§app.claude-code-provider/model-names) comes in when the table names a
  latest for its family and its version is newer than the newest the built-in list has for that
  family and no newer than that latest: a row newer than the family's latest may be unreleased and
  isn't adopted. A family the built-in list doesn't have comes in only through its latest entry,
  that one model. A family the table names no latest for adopts nothing. So a
  Fable 5.3 and a brand-new family's model appear by themselves, and Mythos 5 and Sonnet 3.5 stay out
  until the table names their family. A model added once stays in the catalog, a previous model when
  a newer one comes. Nothing announces it: it simply shows up in the lists.
- **What the table gives.** For a model it lists, the table's context window, output cap, efforts
  and answer ids are the model's, and it says which version is the family's latest. A field it
  doesn't give falls back to a 200,000 window, a 64,000 output cap and no efforts. Id, family,
  version and name never come from the table's labels.
- **What leaves.** A model the table no longer lists leaves every picker and `agent_models`, built
  in or learned; it comes back if the table lists it again. Everything else stays: an old chat
  still opens on it, a saved choice still shows it by name, with no "not verified" note, and still
  runs on it, and its name and its Usage and Costs rows stay. If Anthropic has really shut it down,
  the chat shows Claude's own error. Only a whole table takes a model away: one that names a latest
  for at least one family, has each of those as a row, and has more than half of the built-in ids as
  rows. So an older Claude Code that lacks a few of the newest models still removes them, and a
  fragment removes nothing.
- **Remembered.** What Sova learned is kept on this computer in `<stateRoot>/claude-models.json`,
  written atomically by the server, and is ready at the next start, with no `claude` program,
  offline, or before any read has finished. It is data, never a tracked file.
- **No restart.** A change to the list reaches open pages (the picker and Settings' model rows) and
  running chats (their picker, a model switch to it, `agent_models`) with no restart and no reload:
  every process follows the file, and the server tells open pages (`claude_models_changed`), which
  read `GET /api/claude/catalog` again. The Project Overseer panel and the Orgs view read their model
  list when they open, so they pick up a new model when reopened, with no restart.
- **When the table can't be read.** A read that finds no models, finds a table that isn't whole, finds
  a field gone from every row (context, capabilities or output cap: one row may lack one, a whole
  table lacking it means the field was renamed) or fails Sova's other checks counts as unread, never
  as "no models": the last good list stays, nothing is added or
  removed, and Settings → Profiles' Models part shows one quiet line above its model rows:
  "Showing the last known Claude models: Sova couldn't read Claude Code's model table." The line
  goes at the next good read. It isn't shown when there is no `claude` program to read
  (§app.claude-logins/cli-status says that) or with reading off (`SOVA_MODELS_FETCH=off`, `PI_OFFLINE`,
  or `SOVA_CLAUDE_TABLE=off`, which `dev:hermetic` sets), under which Sova doesn't read the table at
  all and the list it already has still applies. `node scripts/merge-checks/claude-table.mjs` fails
  loudly when Sova can't read the table of the Claude Code on that computer; it is run by hand, not
  by the merge queue.

## §app.claude-code-provider/default-test — A learned model becomes a default after a one-word test

A model learned from the table (§app.claude-code-provider/model-table) is in every picker at once.
A built-in choice moves to it only once Sova has seen it run: Sova sends each learned model one
one-word message, by one `claude` process given that id with `--model`, no tools, on this host's
first usable login (§app.claude-logins/spawn-selection). The call is a one-shot in the usage ledger
(§app.insights/usage-ledger), under its own purpose (`model-check`). An entry in the built-in list needs no test.

- **A pass** is a reply without an error, from that model. It is remembered in
  `<stateRoot>/claude-models.json`, across restarts, and that model is never tested again.
- **Anything else is not a pass**: an error, an expired login, no answer in time, a reply from another
  model, or a test that couldn't run. The built-in choices stay where they are
  and the model stays in the pickers. Sova tries again at its next read of the table, once per model
  each time, so at its next start or the next change of the `claude` program. With reading off
  (§app.claude-code-provider/model-table) nothing is sent.
- **On a pass**, the model becomes its family's current entry if it is the family's newest passed
  model (§app.claude-code-provider/catalog), and each built-in choice naming that family uses it
  from its next use, with no restart. A choice the user saved doesn't move.
- **The picker's newest and the default are separate.** Until Fable 5.3 passes it is the newest
  Fable in every picker while Delegate's planning route stays on Fable 5.2.

## §app.claude-code-provider/model-names — One name for each Claude model

Wherever Sova shows a Claude model (under any provider: `claude-code-cli`, `claude-code`,
`anthropic`), it shows its name: "Opus 5.5", "Sonnet 5.5", "Fable 5.2", "Haiku 4.5". That
holds for the chat model picker and the composer's model chip, Settings' model selects, the session
header, the session list's rows and the assistant's author line, worker rows and their transcripts
in the session pane, the Agents page, the Usage and Costs tables, the subagent profile footprint and
section summaries, workspace panes and their announcements, and /explain captions. Agent-facing tool
text (`agent_models`, `agent_spawn`, `team_create`) keeps the ids an agent passes, with the name
beside them in `agent_models`. The name is of the model that answered when Sova knows it (a reply's
recorded answer, a restored worker's transcript), else of the model asked for. An answer id the catalog lists under
another id (`claude-haiku-4-5-20251001`) and an old id in a file Sova didn't rewrite
(§app.claude-code-provider/legacy-ids) read as their catalog model. "1M" never appears: the window
is the model's own. Where a name stands for an id (a picker row, a select option), the id is
still shown beside it in mono or in its `title`.

**A model's name and identity come from a rule on the id alone**, so they are the same every time
Sova asks, on every screen and every computer, known model or not. A standard id is
`claude-<family>-<major>[-<minor>]`: its family is the capitalised word and its version the numbers,
with a minor of 0 dropped, so `claude-fable-5-2` is family Fable, version 5.2, "Fable 5.2";
`claude-sonnet-4-0` is "Sonnet 4"; a family Sova has never heard of works the same
(`claude-nova-1-2`, "Nova 1.2"). A trailing 8-digit date and a `[1m]` are dropped first, so
`claude-opus-6-20270101` is "Opus 6". The rule reads nothing but the id: no list, no file, no answer
from `claude`, and neither the table's labels nor the list `claude` gives at initialize can change a
name. An id in the old word order (`claude-3-5-sonnet`) isn't standard and, like every other
provider's model, keeps its short id as before.

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

## §app.claude-code-provider/no-memory — Claude Code's auto-memory is always off

Every `claude` process Sova or its extensions start runs with Claude Code's auto-memory off,
whatever the user's own Claude Code settings say: the chat provider's child (a Claude Code
worker's included), the summary line's summarizer, decisions, session titles and a learned model's one-word test.
Such a process never reads a project's memory folder
(`<config dir>/projects/<project>/memory/`, its `MEMORY.md` and notes) into a request and never
writes to it. The setting rides in the one `--settings` object each process is given, merged last,
so a caller's settings (a sandboxed worker's included) cannot turn it back on. Each such process's
environment also sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` over anything inherited or a login adds,
since Claude Code reads that variable before the setting and a `0` or `false` would force memory
on. `claude auth` and
`claude --version` runs make no model request and are left as they are.

## §app.claude-code-provider/one-program — Every `claude` process runs the one Claude program

Every `claude` process Sova starts runs the same Claude program, found from Sova's own environment,
never from the folder a chat or worker works in: the chat provider's child, a learned model's one-word test, a
login's sign-in check, the topic outline's Claude Code summarizer, and the server's own runs (decisions, session titles,
`claude --version`, signing a login in). The server looks it up on first use: the first `claude` on
its own `PATH` (absolute directories only); a version-manager shim found there (mise) is resolved
once to the program it stands for, asked from the server's own folder, else from Sova's own tree;
with no `claude` on `PATH`, `~/.local/bin/claude`, where Claude Code's installer puts it. Every
spawn is given that absolute path, kept while it stays executable, so a project whose `mise.toml`
or `PATH` shim names another `claude`, or none, changes nothing. A `claudeBin` set in
topic-outline.json still overrides it for the summarizer; without one, nothing runs
`~/.local/bin/claude` directly. The path is kept as found, not
followed through its link, so a Claude Code update that moves the link reaches the next launch.
When no Claude program is found, the launch fails with "Claude program not found", naming the
`PATH` directories and the location it looked in; a chat shows that as its turn's error. A caller
given an explicit executable uses that one.

## §app.claude-code-provider/death-reason — A Claude process that dies says why

When a chat's Claude child exits before finishing a turn, or fails its `initialize` handshake, the
error the turn ends with (shown in the chat as the turn's error) is `Claude exited (<code or
signal>) before finishing the turn` (or the handshake's failure) followed by the last lines that
process wrote on stderr: at most 20 lines and 2 KB, the newest kept. With nothing on stderr it is
the bare message.

## §app.claude-code-provider/model-identity — Which model answered, and a mismatch

The model that answered is the API's own id on each reply (a message's `responseModel`, a worker
transcript's model), mapped to its catalog model by the catalog's answer ids. When it is a different
catalog model from the one asked for (a request for Opus 5.5 that Opus 4.8 answered), Sova only says
so and never stops the turn or the worker: the author line names the model that answered and its
`title` reads "Asked for {asked}; {answered} answered."; a worker row shows ⚠ beside its model with
the same `title`; and in the Usage and Costs tables the calls stay on a row of their own, named by
the model that answered, marked ⚠ with the same `title`, never merged into either model's row.

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
