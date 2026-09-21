# 12 · Settings dialog
> Part of the pi-web design spec · [overview](overview.md)

The sidebar foot's Agents row ends in a gear. It opens the Settings modal: a left tab rail and
one panel, wider than the product's question-asking modals because two panes have to fit beside
each other (§0 and §7 record the deviation). There is no route and no URL — Settings is a modal
the session stays behind, closed by the scrim, Esc, or its Close button.

The rail is the structure: each settings screen is one tab, and the first release ships two —
Subagent models and Themes.
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

## Themes

The second tab. It lists every theme the app can find — the ones shipped with it and the ones
you dropped in yourself — as a radiogroup: one row per theme, one of them checked, arrow keys
move the choice the way they do in the rail.

A row is the preview. It carries the theme's name, a meta line reading its base and where it
came from (`Dark base · Built-in`, `Light base · User`), a strip of 5 swatches painted in the
theme's own `bg`, `surface`, `accent`, `status-error`, and `ink`, and the sample `Aa 0x1F` set
in the theme's own body and mono faces — `Aa` in one, `0x1F` in the other, because a theme may
change either. Both the swatches and the sample render values out of a file the user may never
have chosen, which is why those values are checked when the file is read rather than when a
theme is applied (§0): by the time a row draws, there is nothing left to sanitize. A user file that took a built-in's id says so — `Dark base · User · replaces
the built-in` — because a Dracula that isn't ours is the one surprise this folder can spring, and
the row is where it should be legible rather than in a log. Every user row carries its file's full
path in `title`. The swatches are the only place in the product that paints a color the current
theme doesn't own; each is a 20px dot with a 1.5px `--color-border-strong` ring, so a swatch the
same color as the panel is still a dot.

**Choosing applies immediately.** There is no Save and no preview mode: the row you check is the
theme the window is wearing before your finger leaves the key, because a theme you have to
commit to is a theme you can't compare. The choice is the id, and it persists in `localStorage`
under `pi-web:theme`, read and applied before first paint (§0) so a reload never flashes the
default first. A stored id that no longer resolves — the file was deleted or renamed — falls back
to `dark`, and the list shows `dark` checked.

**A theme file we can't use stays in the list.** It renders as a disabled row, its filename in
mono where the name would be and its reason where the meta line would be. The row can't be
checked, and it never replaces the theme you're wearing. A theme that vanishes when it breaks is
a theme you can't fix.

Two things go wrong, and they read differently. **A file that doesn't parse** carries the
parser's own message — "Expected double-quoted property name in JSON at position 15 (line 3
column 1)" is what tells you which brace to close. We quote it rather than rewrite it: V8 names a
line for most syntax errors and not for all, so copy of our own would be promising a position the
parser sometimes can't give. **A file that parses but holds a value we won't emit** names the key,
the value, and the shapes that would have worked — "a hex value, or one call to `rgb`, `rgba`,
`hsl`, `hsla`, `oklch`, `oklab`, `lab`, `lch`, `color-mix`, or `color`". A rejection that only
says *invalid* sends you looking for a typo in a value that hasn't got one; the fix is almost
always a spelling we don't take, so the copy names the ones we do (§0).

The footer names the folder — `~/.pi/agent/pi-web/themes/` in mono — and carries a Refresh
action. The list is fetched when the dialog opens and re-fetched every 2s while this tab is
visible, so a file you save in another window appears without a click; Refresh is there for the
moment you don't want to wait 2 seconds, and for the case where the watch is the thing that's
broken. Polling stops when the tab loses focus or the dialog closes.

While the list loads, the panel shows skeleton rows. If the folder can't be read, an error banner
offers Retry and the built-in themes list anyway — the app's own themes don't depend on it.
