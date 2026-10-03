// Run: npx tsx --test server/session-loadout.test.ts (or pnpm test). A throwaway agent dir and
// folder in the OS temp dir; ~/.pi is never read or written.
//
// The `sova-loadout` entry's fold and the loader overrides (§chat.transcript/setup-card-toggles),
// against pi's own DefaultResourceLoader: the overrides must filter what pi lists, including a skill
// path an extension adds after the first load, and keep the unfiltered lists for the card.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { LOADOUT_ENTRY, leavesOut, loadoutOnBranch, loadoutOverrides, normalizeLoadout, type LoadoutState } from "./session-loadout";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-loadout-test-")));
after(() => rmSync(root, { recursive: true, force: true }));

const entry = (data: unknown) => ({ type: "custom", customType: LOADOUT_ENTRY, data });

test("the newest well-formed entry on the branch wins; none means everything on", () => {
  assert.equal(loadoutOnBranch([]), null);
  const older = { v: 1, offContext: ["/a/AGENTS.md"], offSkills: [] };
  const newer = { v: 1, offContext: [], offSkills: ["pdf"] };
  assert.deepEqual(loadoutOnBranch([entry(older), entry(newer)]), newer);
  // A malformed newer entry is not an entry: the one before it stands.
  assert.deepEqual(loadoutOnBranch([entry(older), entry({ v: 2, offContext: [], offSkills: [] })]), older);
  assert.deepEqual(loadoutOnBranch([entry(older), { type: "custom", customType: "sova-profile", data: newer }]), older);
});

test("normalizeLoadout is strict: absolute paths, non-empty names, both lists present", () => {
  assert.equal(normalizeLoadout({ v: 1, offContext: ["rel/AGENTS.md"], offSkills: [] }), null);
  assert.equal(normalizeLoadout({ v: 1, offContext: [], offSkills: [""] }), null);
  assert.equal(normalizeLoadout({ v: 1, offContext: [] }), null);
  assert.equal(normalizeLoadout({ v: 1, offContext: [3], offSkills: [] }), null);
  assert.deepEqual(normalizeLoadout({ v: 1, offContext: ["/x", "/x"], offSkills: ["a"] }), { v: 1, offContext: ["/x"], offSkills: ["a"] });
  assert.equal(leavesOut({ v: 1, offContext: [], offSkills: [] }), false);
});

test("no entry, or one that leaves nothing out, builds no overrides", () => {
  assert.equal(loadoutOverrides({ data: null }), undefined);
  assert.equal(loadoutOverrides({ data: { v: 1, offContext: [], offSkills: [] } }), undefined);
});

/** A skill folder with one SKILL.md. */
function skill(dir: string, name: string): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`);
  return join(d, "SKILL.md");
}

test("pi's loader with the overrides: off files and skills are gone, extension-added ones too, and the base lists keep them", async () => {
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "AGENTS.md"), "global rules\n");
  writeFileSync(join(cwd, "AGENTS.md"), "project rules\n");
  skill(join(agentDir, "skills"), "alpha");
  skill(join(agentDir, "skills"), "beta");
  const extDir = join(root, "ext-skills");
  skill(extDir, "gamma");

  const state: LoadoutState = { data: { v: 1, offContext: [join(agentDir, "AGENTS.md")], offSkills: ["beta", "gamma"] } };
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, ...loadoutOverrides(state) });
  await loader.reload();

  assert.deepEqual(loader.getAgentsFiles().agentsFiles.map((f) => f.path), [join(cwd, "AGENTS.md")]);
  assert.deepEqual(loader.getSkills().skills.map((s) => s.name).sort(), ["alpha"]);
  assert.deepEqual(state.baseContext, [join(agentDir, "AGENTS.md"), join(cwd, "AGENTS.md")]);
  assert.deepEqual(state.baseSkills?.map((s) => s.name).sort(), ["alpha", "beta"]);

  // An extension adds a skill path at session_start: pi runs the override again with the whole set.
  loader.extendResources({ skillPaths: [{ path: extDir, metadata: { source: "test", scope: "temporary", origin: "top-level" } as never }] });
  assert.deepEqual(loader.getSkills().skills.map((s) => s.name).sort(), ["alpha"], "the extension's off skill is filtered too");
  assert.deepEqual(state.baseSkills?.map((s) => s.name).sort(), ["alpha", "beta", "gamma"], "and still listed for the card");
});
