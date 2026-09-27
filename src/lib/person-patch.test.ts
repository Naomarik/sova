// Run: npx tsx --test src/lib/person-patch.test.ts
// The person Edit form's PATCH: only the fields the form changed, so a value written elsewhere
// after the form opened (a wrap-up, another tab) is never written back.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Person, PersonInput } from "../../shared/orgs";
import { changedFields } from "./person-patch";

const tony: Person = {
  id: "p1",
  orgId: "o1",
  name: "Tony R.",
  status: "active",
  contact: { email: "tony@example.com", phone: "+1 555 0100" },
  role: "Bookkeeper",
  decides: ["invoicing", "bank access"],
  skills: ["Excel"],
  competence: {},
  language: "en",
  voice: "Short sentences.",
};

/** What PersonForm submits for `p` untouched, the way it builds it. */
const asForm = (p: Person): PersonInput => ({
  name: p.name,
  status: p.status,
  role: p.role,
  decides: [...p.decides],
  skills: [...p.skills],
  language: p.language,
  voice: p.voice,
  contact: { ...p.contact },
  ...(p.status === "proposed" || p.referral ? { referral: { why: p.referral?.why ?? "", referredBy: p.referral?.referredBy ?? "" } } : {}),
});

test("an untouched form changes nothing", () => {
  assert.deepEqual(changedFields(tony, asForm(tony)), {});
});

test("a role-only edit sends only the role", () => {
  assert.deepEqual(changedFields(tony, { ...asForm(tony), role: "Head of finance" }), { role: "Head of finance" });
});

test("lists compare by value, not by how they were typed", () => {
  assert.deepEqual(changedFields(tony, { ...asForm(tony), decides: ["invoicing", "bank access"] }), {});
  assert.deepEqual(changedFields(tony, { ...asForm(tony), skills: ["Excel", "SQL"] }), { skills: ["Excel", "SQL"] });
});

test("clearing the email sends the whole contact without it", () => {
  assert.deepEqual(changedFields(tony, { ...asForm(tony), contact: { phone: "+1 555 0100" } }), { contact: { phone: "+1 555 0100" } });
  const bare: Person = { ...tony, contact: { email: "tony@example.com" } };
  assert.deepEqual(changedFields(bare, { ...asForm(bare), contact: {} }), { contact: {} });
});

test("a language and voice written elsewhere after the form opened are not written back", () => {
  // The form loaded `tony`; a wrap-up then set language "es-CO" and a new voice. The form only
  // changed the role, so the PATCH must carry the role alone.
  const form = { ...asForm(tony), role: "Controller" };
  const patch = changedFields(tony, form);
  assert.deepEqual(patch, { role: "Controller" });
  assert.equal("language" in patch || "voice" in patch, false);
});

test("a referral compares by its two fields", () => {
  const proposed: Person = { ...tony, status: "proposed", referral: { why: "Knows the books", referredBy: "Maria" } };
  assert.deepEqual(changedFields(proposed, asForm(proposed)), {});
  assert.deepEqual(changedFields(proposed, { ...asForm(proposed), referral: { why: "Runs payroll", referredBy: "Maria" } }), {
    referral: { why: "Runs payroll", referredBy: "Maria" },
  });
});
