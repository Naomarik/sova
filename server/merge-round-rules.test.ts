// The merge round's driver (.sova/playbooks/merge-round/scripts/round.mjs) carries its own copies of
// two readiness rules, since a playbook script imports nothing from Sova. These must stay equal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsRestart, tempCommitOf } from "./merge-readiness";

interface RoundRules {
  needsRestart: (file: string) => boolean;
  tempCommitOf: (subjects: readonly string[]) => string | undefined;
}
// A computed specifier: the driver is plain JS with no types, and must not run as a CLI on import.
const ROUND = new URL("../.sova/playbooks/merge-round/scripts/round.mjs", import.meta.url).href;

test("round.mjs's needsRestart matches merge-readiness over every enumerated path", async () => {
  const round = (await import(ROUND)) as RoundRules;
  const dirs = ["server", "shared", "pi-config", "pi-config/extensions/mode", "src", "src/lib", ".sova/spec", "scripts", "docs", ""];
  const names = ["index.ts", "a.test.ts", "a.test.mjs", "a.test.tsx", "a.test.cjs", "README.md", "notes.MD", "a.tsx", "a.json", "package.json", "pnpm-lock.yaml", "x.mjs"];
  let n = 0;
  for (const d of dirs) for (const f of names) {
    const path = d ? `${d}/${f}` : f;
    assert.equal(round.needsRestart(path), needsRestart(path), path);
    n++;
  }
  for (const odd of ["serverx/a.ts", "server", "Server/a.ts", "pi-config", " package.json", "package.json/x"]) assert.equal(round.needsRestart(odd), needsRestart(odd), odd);
  assert.ok(n > 100);
});

test("round.mjs's tempCommitOf matches merge-readiness over every enumerated subject", async () => {
  const round = (await import(ROUND)) as RoundRules;
  const heads = ["TEMP", "temp", "Temp:", "WIP", "wip:", "WIP-", "fixup!", "squash!", "amend!", "Fixup!", "fixup", "squash", "amend", "temporary", "wipe", "template", "feat:", "", "  WIP"];
  const tails = ["", " x", ": x", "! x", "\tx"];
  for (const h of heads) for (const t of tails) {
    const s = `${h}${t}`;
    assert.equal(round.tempCommitOf([s]), tempCommitOf([s]), JSON.stringify(s));
    assert.equal(round.tempCommitOf(["ok", s, "WIP last"]), tempCommitOf(["ok", s, "WIP last"]), JSON.stringify(s));
  }
  assert.equal(round.tempCommitOf([]), tempCommitOf([]));
});
