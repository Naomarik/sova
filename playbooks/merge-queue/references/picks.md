# Picks: checks by blast radius

The project declares its required checks (they always run) and, apart from them, optional checks the thread may add (checks marked `"optional": true` in `.sova/project.json`'s merge section; a pick of a required check makes it run even where it would skip itself, and shows your reason). You add the optional checks a branch's change can reach, each with one line saying why. You never remove or replace a required check.

## How
1. `node scripts/blast-radius.mjs --base <target> --tip <commit> --repo <project root>` prints `{picks: [{id, why, select?}]}` from the project's map (`.sova/playbooks/merge-queue/references/blast-radius.json`). No map: no picks; go on from the diff alone.
2. Read the diff against each pick:
   - keep a pick the change can really reach;
   - drop one the map matched on a path the change only touches trivially (a comment, a rename of a test fixture the check doesn't read) and say so in no note;
   - add one the map missed, when the change reaches a check's area through a path the map doesn't list (a shared helper the composer imports, say). Its `why` names the path and the reach.
3. `merge.extend {entry, checks: [id], why, select?}` for each pick (one call per reason; picks sharing a reason may share a call). `select` narrows a check to files, groups or tours where the check takes them (the map's `select`).

## Timing
Picks count only when they reach Sova before the entry's run starts its checks; after that `merge.extend` answers `busy` and the run goes on with the required checks and their triggers alone. That is by design: never ask Sova to wait.

## The reason line
Plain, short, specific: "statecharts/src/org.cljs changed: compile them and run their tests". The run page shows it beside the check as "picked by merge thread".
