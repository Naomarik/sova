# §app/harness — The harness boundary
> Part of the Sova design spec · [overview](../design/overview.md)

Sova talks to its agent harness through a contract of its own (`shared/harness.ts`): session keys,
neutral history entries, row facts, live events, tools, per-session state and the driving session.
pi is the only harness. Its code lives in `server/harness/pi/`, and nothing else in the server, the
shared code or the web app depends on pi's shapes beyond a recorded list that only shrinks
(§app.harness/boundary).

The contract is types only. `shared/harness.ts` is a barrel over one file per part
(`shared/harness-core.ts`, `-tools`, `-history`, `-wire`, `-state`, `-session`); each imports
nothing but its siblings and emits no code, so the server and the browser bundle can both import it.

## §app.harness/boundary — Nothing outside the adapter reaches pi beyond a shrinking list

`pnpm test` (unfiltered) fails, naming the file, the line and the fix, when:

- a file outside `server/harness/pi/` reaches pi in any form (an import, a type import,
  `import()`, `require`, `import.meta.resolve` or a string naming the package), anywhere in
  `server/`, `shared/`, `src/` or a pi-config file the server or the web app imports at runtime,
  unless the baseline (`server/harness/boundary-baseline.json`) lists that file; a file listed as
  type-only that gains a runtime reach fails too;
- a non-test file there reads raw pi entries (the raw API of the transcript and of the adapter's
  reader, counted wherever either is imported, `getBranch`/`getEntries`/`getEntry`, `rawBranch`; `customType` reads and `.type` compared with a pi entry type; a reach
  into `sessionManager` or a member only pi's SessionManager has), or writes custom entries
  (`appendCustomEntry`, `appendEntry`, `appendSpecialEntry`, each call counted whatever its type
  argument), more often than the baseline records for that file. A file that re-exports the raw API
  fails too, except the transcript and the reader forwarding each other's, whose importers are both
  counted. It also fails when one does so
  less often, or when a listed file has nothing left: the baseline is lowered in the same change,
  so it only shrinks;
- a function forwards its own parameter as a custom entry's type without being listed as a
  wrapper, or a listed wrapper is gone;
- a non-test file in `server/` reads one of pi's agent session members through a `.session.`
  property (or a runtime's `.runtime.session` / `.runtime.services`) more or less often than the
  baseline's `session` list records for it, the hosted chat included; `sessionId` and `sessionFile`
  are not counted, because Sova's own records use those names;
- a non-test file there uses the adapter's hand-out of raw custom entries (`extensionEntries`, for
  the pi-config cores that fold pi's own entry shape) more or less often than the baseline's
  `extension` list records for it;
- a non-test file there imports what only tests may (`server/harness/pi/testing/` or the runtime
  registry `server/harness/pi/host-registry.ts`), in any form; casts the driving session or one of
  its parts, or reads one of its members by a string; or uses a per-session state kind that is not a
  registered one (a cast or declaration as a kind outside `server/harness/state-kinds.ts`, or a
  kind built, cast or looked up by string at the state writer's `append`). These have no baseline;
- the baseline in the working tree adds a file, raises a count or turns a type-only entry into a
  runtime one compared with the committed baseline;
- a `shared/harness*.ts` file imports anything but a sibling, or declares anything that emits code;
- a test file under `server/`, `shared/` or `src/` is matched by none of the runner's file
  patterns, which include every test under `server/harness/`, or names itself an integration test
  other than as `*.integration.test.ts`, so every test file is in exactly one tier
  (§app.server-runtime/test-tiers). This check is in the unit tier, which `pnpm test` runs.

A contract suite in `server/harness/pi/` pins the pi behaviours Sova relies on (the `append*`
methods of pi's session manager, the custom entry's line, the event names a run emits, image
content). It runs in every unfiltered `pnpm test` against the pinned pi, and against another pi
copy with `PI_PACKAGE_DIR` set.

## §app.harness/new-work — Rules for new work

- A server feature imports `shared/harness.ts` and `server/harness/`, never pi.
- New per-session state goes through `SessionState`, never a raw custom entry with a new customType.
- History is read through the neutral reader, never `parseLines` plus a switch on `entry.type`.
- Wire additions use `SovaEvent` and `RowFacts`; `src/` never branches on pi entry or event names.
- A new Sova agent feature is never a new pi-config extension and never a new call to an
  extension's command handler. Existing extensions are grandfathered, and the pi-config files the
  server imports stay pi-free.
- The boundary baseline is never grown to make a change pass: adding a file, raising a count or
  listing a new wrapper needs the user's say-so.

## §app.harness/agent-root — One agent directory

Every path the server builds under the agent directory comes from one function, `agentRoot()`
(`server/state-root.ts`), which resolves the directory exactly as pi does (`$PI_CODING_AGENT_DIR`,
with a leading `~` expanded, else `~/.pi/agent`) and reads it on every call, so a test or a process
that moves `PI_CODING_AGENT_DIR` moves every such path at once. Sova's own state root is
`<agentRoot()>/sova`. Only the pi adapter (`server/harness/pi/agent-dir.ts`) asks pi for it.

## §app.harness/tools — Sova's tools are harness-neutral

Sova's own tools are written as the contract's `ToolSpec`: plain JSON-schema parameters, a Sova
result, and a Sova context (`ToolCtx`). The pi adapter (`server/harness/pi/tools.ts`) turns each
into a pi tool when a session registers it, unchanged in name, label, description, prompt snippet,
parameters, execution mode, result, details and streamed updates, and gives the tool, and each of
Sova's own extension hooks, its session id, working directory, leaf and active branch; a hook also
gets the session's key (its canonical file path, none while the session has no file) and its
recorded name. A tool reads its session's state through the context's `state()`, a `StateView` over
the active branch (§app.harness/state); the neutral branch and that state are its only reads of the
session's entries, with no raw-branch access. A pi tool that Sova code calls (the Overseer's subagent tools) gets its own pi
context back.

## §app.harness/reader — One reader for pi's session files

Sova reads pi's session files through one adapter reader (`server/harness/pi/reader.ts`, its
usage and context-fill rules in `server/harness/pi/usage.ts`), which turns each entry into the
contract's neutral history entry (`HEntry`, `shared/harness-history.ts`) and keeps the raw entry
beside it for the readers that have not moved yet. The reader only reads: it never writes, rewrites
or repairs a file. Its parse and its branch rule are today's: blank and malformed lines are skipped,
the active branch is the last entry walked up by its parent ids (root first, a cycle stops the
walk, a later duplicate id wins), and a file with any entry lacking an id is read as one linear
branch. A held session is read live through the same entries, and a Sova tool or hook gets its
session's active branch as neutral entries too. Format-agnostic JSONL (Claude Code transcripts)
is parsed by `server/jsonl.ts`, outside the adapter.

Golden tests (`server/harness/pi/golden/`) characterize the readers: they run every reader's probe
over committed synthetic, recorded pi 0.87.1 and Claude Code fixtures and, where present, a local
corpus of real sessions, and compare each output with the recorded one, byte for byte for
transcript rows. An intended output change re-records the expected outputs with one command, and
their diff is reviewed with the change that caused it.

## §app.harness/unknown-entries — An entry this version can't read

An entry the reader doesn't know (an entry type, or a message role, that the pinned pi doesn't
write) stays in the session's tree and on its branch, and can be its leaf. The transcript keeps
showing it as an Unrecognized entry row with its raw entry (§chat.transcript), and nothing else
reads it: usage, context fill, titles and summaries, unread and attention marks, fork and rewind
checks, insights and the baton views ignore it, so inserting one anywhere changes none of their
outputs. The server counts each such entry once (by type and id) from its start, logs each new
type's name once, and reports only the count in `GET /api/health` (§chat.profiles/live-commit).

## §app.harness/wire — Live events and row facts in Sova's words, for a consumer that asks

A browser can read a session's live events and its rows' facts in the contract's words
(`SovaEvent` and `RowFacts`, `shared/harness-wire.ts`) instead of pi's. It asks with `wire=2` on
`/ws/chat`, `/ws/watch` and `GET /api/transcript` (not `v`, which those routes and the share
sockets already read as the visit's tab).

- **Only a consumer that asks gets wire 2.** It gets each live event as
  `{type: "event", v: 2, event}`, with the entry a message was written as named inside its end,
  and each entry's first row with `facts` (a setting change, a context reset, a compaction's
  figures, a reply's context fill, a tool result's tool and failure) and no `meta`. A consumer that
  doesn't ask (an older bundle, a cached page, an older peer's page through this host's mesh proxy,
  a script) gets today's frames and rows byte for byte, and nothing it shows changes.
- **One mapping, on both sides.** Every wire-2 event is a wire-1 event mapped by one pure function,
  and every row's facts are its wire-1 facts mapped by another (`fromV1` and `factsFromMeta`,
  `shared/wire-v1.ts`); the server and the browser use the same two. A wire-1 event the live view
  ignores maps to nothing.
- **An older peer still reads.** A browser that asked for wire 2 and got wire 1 (an older server
  ignores the parameter) maps the frames and rows itself, through those same functions, and shows
  the same thread, the same live reply and the same context fill.
- **Hops change nothing.** The mesh proxy passes the parameter and the frames through untouched,
  and the share pages' sockets carry no events and no row facts: their frames stay as they are.

## §app.harness/state — Per-session state goes through SessionState

Sova's per-session state (the hidden records a session file keeps beside its conversation: a
profile, a loadout, a mode pin, a subagent profile pick, sender markers, rewinds, approvals, baton
events, …) is read and written through the contract's `SessionState` (`shared/harness-state.ts`).
Each kind of state is registered once, in `server/harness/state-kinds.ts`: its name on disk (pi's
custom entry type, unchanged), its owner (Sova, or the pi-config extension whose core owns the
shape), a strict parse that skips a malformed record, and how readers fold it. A view
(`server/harness/state-view.ts`) reads one kind over the active branch or over the whole file: the
newest well-formed record wins, a list runs oldest first over well-formed records only, presence
ignores what a record holds, and an identity marker is the first record written. For every
registered kind the view gives what that kind's existing fold gives, on synthetic sessions
(malformed records, abandoned branches) and on the local corpus of real sessions.

The pi adapter (`server/harness/pi/state.ts`) is the one place that writes it: one synchronous
append of the caller's data as given, never copied, normalized, checked or flushed, so a file holds
the same bytes, written at the same moment, as the write it replaces. A write from inside a running
tool still goes through pi's extension API, so the session still announces it; a new session file
seeded with state is still written whole, header first. No Sova code outside the adapter appends a
custom entry, and Sova never writes a type the registry doesn't list.

## §app.harness/session — A hosted chat drives its agent through the driving session

A hosted chat (`server/chat-manager.ts`) drives its agent through the contract's driving session
(`HarnessSession`, `shared/harness-session.ts`), whose pi implementation is
`server/harness/pi/session.ts`: it sends, steers and wakes a run, reads and clears the agent's own
queue, stops a run, switches model and thinking, appends a note or a user message outside a run,
lists the active and registered tools and the slash commands, reads its session's history and state,
and hears the run's live events. The session looks pi up again at every call, so whatever pi
session the chat's runtime holds at that moment, and any method replaced on it since, is the one
used. Each pi event reaches the chat once, in pi's own listener, in the order and tick pi emits it,
named in Sova's words and carrying the wire-1 frame the chat forwards. Moving the chat onto it
changes nothing a client, a session file or an extension sees: the session goldens
(`server/harness/pi/golden/session/`, S1–S15) record each scenario's session file, pi's calls in
order and the frames it exercises to two clients (a hello cut to its state and rows; a frame type no
scenario exercises left out, so a new one re-records nothing), and compare them byte for byte.

The chat imports nothing from pi and never holds pi's session or runtime: the adapter holds the
runtime for it (`server/harness/pi/host.ts`), binding its extensions to the chat's dialogs, giving
its provider requests the sliced reads, handing out the model runtime the context windows come from,
and disposing it. A test that drives or patches pi directly gets the runtime's session through
`server/harness/pi/testing/handle.ts`, looked up at each call as the driving session looks it up, so
a method a test replaces after open is the one the chat's calls reach.

Server code outside the chat that asks about a session this server holds asks the chat's driving
session too, never pi's agent session: whether a reply is running, whether the agent still holds
queued messages, the model (and whether it takes images) and the thinking level, the session's id,
folder and active branch, what its runtime loaded for its prompt (context files, skills, the system
prompt's sources), and stopping a reply at shutdown. A folder no runtime holds is read with pi's own
loader, without extensions, by the adapter (`server/harness/pi/resources.ts`). The Overseer's
alignment reads fold a session's neutral entries, and the worktree cleanup and a link's sandbox read
the session file through the neutral reader. Every answer is the one pi gave before: the routes,
tools and pages that use them show exactly what they showed.

Every place Sova leans on pi behaviour pi does not promise (a method it replaces, a private member
it reads, an error it knows by its text, an order of two steps, an internal API) is a row of the
quirk registry (`server/harness/pi/quirks.ts`, read as `server/harness/pi/QUIRKS.md`) naming the
code that relies on it and a canary in the contract suite that fails when pi changes under it.
`pnpm test` fails when a private cast or an assignment over a pi member in `server/` or `shared/`
sits at a site no row names, when a row's canary is missing, or when the two views disagree.

What the boundary baseline still counts (§app.harness/boundary) lies outside the hosted chat and
the session code around it: the pi imports of the tests that build their fixtures with pi itself, of
the Overseer's file tools (pi's own read, grep, find and ls, guarded) and of the subagents' fork-cache
extension, and the v1 wire shim's reads of pi's event and entry names (§app.harness/wire). The mesh
hello's pi version and login sync's pi lock and auth refresh come from the adapter
(`server/harness/pi/package.ts`).

## §app.harness/session-open — The adapter opens a chat's runtime and bridges its dialogs

A hosted chat's runtime is opened by the pi adapter (`server/harness/pi/open.ts`): it opens the
session file, builds pi's services and session with the extensions, tool lists and extension flags
Sova decides (the flags by meaning: topic outline, remote target, the Claude Code provider,
adversarial review, the link origin and its token; named in pi's words only there), resolves the
model a message-less session opens on (its recorded model, else the saved default Sova passes), and
likewise its effort, unless Sova asks one open to skip what the file records, as a new session would; and
warms the Claude Code provider. Creating the one shared model runtime also applies the cached model
levels and starts pi's built-in catalog refresh in the background (§app.model-levels/sova-boot).
The chat (`server/chat-manager.ts`) keeps the policy: which special
loadout, profile, loadout and defaults apply, decided from a read of the session's neutral history
and state that the adapter hands it; a special session kind recognises its file from that read too,
never from pi's session manager. Opening still writes nothing: the model and thinking records pi
makes while building a session are held until the chat's first write, the one that restates the
file's recorded model is dropped, and the hold lasts until the whole open, a special session's own
setup included, is over.

Extension dialogs reach the chat through a dialog bridge (`DialogBridge`, `shared/harness-session.ts`;
pi's side is `server/harness/pi/ui-bridge.ts`, which turns pi's UI calls — select, confirm, input,
editor, notify, status, the theme — into bridge requests). The chat keeps the pending dialogs and
their broadcast, answer, timeout, abort and fallback. A session's title (its name, else its first
message's text, else "Untitled") is read from the neutral history; a first message stored as a bare
string, as legacy files keep it, still titles "Untitled". None of this changes what a client, a
session file or an extension sees: the session goldens pin the session file, pi's calls and the
frames their scenarios exercise, and the reader goldens the readers' outputs.

## §app.harness/session-history — Rewind, compaction and the extension commands go through the driving session

A hosted chat rewinds, compacts and runs an extension's own command through its driving session
(`HarnessSession`) too, never by reaching pi itself. A rewind (`rewindTo`) moves the leaf to just
before a user input on the active branch and then writes its marker through the session's state; a
compaction (`compact`) runs pi's own, with Sova's write guards and the open-time appends run at the
moment pi writes its entry, and pi's refusals told apart by their text; both report a refusal (and
why) rather than throw, and the chat decides what a refusal its own write guards raised means. Stop
drains the queue and then stops the run through the driving session as well. The four extension
commands Sova runs directly, never through a send (the mode, sandbox and agent-resume commands and
the claude-code extension's login command), are found by the extension that registered them
(`command`), so a same-named command from another extension never runs, and run with a context the
session makes (`commandContext`), their arguments exactly as before. pi's side is
`server/harness/pi/history-ops.ts` and `server/harness/pi/commands.ts`; each pi behaviour they lean
on stays a row of the quirk registry. Moving them changes nothing a client, a session file or an
extension sees: the rewind and compaction marker order, the Stop drain, regenerate and every
command's arguments are pinned by the session goldens (S4–S8, S15) and the rewind, compaction,
abort, sandbox and worker-resume suites.

## §app.harness/session-special — The special loadouts and the stream guard drive a session through the harness

The Overseer, a project's overseer and a baton session (its wrap-up included) watch each session
their runtime builds as a driving session (`HarnessSession`, `shared/harness-session.ts`), and the
runaway-stream guard (§chat.transcript/runaway-stream) watches a chat's stream through it too:
none of them reaches pi's session, and none imports pi. Their live events are the driving
session's, in Sova's words, one per pi event in pi's own listener and tick, registered where they
were before, so every listener keeps its place in the order. Such an event carries what these
watchers read: a streaming reply's delta (a tool call starting, its argument characters, text or
thinking) and the reply so far, whether a compaction is followed by a retry of the request, and a
custom message's note type, by which the Overseer tells its own state notes from input.
Who sent a user message (§app.overseer/input-source) is still told by the object the message
reaches the agent as, through the driving session's user-message hook, one wrap per agent.
Rebuilding the Overseer's system prompt from its refreshed parts at a run's start, and switching
a baton session's active tools, are driving-session calls; the pi quirk behind the first stays in
the quirk registry. The Overseer reads its subagent tools through the driving session, as Sova
tools. The extension factories of these loadouts are typed from the adapter's extension types
(`server/harness/pi/extension-types.ts`), and so are Sova's other inline extensions (the vis check,
topics, the resource monitor, the project services), the loadout's skills override and the context
windows read off the model runtime. Nothing a client, a session file, an extension or a model sees
changes: the session goldens compare byte for byte.
