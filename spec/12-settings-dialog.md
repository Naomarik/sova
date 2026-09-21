# 12 · Settings dialog
> Part of the pi-web design spec · [overview](overview.md)

The sidebar foot's Agents row ends in a gear. It opens the Settings modal: a left tab rail and
one panel, wider than the product's question-asking modals because two panes have to fit beside
each other (§0 and §7 record the deviation). There is no route and no URL — Settings is a modal
the session stays behind, closed by the scrim, Esc, or its Close button.

The rail is the structure: each settings screen is one tab, and the first release ships one.
Tabs move with the arrow keys as well as the pointer, and the first tab has focus on open. The
active tab is the only filled thing in the rail — an accent tint, never an accent label, because
§0 spends accent on the primary, live, and focus — and the rail carries no fill of its own, so
that tint has something to read against in both themes. Under 768px the same markup arrives as a
sheet: the panel draws the sheet's grip, the rail turns into a horizontal strip above it, and the
active tab keeps its tint.

## Subagent models

The policy behind this screen is shared: `~/.pi/agent/subagents/settings.json`, written here and
enforced by the subagents extension in **every** session, pi-web and TUI alike. It blocks models
and providers from being picked for subagents and team members — hidden from `agent_models` and
the `/subagents models` picker, and rejected at spawn with a reason the orchestrator can act on,
whether the pick was explicit, agentType-defined, or inherited from the parent's model.

The screen lists one row per provider, its models indented beneath it, and one `claude-code`
row for the Claude Code backend — a provider of its own, with no model rows: its single switch
blocks Claude workers entirely, default model included. Providers are group heads: their name
takes the app's group-label voice (mono, semibold, its own case) with the model count as meta,
and their models nest behind one guide rule — depth is the rule's job, not the indent's, so a
model id keeps its width. Model rows carry the bare id and the full `provider/id` ref in mono
beneath it. Every row is at least 44px, the whole row is the switch's label, and hovering one
fills it with sunken; the switch draws the focus ring, inset so it stays inside the panel.

Every row is a switch, **on meaning allowed**: the default, everything on. A switch saves
immediately — a switch that needed a Save button would be lying about when it takes effect, and
the extension reads the file per spawn, so "immediately" is the truth. Turning a provider off
removes its models' own entries from the file: the provider already covers them, and turning it
back on returns every model allowed, which is what the list showed. A failed save puts the
switch back where it was and says so in an error banner; the server's copy is the truth, never
a local maybe.

While the model list or the policy loads, the panel shows skeleton rows. If the policy can't be
read, an error banner offers Retry and touches nothing.
