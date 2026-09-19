# Mode switcher for pi: investigation report

Date: 2026-09-19. pi version inspected: `@earendil-works/pi-coding-agent` 0.85.1
(`$(npm root -g)/@earendil-works/pi-coding-agent`).
Scope: design and feasibility only. Nothing has been implemented.

Sources read: `README.md`; `docs/extensions.md`, `tui.md`, `keybindings.md`,
`prompt-templates.md`, `skills.md`, `sdk.md`, `environment-variables.md`,
`settings.md`, `themes.md`, `packages.md`, `terminal-setup.md`;
`examples/extensions/` (notably `plan-mode/`, `preset.ts`, `status-line.ts`,
`custom-footer.ts`, `prompt-customizer.ts`, `model-status.ts`, `subagent/`);
`@earendil-works/pi-tui/dist/keys.js` and `terminal.js` (key parsing); the
user's `~/pi-config` repo (`extensions/subagents`, `extensions/claude-code`,
`command-palette`, `extension-toggle`, `sessions`, `topic-outline`,
`usage-status.ts`, `settings.json`, `keybindings.json`, `install.sh`); Ghostty
default keybinds (`ghostty +list-keybinds --default`).

---

## 1. Feasibility summary

**Verdict: fully feasible as one small global extension, no pi changes needed.**
Every required piece has a documented extension API that works live, without
restarting pi.

| Need | pi support | Notes |
|---|---|---|
| Native "mode" concept | **None.** README: pi "skips features like sub agents and plan mode" and expects extensions to add them. | `examples/extensions/plan-mode/` is the reference pattern for exactly this shape (command + shortcut + flag + status + prompt injection + persistence). |
| Change the main agent's instructions per turn, toggleable live | **Yes.** `before_agent_start` returns `{ systemPrompt }` (chained, per turn) and/or `{ message }`. | `extensions.md` "before_agent_start", `ctx.getSystemPrompt()`. No restart, no `/reload`. |
| Slash command + argument completion | **Yes.** `pi.registerCommand(name, { handler, getArgumentCompletions })`. | Appears automatically in the user's `command-palette` (it uses `pi.getCommands()`). |
| Keyboard shortcut | **Yes.** `pi.registerShortcut("alt+m", { description, handler })`. | Extension shortcuts are hard-coded by the extension; `keybindings.json` only remaps built-in action ids. |
| Always-visible mode indicator in the footer | **Yes.** `ctx.ui.setStatus(key, text)` renders in the footer status line. | The user's `usage-status.ts` footer replacement explicitly re-renders `footerData.getExtensionStatuses()` on its third line (`usage-status.ts:592`), so the indicator survives the custom footer. |
| Spawn Claude Code workers with a specific model and effort per spawn | **Yes**, via the user's own `subagents` + `claude-code` extensions. | `agent_spawn` accepts `backend`, `model`, `effort` per agent; the Claude runner passes `--model` and `--effort` to the CLI on every spawn (`claude-code/runner.ts:215-216`). |
| Automatic fable → opus fallback | **Not built in.** The backend has no retry/fallback. | Achievable two ways: pre-flight model discovery in the extension, plus instruction-level retry by the main agent (section 2c). |
| Global persistence across restarts | **Yes**, plain file under `getAgentDir()` (`~/.pi/agent/`). Session-level persistence via `pi.appendEntry()`. | User chose global scope; both layers are cheap. |
| Startup flag | **Yes.** `pi.registerFlag("mode", { type: "string" })`. | `pi --mode claude-heavy`. |

What is genuinely hard or unsupported:

- **Ctrl+Tab as the shortcut** is unreliable: Ghostty binds it to `next_tab`
  by default so pi never sees it, and legacy terminals send a bare `\t`.
  Details in section 3.
- **Hard enforcement of delegation** is only partially possible. The extension
  can remove `edit`/`write` from the main agent's active tools
  (`pi.setActiveTools`), but `bash` can still modify files. Proposed as an
  optional "strict" sub-mode, off by default.
- **Leader / double-tap chords** are not supported by `registerShortcut`
  (single chord only). Would require wrapping the editor component. Not
  recommended.

---

## 2. Design questions

### (a) Mode concept

No native mode. The cleanest mechanism is a single global extension
(`~/pi-config/extensions/mode/`, symlinked into `~/.pi/agent/extensions/` by the
existing `install.sh`) that owns one piece of state, `mode: "normal" |
"claude-heavy"`, and exposes it through:

1. `/mode [normal|claude-heavy]` (no argument toggles; completions provided).
2. A shortcut (`alt+m`, see section 3).
3. A footer status via `setStatus("mode", …)`, always set.
4. `before_agent_start` system-prompt append when in `claude-heavy`.
5. A global state file plus a session entry.

Rejected as the primary mechanism:

- **Prompt template** (`~/.pi/agent/prompts/heavy.md`): expands into a single
  user message; not persistent, no indicator, no toggle.
- **AGENTS.md conditional text**: static, cannot be toggled live, and would
  leak instructions into normal mode.
- **A model-callable tool to switch modes**: fine as an add-on, but the user
  wants a user-facing switch; the agent should not silently change mode.

### (b) Behavior injection

`before_agent_start` fires after every user submit and before the agent loop.
The handler receives `event.systemPrompt` (already chained through earlier
extensions) and may return a replacement. Returning
`event.systemPrompt + "\n\n" + HEAVY_INSTRUCTIONS` when the mode is
`claude-heavy`, and nothing otherwise, gives an immediate, per-turn, restart-free
switch. The doc confirms `ctx.getSystemPrompt()` reflects the chain at that
point.

Alternative in the same hook: return `{ message: { customType:
"mode-context", content, display: false } }`. That stores a persistent message
in the session each turn; `plan-mode` does this and then filters stale copies
out in the `context` event. Trade-off:

| | systemPrompt append | injected message |
|---|---|---|
| Where the model sees it | system prompt (strongest steering) | as a user-role message each turn |
| Prompt cache | switching modes invalidates the whole cached prefix once; stable afterwards | system prefix stays cached; each injected message is new tokens every turn |
| Session file growth | none | one entry per turn, needs `context` filtering when mode is off |
| Recommendation | **use this** | fallback if a provider misbehaves with dynamic system prompts |

Optional extras available in the same place: `pi.setThinkingLevel("high")`
for the orchestrator (restore on exit), and `pi.setActiveTools()` to drop
`edit`/`write` in strict mode. Both are documented and reversible; `preset.ts`
shows the snapshot/restore pattern.

Live toggling: the mode variable is read inside the hook, so `/mode` or the
shortcut affects the very next turn. No `/reload` required.

### (c) Delegation mechanics

Confirmed from the user's `subagents` and `claude-code` extensions:

- `agent_spawn` takes either a single spec or `agents: [...]` (max 8 per call,
  12 live). Each spec has `backend`, `model`, `effort`, `tools`,
  `systemPrompt`, `cwd`, `wake`, `backendOptions`.
- With `backend: "claude-code"`, `claude-code/index.ts` `prepare()` validates
  and forwards `model` (default `sonnet`) and `effort` (default `medium`,
  allowed `low|medium|high|xhigh|max`). `validateClaudeModel` rejects only
  empty, leading `-`, whitespace, `/`, or NUL, so `opus[1m]` and
  `claude-fable-5-1[1m]` are accepted verbatim.
- `ClaudeRunner.start()` builds `claude -p … --model <m> --effort <e>` per
  worker. **Effort is therefore honored per spawn**, including inside a batch
  where each agent can differ.
- Claude workers default to `bypassPermissions`, tools
  `Bash,Read,Edit,Write,Glob,Grep`, and accept `systemPrompt` via a temp
  `--append-system-prompt-file`. They cannot fork pi history or load pi
  extensions; prompts are capped at `MAX_CLAUDE_INPUT_CHARS`.
- When a worker settles with `wake: true` (default), the manager posts a
  `subagent-complete` message with `deliverAs: "followUp", triggerTurn: true`
  (`subagents/index.ts:518`), so the orchestrator is woken with the result and
  can review it. `agent_wait` is only needed for synchronous dependency.
- `agent_models` (backend `claude-code`) runs `claude … initialize` and returns
  the CLI's model list with `supportedEffortLevels`. This is the authoritative
  way to check whether fable is available at all.
- Workers are session-scoped: `/reload`, session switch and quit stop them.

Fallback "fable by default, opus high if fable is unavailable or fails":

1. **Pre-flight (extension-side, recommended).** On entering `claude-heavy`
   (and on `session_start` while in that mode), the extension emits
   `subagents:backend-discover` on `pi.events`; the `claude-code` extension
   answers with its `BackendRegistration`, whose `listModels(ctx)` returns the
   CLI model list (contract in `subagents/contracts.ts`). If
   `claude-fable-5-1[1m]` is absent or discovery fails, the extension sets
   `planner = { model: "opus[1m]", effort: "high" }` and bakes that into the
   injected instructions and the status text (`◆ claude-heavy · plan:opus`).
   This removes the most common failure (model not offered on this account)
   before any spawn.
2. **Runtime failure (instruction-side).** If a planning worker settles with
   outcome `error` (the wake message says so), the instructions tell the main
   agent to respawn once with `opus[1m]` / `high`, and to mention the fallback
   in its report. No backend change is needed.
3. **Optional hardening.** A `tool_call` hook on `agent_spawn` can mutate
   `event.input` (documented as mutable) to rewrite `model:
   "claude-fable-5-1[1m]"` to the fallback when pre-flight marked it
   unavailable, and to fill in a missing `effort`. This guards against the
   model ignoring the instructions. Not required for v1.

### (d) Visible mode state

Covered in section 3 (UX). Summary: `setStatus("mode", …)` is always set,
never cleared, in both modes; `/mode`; `alt+m`; the command palette picks up
`/mode` automatically; `session_start`, `model_select` and
`thinking_level_select` handlers re-assert the status so it survives
`/reload`, `/new`, `/resume`, footer re-creation and model changes.

### (e) Persistence

User decision: **global scope**. Layers, highest precedence first:

1. `--mode <name>` CLI flag (`pi.registerFlag`), for scripted launches.
2. Global file `~/.pi/agent/mode.json` (`join(getAgentDir(), "mode.json")`),
   written on every switch. This is the one source of truth across projects
   and restarts. Format: `{ "version": 1, "mode": "claude-heavy",
   "planner": "fable" | "opus", "strict": false }`.
3. Session entry via `pi.appendEntry("mode", { mode })` on every switch. Used
   only to render a transcript marker (`registerEntryRenderer`) so the user can
   see where a session changed mode, and so `/fork` and `/resume` show the
   right history. It does **not** override the global file.
4. Default `normal`.

Environment variables are not needed: pi does not read custom `PI_*` variables,
and a variable cannot be updated by a running process for the next launch.
Per-project scoping (`.pi/mode.json` via `CONFIG_DIR_NAME`) is trivial to add
later but is intentionally out of scope.

### (f) Effort-dictation wording

Drafted in section 4. Rules encoded: simple questions and conversation stay
local; anything that would be implementation work or would normally use
subagents is delegated; coding goes to `opus[1m]` with `low` for mechanical
tasks and `medium` where precision matters; planning goes to
`claude-fable-5-1[1m]` `medium` with explicit fallback; the main thread reviews
everything and is the only voice to the user.

---

## 3. UX proposal (status bar is the centerpiece)

### Footer indicator (always on)

Rendered with `ctx.ui.setStatus("mode", text)` and never cleared while the
extension is loaded. Theme colours via `ctx.ui.theme.fg(...)`.

| Mode | Text | Colour token |
|---|---|---|
| normal | `• normal` | `dim` |
| claude-heavy, fable available | `◆ claude-heavy` | `accent` |
| claude-heavy, fable unavailable | `◆ claude-heavy · plan:opus` | `warning` |
| claude-heavy, strict tools | `◆ claude-heavy · strict` | `accent` |

Placement: the built-in footer and the user's `usage-status` footer both put
extension statuses on the status line after the token stats, alongside the
existing `subagents` and `team` statuses. The label is deliberately short so it
does not get truncated at narrow widths.

Additional feedback on switch: `ctx.ui.notify("Mode: claude-heavy", "info")`
plus a transcript marker entry (`appendEntry` + `registerEntryRenderer`) reading
`── mode → claude-heavy ──`, so scrolling back shows when behaviour changed.
Optional: `ctx.ui.setWorkingMessage("Orchestrating…")` while in claude-heavy
so the streaming row also hints at the mode.

### Commands

- `/mode` toggles.
- `/mode normal`, `/mode claude-heavy` set explicitly (argument completion via
  `getArgumentCompletions`).
- `/mode status` prints current mode, planner model, strict flag, and the
  path of the state file.
- `/mode strict on|off` toggles the optional tool restriction.
- `pi --mode claude-heavy` starts in that mode for one launch.

### Shortcut: `alt+m` (default), Ctrl+Tab opt-in

**Ctrl+Tab investigation.**

- pi's key parser can match `ctrl+tab`: `keys.js` case `"tab"` accepts any
  modifier through a Kitty CSI-u sequence or xterm `modifyOtherKeys`. So the
  binding is expressible as `pi.registerShortcut("ctrl+tab", …)`.
- Delivery depends on the terminal. Legacy terminals send a bare `\t` for
  Ctrl+Tab (indistinguishable from Tab, which is `tui.input.tab`). pi
  negotiates the Kitty protocol at startup (`terminal.js`,
  `queryAndEnableKittyProtocol`), and Ghostty supports it, so the sequence
  *would* arrive on this machine…
- …except Ghostty binds `ctrl+tab=next_tab` and `ctrl+shift+tab=previous_tab`
  by default (`ghostty +list-keybinds --default`). The terminal consumes the
  key; pi never sees it. It would work only after adding
  `keybind = ctrl+tab=unbind` to `~/.config/ghostty/config`, and would still
  break inside tmux without `extended-keys on`.

Conclusion: Ctrl+Tab is **not reliable** and would silently do nothing (or
switch terminal tabs). Offer it as a documented opt-in only.

**Taken keys audit** (single-chord, easy to reach):

| Key | Taken by |
|---|---|
| `ctrl+g` | pi `app.editor.external` |
| `ctrl+p` / `shift+ctrl+p` | pi model cycle; user rebinds cycle to `ctrl+alt+p`; `command-palette` uses `ctrl+p` |
| `alt+p` | user `app.session.togglePath` |
| `ctrl+alt+a` | user `app.models.toggleProvider` |
| `alt+s`, `alt+shift+s` | user `sessions` extension |
| `alt+o` | user `topic-outline` extension |
| `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+x`, `ctrl+s`, `ctrl+r`, `ctrl+n`, `ctrl+d`, `ctrl+c`, `ctrl+z`, `ctrl+v`, `ctrl+a/e/b/f/k/u/w/y/j/]`, `shift+tab`, `alt+enter`, `alt+up`, `ctrl+shift+f/g/up/down` | pi built-ins (keybindings.md) |
| `ctrl+shift+t/w/n`, `ctrl+enter`, `ctrl+0`, `ctrl+page_up/down`, `alt+<digit>` | Ghostty defaults |
| `ctrl+m` | equals Enter on legacy terminals; avoid |

**Free and easy:** `alt+m`. Not bound by pi, by Ghostty, or by any user
extension; matches the user's existing `alt+<letter>` convention (`alt+s`,
`alt+o`, `alt+p`); `keys.js` handles Alt+letter both as legacy `ESC m` and as
Kitty CSI-u, so it works in Ghostty, Alacritty, kitty and tmux without any
terminal configuration. Mnemonic: **m**ode.

Runner-up if `alt+m` is ever wanted for something else: `alt+h` (heavy), also
free by the same audit.

The extension will read an optional `"shortcut"` field from
`~/.pi/agent/mode.json` so the user can move the binding (for example to
`ctrl+tab` after unbinding it in Ghostty) without editing code.

### Toggle flow

1. User presses `alt+m` (or `/mode`).
2. Extension flips state, writes `~/.pi/agent/mode.json`, appends the session
   marker, updates the footer status, shows a one-line notify.
3. If entering claude-heavy: kick off Claude model discovery in the background
   (15 s timeout, cached 60 s by the backend); when it returns, refresh the
   status to show `plan:opus` if fable is missing. Optionally raise the
   orchestrator's thinking level and, in strict mode, drop `edit`/`write`.
4. If leaving claude-heavy: restore thinking level and tools that were
   snapshotted on entry.
5. Next user prompt: `before_agent_start` appends or omits the instructions.
   Mid-stream toggles take effect on the next turn (the hook runs per prompt).

---

## 4. Injected instruction text (claude-heavy)

Appended to the system prompt in `before_agent_start`. `{PLANNER_MODEL}` and
`{PLANNER_EFFORT}` are filled by the extension (`claude-fable-5-1[1m]` /
`medium` normally, `opus[1m]` / `high` when pre-flight found fable missing).
`{FALLBACK_NOTE}` is empty in the normal case and reads "fable is unavailable
in this session; the planner is already opus[1m] high" otherwise.

```
# Mode: claude-heavy (orchestrator)

You are the orchestrator for this session. You are the only party that talks
to the user. Implementation and planning work is delegated to Claude Code
background workers through agent_spawn with backend "claude-code". You review
and verify everything they produce before reporting it. Workers never address
the user; their output is raw material for your own answer.

## What you handle yourself (do NOT delegate)

- Answering questions, explanations, opinions, and conversation.
- Reading, searching or summarising code to answer a question, when no files
  will change.
- Trivial one-line fixes the user points at directly (a typo, a wrong
  constant, a missing import) where the change is unambiguous.
- Running a command the user asked for and reporting its output.
- Reviewing, verifying and summarising worker results.

Examples that stay local: "what does this function do?", "why is this test
flaky?", "which files touch auth?", "bump the timeout to 30s", "run the tests
and tell me what fails", "explain the difference between these two options".

## What you delegate (always)

Anything you would otherwise do with edit/write across more than a trivial
change, anything that would normally justify a subagent, and any non-trivial
design work:

- Implementing a feature, fixing a bug that needs investigation, refactoring,
  writing or updating tests, migrations, multi-file edits, new modules.
- Producing an implementation plan, an architecture or design proposal, a
  review of trade-offs, or a task breakdown for a larger change.

Examples that get delegated: "add rate limiting to the API", "fix the race in
the worker pool", "write tests for the parser", "refactor this into a module",
"plan how we would move to the new auth library", "review this design".

If the request mixes both (a question plus a change), answer the question
yourself and delegate the change.

## Coding tasks → opus[1m] on claude-code

Spawn with backend "claude-code", model "opus[1m]", and choose effort by the
precision the task demands, not by its size:

- effort "low" for mechanical or well-specified work where mistakes are cheap
  and easy to spot: renames, boilerplate, applying a pattern that already
  exists in the codebase, straightforward tests, formatting, simple CRUD,
  changes you can fully describe in a few sentences.
- effort "medium" for work that requires precision or judgement: concurrency,
  error handling, data migrations, security-relevant code, subtle bugs,
  changes touching public interfaces or several interacting modules, anything
  where a wrong choice is expensive to undo.

Do not use "high" or above for coding unless the user asks. When unsure
between low and medium, pick medium.

Write each worker prompt so it is self-contained: goal, the files or areas
involved, constraints and conventions you already know, how to verify (tests,
type checks, commands), and what to report back. Workers start with no
history. Prefer several small, independent workers in one agent_spawn batch
over one large worker; keep each below the prompt size limit.

## Planning tasks → {PLANNER_MODEL} on claude-code

Spawn with backend "claude-code", model "{PLANNER_MODEL}", effort
"{PLANNER_EFFORT}". Use backendOptions { "permissionMode": "plan" } or tools
["Read","Glob","Grep","Bash"] so the planner explores but does not edit.
{FALLBACK_NOTE}
Fallback rule: if a planning worker fails to start or settles with an error
that mentions the model, availability, or authorization, spawn it again once
with model "opus[1m]" and effort "high", and say in your report that the
fallback was used. Do not retry more than once without telling the user.

The user may override the planner effort for a task ("plan this at high");
honour that for that task only.

## Orchestration rules

- Return to the user promptly after spawning: workers wake you when they
  settle. Use agent_wait only when the next step truly depends on the result.
- You remain responsible for verification regardless of effort level. For
  every worker result, before you report it: read the diff or the changed
  files, run the project's tests or type checks yourself when they exist, and
  check the work against the original request. Low-effort work gets the same
  verification as medium-effort work; effort controls how the worker thinks,
  not how carefully you check it.
- If a result is wrong or incomplete, steer the same worker with agent_steer
  or spawn a corrected task. Do not silently fix large problems yourself; a
  trivial touch-up is fine if you say so.
- Never paste a worker's report to the user as if it were yours. Summarise
  what changed, what you verified and how, what failed, and what remains.
  Attribute clearly: "the worker implemented X; I verified Y".
- Do not create Claude workers for things the section "What you handle
  yourself" covers. Delegation has overhead; use it where it pays.
- Coordinate multiple workers explicitly: assign non-overlapping files, and
  serialise tasks that touch the same area.
```

Length is about 5 KB. It is stable across turns, so the provider cache holds
after the first turn in the mode.

---

## 5. Recommended design and file layout

```
~/pi-config/extensions/mode/          (symlinked to ~/.pi/agent/extensions/mode by install.sh)
├── index.ts        # pi wiring: command, shortcut, flag, status, hooks
├── state.ts        # pure: load/save ~/.pi/agent/mode.json, defaults, validation (node --test friendly)
├── prompt.ts       # HEAVY_INSTRUCTIONS template + fill()
├── planner.ts      # pre-flight fable discovery via subagents backend events
├── index.test.ts   # state/prompt tests, no pi imports needed for state.ts
└── README.md       # usage, keys, verification steps (matches sibling extensions)
```

Sketch (`index.ts`), grounded in the APIs found in `docs/extensions.md`:

```ts
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { loadState, saveState, type Mode, type ModeState } from "./state.ts";
import { buildHeavyPrompt } from "./prompt.ts";
import { probePlanner, type PlannerChoice } from "./planner.ts";

const STATE_FILE = join(getAgentDir(), "mode.json");

export default function modeExtension(pi: ExtensionAPI) {
  let state: ModeState = loadState(STATE_FILE);          // { mode, strict, shortcut? }
  let planner: PlannerChoice = { model: "claude-fable-5-1[1m]", effort: "medium", fallback: false };
  let snapshot: { thinking: ReturnType<typeof pi.getThinkingLevel>; tools: string[] } | undefined;

  pi.registerFlag("mode", { description: "Start in a mode: normal | claude-heavy", type: "string" });

  function renderStatus(ctx: ExtensionContext) {
    const t = ctx.ui.theme;
    if (state.mode === "normal") { ctx.ui.setStatus("mode", t.fg("dim", "• normal")); return; }
    const extra = [planner.fallback ? "plan:opus" : "", state.strict ? "strict" : ""].filter(Boolean);
    const label = `◆ claude-heavy${extra.length ? " · " + extra.join(" · ") : ""}`;
    ctx.ui.setStatus("mode", t.fg(planner.fallback ? "warning" : "accent", label));
  }

  async function setMode(next: Mode, ctx: ExtensionContext) {
    if (next === state.mode) { renderStatus(ctx); return; }
    state = { ...state, mode: next };
    saveState(STATE_FILE, state);                         // global persistence
    pi.appendEntry("mode", { mode: next });               // transcript marker only
    if (next === "claude-heavy") {
      snapshot = { thinking: pi.getThinkingLevel(), tools: pi.getActiveTools() };
      if (state.strict) pi.setActiveTools(snapshot.tools.filter(n => n !== "edit" && n !== "write"));
      renderStatus(ctx);
      planner = await probePlanner(pi, ctx);               // fable present? else opus[1m]/high
    } else if (snapshot) {
      pi.setThinkingLevel(snapshot.thinking);
      pi.setActiveTools(snapshot.tools);
      snapshot = undefined;
    }
    renderStatus(ctx);
    ctx.ui.notify(`Mode: ${next}`, "info");
  }

  pi.registerCommand("mode", {
    description: "Switch between normal and claude-heavy orchestration mode",
    getArgumentCompletions: (prefix) => {
      const items = ["normal", "claude-heavy", "status", "strict on", "strict off"]
        .filter(v => v.startsWith(prefix)).map(v => ({ value: v, label: v }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "status") { ctx.ui.notify(`mode=${state.mode} planner=${planner.model}/${planner.effort} strict=${state.strict} file=${STATE_FILE}`, "info"); return; }
      if (arg.startsWith("strict")) { state = { ...state, strict: arg.endsWith("on") }; saveState(STATE_FILE, state); renderStatus(ctx); return; }
      const next: Mode = arg === "normal" || arg === "claude-heavy" ? arg : (state.mode === "normal" ? "claude-heavy" : "normal");
      await setMode(next, ctx);
    },
  });

  pi.registerShortcut(state.shortcut ?? Key.alt("m"), {
    description: "Toggle normal / claude-heavy mode",
    handler: async (ctx) => setMode(state.mode === "normal" ? "claude-heavy" : "normal", ctx),
  });

  // The whole behaviour change lives here. Runs per prompt; no restart needed.
  pi.on("before_agent_start", async (event) => {
    if (state.mode !== "claude-heavy") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${buildHeavyPrompt(planner)}` };
  });

  // Keep the indicator alive across reload/new/resume/fork and footer re-creation.
  pi.on("session_start", async (_e, ctx) => {
    const flag = pi.getFlag("mode");
    if (flag === "normal" || flag === "claude-heavy") state = { ...state, mode: flag };
    if (state.mode === "claude-heavy") planner = await probePlanner(pi, ctx);
    renderStatus(ctx);
  });
  pi.on("model_select", async (_e, ctx) => renderStatus(ctx));
  pi.on("thinking_level_select", async (_e, ctx) => renderStatus(ctx));

  pi.registerEntryRenderer("mode", (entry, _opts, theme) =>
    new (require("@earendil-works/pi-tui").Text)(theme.fg("dim", `── mode → ${(entry.data as { mode: string }).mode} ──`)));
}
```

`planner.ts` sketch (uses the backend contract the user already ships):

```ts
import { BACKEND_DISCOVER_EVENT, BACKEND_REGISTER_EVENT, type BackendRegistration } from "../subagents/contracts.ts";

export async function probePlanner(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PlannerChoice> {
  const primary = { model: "claude-fable-5-1[1m]", effort: "medium", fallback: false };
  const fallback = { model: "opus[1m]", effort: "high", fallback: true };
  let backend: BackendRegistration | undefined;
  const off = pi.events.on(BACKEND_REGISTER_EVENT, (b: BackendRegistration) => { if (b?.id === "claude-code") backend = b; });
  pi.events.emit(BACKEND_DISCOVER_EVENT, { version: 1 });
  off();
  if (!backend?.listModels) return fallback;             // claude-code extension not loaded
  try {
    const models = await backend.listModels(ctx, AbortSignal.timeout(15000));
    return models.some(m => m.id === primary.model) ? primary : fallback;
  } catch { return fallback; }
}
```

Optional `tool_call` guard (v2): on `agent_spawn` with `backend ===
"claude-code"`, rewrite `model` from fable to opus when `planner.fallback` is
true and default `effort` to `"medium"` when absent. `event.input` is
documented as mutable for exactly this.

Interactions with existing extensions:

- `subagents` and `claude-code` are untouched; the mode extension only calls
  their public event contract.
- `command-palette` lists `/mode` automatically.
- `extension-toggle` can disable the mode extension like any other.
- `usage-status` footer keeps rendering the status line.
- `pi-powerline-footer` is disabled in `settings.json`; if re-enabled it would
  need to render extension statuses for the indicator to show.

---

## 6. Fallback and alternative designs

| Alternative | How | Trade-offs |
|---|---|---|
| Prompt template only (`/heavy <task>`) | `~/.pi/agent/prompts/heavy.md` expands the orchestration rules plus `$@` into a user message. | Zero code, works today. No persistence, no indicator, instructions live in one user message rather than the system prompt, must be retyped per task. Good as a stopgap. |
| `preset.ts` from examples | Copy the preset extension; define a `claude-heavy` preset with `instructions`. | Gives `/preset` and `Ctrl+Shift+U` cycling and system-prompt append. Lacks the always-on status, model pre-flight, strict tools, and its instructions are only appended per session, not a global file. Could be the base if the user prefers generic presets. |
| AGENTS.md conditional block | Put the rules in `~/.pi/agent/AGENTS.md` under a heading "only if the user says heavy mode is on". | Cannot be toggled reliably, wastes context in normal mode, no UI. Not recommended. |
| Model-callable `set_mode` tool | `pi.registerTool("set_mode")` so the agent can enter heavy mode when it judges a task large. | Nice add-on later; risky as the primary switch because the model could flip modes without the user noticing. If added, still write the same state file and status. |
| Strict enforcement via `setActiveTools` | Drop `edit`/`write` for the orchestrator. | Strong bias, but `bash` can still edit and some users want quick local touch-ups. Offered as `/mode strict on`, default off. |
| Separate orchestrator model | On entering heavy mode also `pi.setModel()` to a stronger orchestrator. | Simple with `preset.ts` pattern, but the user said the main thread can be any model; keep out of v1. |

---

## 7. Open questions for the user

1. **Strict sub-mode default.** Ship `/mode strict` off by default (advisory
   bias only), or on (edit/write removed from the orchestrator)?
2. **Orchestrator thinking level.** Should entering claude-heavy raise the main
   model's thinking level (for example to `high`) and restore it on exit, or
   leave it alone?
3. **Planner permission policy.** Use `backendOptions.permissionMode: "plan"`
   (Claude's own plan mode) or a read-only tool list for planning workers? The
   former is closer to Claude Code semantics; the latter is more predictable.
4. **Pre-flight probe on every session start.** It spawns a short-lived
   `claude` process (about 1 to 3 s, cached 60 s). Acceptable at startup while
   in heavy mode, or only on explicit switch and `/mode status`?
5. **Ctrl+Tab opt-in.** Do you want the README to document unbinding
   `ctrl+tab` in Ghostty and setting `"shortcut": "ctrl+tab"` in `mode.json`,
   or keep `alt+m` only?
6. **Transcript marker.** Keep the `── mode → … ──` entry in the transcript,
   or notify only?
7. **v2 guard hook.** Add the `tool_call` rewrite (fable→opus, default effort)
   now, or wait to see whether the instructions alone are followed?
