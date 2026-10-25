// Run: pnpm test -- shared/automations.test.ts
// The automation file (§chat.schedules/automation-file): the strict parse, and what an approval of it
// covers (the v2 pin) against what it doesn't; a header schedule's profile translates to the same pin.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseAutomation, permissionsOfProfile, pin2Source, type Automation } from "./automations";
import { DEFAULT_LIMITS } from "./profiles";

const MERGE = {
  id: "merge-round",
  label: "Merge round",
  when: "merge-ready; every 6h; claude-limit-reset",
  playbook: "merge-round",
  session: "long-running",
  settings: { model: "zai/glm-5.3", thinking: "high", minorModes: ["memory"], memory: { type: "uniichat" } },
  permissions: { remove: ["web"], grant: ["sessions.read", "sessions.message"], oneAtATime: true, limits: { targetsPerRun: 10, perDay: 80 }, overseerMayStart: false },
};
const ok = (raw: unknown, id = "merge-round"): Automation => {
  const a = parseAutomation(raw, id);
  if ("error" in a) throw new Error(a.error);
  return a;
};
const err = (raw: unknown, id = "merge-round"): string => {
  const a = parseAutomation(raw, id);
  assert.ok("error" in a, "expected an error");
  return a.error;
};

describe("the parse is all or nothing", () => {
  test("the Merge round's file reads whole, limits filled from the defaults", () => {
    const a = ok(MERGE);
    assert.deepEqual(a.triggers.map((t) => t.src), ["merge-ready", "every 6h", "claude-limit-reset"]);
    // As a profile reads it (normalizeCaps): removing web takes the workers too.
    assert.deepEqual(a.permissions, { remove: ["workers", "web"], grant: ["sessions.read", "sessions.message"], oneAtATime: true, limits: { ...DEFAULT_LIMITS, targetsPerRun: 10, perDay: 80 }, overseerMayStart: false });
    assert.deepEqual(a.settings, { model: "zai/glm-5.3", thinking: "high", minorModes: ["memory"], memory: { type: "uniichat", size: 128 } });
  });
  test("every wrong key, type and value is its own error sentence", () => {
    assert.match(err({ ...MERGE, profile: "merge-captain" }), /unknown key "profile"/);
    assert.match(err({ ...MERGE, id: "other" }), /"id" must be "merge-round"/);
    assert.match(err(MERGE, "Merge Round"), /file name is its id/);
    assert.match(err({ ...MERGE, session: "one-shot" }), /"session" must be "long-running"/);
    assert.match(err({ ...MERGE, when: "every 10m" }), /every takes 30m/);
    assert.match(err({ ...MERGE, tz: "Mars/Olympus" }), /not a time zone/);
    assert.match(err({ ...MERGE, playbook: "../x" }), /"playbook" must be a playbook's id/);
    assert.match(err({ ...MERGE, settings: { ...MERGE.settings, effort: "high" } }), /"settings" has an unknown key "effort"/);
    assert.match(err({ ...MERGE, settings: { thinking: "hot" } }), /"settings.thinking"/);
    assert.match(err({ ...MERGE, settings: { model: "glm" } }), /"settings.model" must be a model ref/);
    assert.match(err({ ...MERGE, settings: { memory: { type: "huge" } } }), /"settings.memory"/);
    assert.match(err({ ...MERGE, permissions: { ...MERGE.permissions, grant: ["sessions.write"] } }), /"permissions.grant"/);
    assert.match(err({ ...MERGE, permissions: { ...MERGE.permissions, limits: { perDay: 0 } } }), /"permissions.limits.perDay"/);
    assert.match(err({ ...MERGE, permissions: { singleton: true } }), /"permissions" has an unknown key "singleton"/);
    assert.match(err([]), /JSON object/);
  });
});

describe("what an approval covers (§chat.schedules/approval)", () => {
  const pin = (raw: unknown) => pin2Source(ok(raw));
  const base = pin(MERGE);
  test("triggers, zone, playbook and every permission change it", () => {
    for (const changed of [
      { ...MERGE, when: "merge-ready; every 4h; claude-limit-reset" },
      { ...MERGE, tz: "Europe/Berlin" },
      { ...MERGE, playbook: "other-round" },
      { ...MERGE, permissions: { ...MERGE.permissions, remove: [] } },
      { ...MERGE, permissions: { ...MERGE.permissions, grant: ["sessions.read"] } },
      { ...MERGE, permissions: { ...MERGE.permissions, oneAtATime: false } },
      { ...MERGE, permissions: { ...MERGE.permissions, limits: { targetsPerRun: 11, perDay: 80 } } },
      { ...MERGE, permissions: { ...MERGE.permissions, overseerMayStart: true } },
    ])
      assert.notEqual(pin(changed), base, JSON.stringify(changed));
  });
  test("settings, label, task and spelling don't", () => {
    for (const same of [
      { ...MERGE, settings: { model: "anthropic/claude-opus-5-5" } },
      { ...MERGE, settings: {} },
      { ...MERGE, label: "Landing" },
      { ...MERGE, task: "Land what is ready" },
      { ...MERGE, when: "MERGE-READY;  every 6h ; claude-limit-reset" },
      { ...MERGE, permissions: { ...MERGE.permissions, grant: ["sessions.message", "sessions.read"] } },
    ])
      assert.equal(pin(same), base, JSON.stringify(same));
  });
  test("a One at a time profile with the same powers and limits translates to the same pin; any difference doesn't", () => {
    const a = ok(MERGE);
    const profile = { remove: ["web" as const], grant: ["sessions.read" as const, "sessions.message" as const], singleton: true, limits: { ...DEFAULT_LIMITS, targetsPerRun: 10, perDay: 80 }, overseerMayStart: false };
    const legacy = (p: typeof profile) => pin2Source({ triggers: a.triggers, playbook: "merge-round", session: p.singleton ? "long-running" : "per-fire", permissions: permissionsOfProfile(p) });
    assert.equal(legacy(profile), base);
    assert.notEqual(legacy({ ...profile, singleton: false }), base);
    assert.notEqual(legacy({ ...profile, limits: { ...profile.limits, perDay: 40 } }), base);
  });
});
