# Migrations

Temporary code that keeps something older working after a move, grouped under the major release that clears it.

- `manifest.json` lists every migration: `id`, `what` it keeps working, `since` (the version it began at), `clearedIn`
  (the major release it is cleared before: `x.0.0`, from `1.0.0` on; there is no 0.x major) and `paths` (its folder and
  every file that calls it).
- `<id>/` holds all of that migration's code. Server and playbook code reaches it through one small import per call
  site, so removing a migration is: delete `<id>/`, its manifest entry, and the call sites its `paths` name.
- A migration has no removal date, and nothing (no release step, release check or test) stops a release over one. The
  migrations grouped under a major release are cleared in a branch that lands before it. `server/migrations.test.ts`
  checks only the shape: each entry whole, its `clearedIn` a major release after its `since`, its folder and paths
  there, and every file that imports it among its paths.
