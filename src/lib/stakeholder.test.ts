// Run: npx tsx --test src/lib/stakeholder.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Person } from "../../shared/orgs";
import { stakeholderView } from "./stakeholder";

const person = (id: string, name: string, status: Person["status"] = "active") => ({ id, name, status }) as Person;
const ana = person("p_a", "Ana");
const bo = person("p_b", "Bo");
const cy = person("p_c", "Cy", "left");

test("the stakeholder in force is an active person on the roster", () => {
  assert.equal(stakeholderView({ stakeholder: "p_b" }, [ana, bo]).current?.name, "Bo");
  assert.equal(stakeholderView({ stakeholder: "p_c" }, [ana, cy]).current, null);
  assert.equal(stakeholderView({ stakeholder: "p_gone" }, [ana, bo]).current, null);
  assert.equal(stakeholderView({}, [ana]).current, null);
});

test("options: active people by name", () => {
  assert.deepEqual(stakeholderView({}, [bo, cy, ana]).options.map((p) => p.id), ["p_a", "p_b"]);
});

test("the suggestion: none set and exactly one active person", () => {
  assert.equal(stakeholderView({}, [ana, cy]).suggestion?.id, "p_a");
  assert.equal(stakeholderView({ stakeholder: null }, [ana]).suggestion?.id, "p_a");
  assert.equal(stakeholderView({}, [ana, bo]).suggestion, null);
  assert.equal(stakeholderView({ stakeholder: "p_a" }, [ana]).suggestion, null);
  assert.equal(stakeholderView({}, [cy]).suggestion, null);
});

test("cleared: said until a stakeholder is in force again", () => {
  const c = { personId: "p_c", name: "Cy", at: "2026-09-27T10:00:00Z" };
  assert.deepEqual(stakeholderView({ stakeholder: null, stakeholderCleared: c }, [ana, bo]).cleared, { name: "Cy", at: c.at });
  assert.equal(stakeholderView({ stakeholder: "p_a", stakeholderCleared: c }, [ana]).cleared, null);
});

test("latest change: the operator's, or who left", () => {
  assert.equal(stakeholderView({}, [ana]).latest, null);
  const h = [
    { at: "2026-09-26T10:00:00Z", from: null, to: "p_c", why: "operator" as const },
    { at: "2026-09-27T10:00:00Z", from: "p_c", to: null, why: "left" as const },
  ];
  assert.deepEqual(stakeholderView({ stakeholderHistory: h }, [ana, cy]).latest, { why: "left", at: "2026-09-27T10:00:00Z", name: "Cy" });
  assert.deepEqual(stakeholderView({ stakeholderHistory: h.slice(0, 1) }, [ana, cy]).latest, { why: "operator", at: "2026-09-26T10:00:00Z" });
});

test("the latest change set via the Overseer says so (§app.overseer/org-attribution)", () => {
  const v = stakeholderView({ stakeholder: "p_a", stakeholderHistory: [{ at: "2026-09-28T10:00:00Z", from: null, to: "p_a", why: "operator", via: "overseer" }] }, [ana]);
  assert.deepEqual(v.latest, { why: "operator", at: "2026-09-28T10:00:00Z", via: "overseer" });
});
