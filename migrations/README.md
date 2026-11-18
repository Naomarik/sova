# Migrations

Temporary code that keeps something older working after a move, each with the version it goes in.

- `manifest.json` lists every migration: `id`, `what` it keeps working, `since` (the version it began at), `removeIn`
  (the version that drops it) and `paths` (its folder and every file that calls it).
- `<id>/` holds all of that migration's code. Server and playbook code reaches it through one small import per call
  site, so removing a migration is: delete `<id>/`, its manifest entry, and the call sites its `paths` name.
- A migration is due once the version being released reaches its `removeIn` (`due.mjs`, the folder's own tool, not a
  migration). Sova's release refuses to go on before it
  is removed: the release playbook's version step runs `sova-release.mjs migrations-due --version X.Y.Z` before anything
  is written, and the `migrations-due` release check refuses the release commit. `server/migrations.test.ts` is the
  backstop: it fails once `package.json`'s version reaches an entry's `removeIn`. Clear them out of git every so often.
