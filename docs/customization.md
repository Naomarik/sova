# Make Sova yours

[← Sova](../README.md)

## Themes and type

Choose a built-in theme in **Settings → Themes**, or save a JSON file in
`~/.pi/agent/sova/themes/`. While the Themes tab is open, the picker refreshes every 2 seconds—no
rebuild or restart.

For example, save this as `desk-lamp.json`:

```json
{
  "$schema": "sova-theme/v1",
  "name": "Desk Lamp",
  "extends": "dark",
  "vars": { "amber": "#ffb454" },
  "colors": {
    "accent": "$amber",
    "accent-hover": "#ffc46e",
    "accent-tint": "#3a2f1c"
  }
}
```

Use `extends: "dark"` or `"light"`; omitted values come from that base. `vars` defines reusable
values, referenced as `"$name"`. See the [built-in themes](../themes/) for examples and
[shared/theme.ts](../shared/theme.ts) for supported color and typography keys.

Optional `typography` values can select font stacks already available on the machine displaying
the app; a theme does not bundle font files. Invalid values appear with an error in the picker
rather than being applied.

A custom theme with the same id as a built-in replaces it. If a theme becomes unreadable, fix or
remove its file and reopen Settings → Themes. For a browser-side reset, clear `sova:theme` from
local storage, then reload.

## Model choices

**Settings → Models** controls which providers and models are enabled, and which may be assigned
to subagents. Disabling a model prevents its use in Sova; it does not silently substitute another
model in an existing chat. Select an enabled model to continue.

The policy is saved in `~/.pi/agent/model-policy.json`. The optional
[model-policy extension](../pi-config/extensions/model-policy/README.md) enforces the same global
restrictions in the terminal. Model favorites are read from the command palette's
`~/.pi/agent/model-favorites.json`.

## Optional extensions

Parallel web sessions, shared prompts, branching, and transcript browsing are Sova features.
Worker teams, terminal presence, and remote tool execution require the corresponding pi extensions.
The Sova installer does **not** activate the bundled configuration.

| Extension | What it adds |
| --- | --- |
| [sessions](../pi-config/extensions/sessions/README.md) | Terminal presence and live worker counts |
| [subagents](../pi-config/extensions/subagents/README.md) | Background workers and coordinated teams, visible with their transcripts |
| [remote](../pi-config/extensions/remote/README.md) | Tool execution on your SSH, AWS SSM, Docker, or Incus targets |
| [usage-status](../pi-config/extensions/usage-status/) | Subscription and spend meters |
| [mode](../pi-config/extensions/mode/README.md) | Per-session modes in the composer |
| [explain](../pi-config/extensions/explain/README.md) | Saved HTML explanations browsable from Sova |
| [topic-outline](../pi-config/extensions/topic-outline/README.md) | Conversation chapters in the outline strip |

Read each extension's setup instructions and dependencies before enabling it. Remote sessions
require your own reachable targets and credentials; configure `~/.pi/agent/targets.json` as
described in the remote guide. Tools run on the target, not through a local filesystem mount.

The [pi-config bundle](../pi-config/README.md) can install the complete setup, but it is **not a
prerequisite for Sova**. Its `install.sh` links configuration and extensions into your agent
directory, replacing existing symlinks and backing up regular files. Review it and back up your
configuration before opting in. For the default Sova installation, the script is at
`~/.local/share/sova/pi-config/install.sh`; do not run it merely to launch the web app.
