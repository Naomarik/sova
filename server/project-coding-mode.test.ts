// Run: pnpm exec tsx --test server/project-coding-mode.test.ts. A coding session's mode (§app.project-overseer/coding-mode):
// no project setting, this computer's default when unnamed, any mode an Overseer names, unknown names refused; and the
// promotion commit's message. Files in a throwaway dir (PI_CODING_AGENT_DIR too). No model, no git.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-po-mode-"));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));
const { checkedCodingModeChoice, codingModeChoice, codingModeSwitch, describeCodingMode, hostDefaultMode, profileName } = await import("./project-coding-mode");
const store = await import("./project-overseer-store");
const { promotionMessage } = await import("./reconcile");
const sp = await import("../pi-config/extensions/subagents/subagent-profiles.ts");
// This computer's subagent library: two profiles, "house" the default.
sp.writeSubagentProfiles(agentDir, { version: 1, profiles: [sp.legacyProfile(agentDir, "house", "House"), sp.legacyProfile(agentDir, "big", "Big team")] });
sp.writeProfilesDefault(agentDir, { version: 1, default: "house" });
const writeDefault = (mode: string, minorModes: string[]) => writeFileSync(join(agentDir, "mode.json"), JSON.stringify({ version: 1, mode, minorModes, strict: false }));

test("unnamed: this computer's default (mode.json), read each time", () => {
  writeDefault("delegate", ["align", "spec"]);
  assert.deepEqual(hostDefaultMode(), { mode: "delegate", minorModes: ["align", "spec"] });
  assert.deepEqual(codingModeChoice({}, hostDefaultMode()), { mode: { mode: "delegate", minorModes: ["align", "spec"] } }, "nothing named: the default whole, no profile picked");
  writeDefault("normal", ["vis"]);
  assert.deepEqual(hostDefaultMode(), { mode: "normal", minorModes: ["vis"] }, "a later change of the default reaches the next start");
});

test("a stored codingMode is ignored and dropped at the next write; a patch naming one is refused", () => {
  const p = store.projectOverseerPaths("prj_bbbbbbbb", join(tmp, "ws"));
  mkdirSync(join(tmp, "ws", "projects", "prj_bbbbbbbb", "overseer"), { recursive: true });
  writeFileSync(p.settings, JSON.stringify({ version: 1, autonomy: "L2", codingMode: { mode: "delegate", minorModes: ["spec"] } }));
  assert.equal("codingMode" in store.readPoSettings(p), false);
  assert.throws(() => store.patchPoSettings(p, { codingMode: { mode: "delegate", minorModes: [] } } as never), /^Error: Projects have no coding mode: coding sessions start in this computer's default mode. Save as default in a chat's mode menu changes it.$/);
  assert.throws(() => store.patchPoSettings(p, { codingMode: null } as never), /Projects have no coding mode/);
  store.patchPoSettings(p, { autonomy: "L1" });
  const raw = JSON.parse(readFileSync(p.settings, "utf8")) as Record<string, unknown>;
  assert.equal(raw.autonomy, "L1");
  assert.equal("codingMode" in raw, false, "dropped at the file's next write");
});

test("every mode and minor-mode combination is accepted; no ceiling", () => {
  const base = { mode: "normal" as const, minorModes: ["spec"] };
  const minors = ["align", "spec", "vis", "codemode"];
  for (const mode of ["normal", "delegate"] as const)
    for (let bits = 0; bits < 16; bits++) {
      const on = minors.filter((_, i) => bits & (1 << i));
      const r = codingModeChoice({ mode, minor_modes: on }, base);
      assert.ok("mode" in r, `${mode} + [${on}] is accepted`);
      assert.equal(r.mode.mode, mode);
      assert.deepEqual([...r.mode.minorModes].sort(), [...on].sort());
      const sw = codingModeSwitch({ mode, minor_modes: on });
      assert.ok("mode" in sw && sw.mode?.mode === mode, `a running session can be switched to ${mode} + [${on}]`);
    }
  assert.deepEqual(codingModeChoice({ minor_modes: [] }, base), { mode: { mode: "normal", minorModes: [] } }, "spec may be turned off");
  assert.deepEqual(codingModeChoice({ mode: "delegate" }, base), { mode: { mode: "delegate", minorModes: ["spec"] } }, "omitted minors keep the default's");
});

test("only unknown names are refused, each with its sentence", () => {
  const base = { mode: "normal" as const, minorModes: [] };
  assert.equal((codingModeChoice({ mode: "turbo" }, base) as { error: string }).error, "Unknown mode turbo: use normal or delegate.");
  assert.equal((codingModeChoice({ minor_modes: ["bogus", "align"] }, base) as { error: string }).error, "Unknown minor mode bogus: use align, spec, vis or codemode.");
  assert.match((codingModeChoice({ minor_modes: "spec" }, base) as { error: string }).error, /minor_modes must be a list/);
  assert.equal((codingModeSwitch({ mode: "turbo" }) as { error: string }).error, "Unknown mode turbo: use normal or delegate.");
  assert.deepEqual(codingModeSwitch({}), { mode: null }, "naming nothing switches nothing");
});

test("memory is never a coding session's: refused when named, dropped from the default", () => {
  const base = { mode: "normal" as const, minorModes: [] };
  const refusal = "Memory is for chats only: the user turns it on from a chat's mode menu, never in a coding session.";
  assert.equal((codingModeChoice({ minor_modes: ["spec", "memory"] }, base) as { error: string }).error, refusal);
  assert.equal((codingModeSwitch({ minor_modes: ["memory"] }) as { error: string }).error, refusal);
  writeDefault("normal", ["spec", "memory"]);
  assert.deepEqual(hostDefaultMode(), { mode: "normal", minorModes: ["spec"] }, "a default with memory starts coding sessions without it");
});

test("subagent_profile: any profile here or off; an unknown one refused with where to look", () => {
  writeDefault("normal", []);
  assert.deepEqual(checkedCodingModeChoice({ subagent_profile: "big" }), { mode: { mode: "normal", minorModes: [], subagentProfile: "big" } });
  assert.deepEqual(checkedCodingModeChoice({ subagent_profile: "off" }), { mode: { mode: "normal", minorModes: [], subagentProfile: "off" } });
  assert.equal((checkedCodingModeChoice({ subagent_profile: "nope" }) as { error: string }).error, "Unknown subagent profile: nope. sova_list_subagent_profiles lists them.");
  assert.deepEqual(codingModeSwitch({ subagent_profile: "big" }), { mode: { subagentProfile: "big" } }, "a profile alone leaves the mode as it is");
  const info = { profiles: [{ id: "off", name: "Off" }, { id: "big", name: "Big team" }], current: { id: "house", name: "House" } } as never;
  assert.equal(profileName(info), "House", "unnamed: the default's name");
  assert.equal(profileName(info, "big"), "Big team");
});

test("mode words say vis as visuals", () => {
  assert.equal(describeCodingMode({ mode: "delegate", minorModes: ["align", "spec", "vis", "codemode"] }), "delegate · align · spec · visuals · codemode");
});

test("the promotion commit's message names every promoted decision: area — statement, each ≤ 72, at most 10", () => {
  assert.equal(
    promotionMessage([
      { statement: "Exports run on Fridays.", area: "Payroll export" },
      { statement: "Over $5,000 needs a\nsecond approver.", area: "Approvals" },
    ]),
    "Promote 2 decisions: payroll export — Exports run on Fridays; approvals — Over $5,000 needs a second approver.",
  );
  const many = promotionMessage(Array.from({ length: 13 }, (_, i) => ({ statement: `Rule ${i} ${"x".repeat(100)}`, area: "Area" })));
  assert.match(many, /^Promote 13 decisions: /);
  assert.match(many, / and 3 more\.$/);
  const items = many.replace(/^Promote 13 decisions: /, "").replace(/ and 3 more\.$/, "").split("; ");
  assert.equal(items.length, 10);
  assert.ok(items.every((x) => x.length <= 72));
  // A cut last item ends the line with its ellipsis, not "…."
  assert.match(promotionMessage([{ statement: "y".repeat(100), area: "Login" }]), /y…$/);
});

test("a verb playbook's run gets align beside its base (this computer's default); no other kind does (§app.project-runtime/verb-playbooks)", async () => {
  const { playbookRunMode, PLAYBOOK_RUN_KINDS } = await import("./project-coding-mode");
  assert.deepEqual(playbookRunMode({ mode: "normal", minorModes: [] }), { mode: "normal", minorModes: ["align"] });
  const withSpec = playbookRunMode({ mode: "delegate", minorModes: ["spec"] });
  assert.equal(withSpec.mode, "delegate");
  assert.deepEqual([...withSpec.minorModes].sort(), ["align", "spec"]);
  assert.deepEqual(playbookRunMode({ mode: "normal", minorModes: ["align"] }).minorModes, ["align"], "never twice");
  assert.deepEqual([...PLAYBOOK_RUN_KINDS], ["onboard", "deploy-setup"]);
  assert.ok(!PLAYBOOK_RUN_KINDS.includes("coding") && !PLAYBOOK_RUN_KINDS.includes("operator-coding"));
});
