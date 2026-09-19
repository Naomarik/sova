# extension-toggle

`/extensions` — toggle pi extensions on/off without leaving the session.

Installed globally through a symlink:

```text
~/.pi/agent/extensions/extension-toggle -> ~/pi-config/extensions/extension-toggle
```

Run `/reload` once after installation (see below for why that matters).

## What it does

Opens a `SettingsList` of every discovered extension with an on/off toggle:

- **Local global** — entries in `~/.pi/agent/extensions/`
- **Project-local** — entries in `<project>/.pi/extensions/` (only when the
  project is trusted)
- **Packages** — every extension file inside each `npm:` / `git:` / local-path
  package from settings (so one repo like `tmustier/pi-extensions` shows each
  of its extensions as its own row)

Toggles write to the relevant `settings.json` immediately, using the same
pattern semantics pi itself applies (`!pat` excludes, `+path` force-includes,
plain patterns are allowlist entries). For packages this means toggling
converts the entry between string form and object form as needed — when no
filters remain it reverts to the clean string form.

On close it offers to run `/reload` so the new set takes effect. Declining
keeps the session as-is; run `/reload` whenever you like.

Files:

- `logic.ts` — pure discovery/pattern/settings code, no pi imports, so it runs
  under plain `node --test`
- `index.ts` — pi wiring: `/extensions` command + SettingsList UI

## Notes

- Disabling `extension-toggle` itself removes `/extensions` until re-enabled
  via `pi config` or by editing `settings.json` (the toggle warns before you
  do it).
- Pattern arrays in `settings.json` are shared with pi: entries you did not
  create through this UI are preserved on every write.
- Package files excluded by the package's own `pi.extensions` manifest
  (`!` globs in the package, not in your settings) are not listed — they are
  not loadable through settings filters.

## Tests

```bash
node --test index.test.ts
```
