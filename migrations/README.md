# Migrations

Temporary code that keeps something older working after a move, each with the version it goes in.

- `manifest.json` lists every migration: `id`, `what` it keeps working, `since` (the version it began at), `removeIn`
  (the version that drops it) and `paths` (its folder and every file that calls it).
- `<id>/` holds all of that migration's code. Server and playbook code reaches it through one small import per call
  site, so removing a migration is: delete `<id>/`, its manifest entry, and the call sites its `paths` name.
- `server/migrations.test.ts` fails once `package.json`'s version reaches an entry's `removeIn`: clear those out of
  git then (every so often, not per release).
