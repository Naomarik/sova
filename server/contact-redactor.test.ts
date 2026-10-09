// Run: node scripts/run-tests.mjs server/contact-redactor.test.ts. §app.overseer/org-projection: the
// contact redactor over a real roster. A contact value is `[contact]` in whatever case it was typed
// or repeated, its phone's digits too, and a value is a literal, never a pattern; the roster keeps the
// value as it was given. A throwaway PI_CODING_AGENT_DIR and org workspace in the OS temp dir.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-contact-");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });

const orgs = await import("./orgs");
const view = await import("./overseer-org-view");

const EMAIL = "Maria@ExampleHoldings.com";
const PHONE = "+90 555 123 4567";
const org = await orgs.createOrg({ name: "Example Holdings", dir: join(root, "ws") });
const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll", decides: ["invoicing"], contact: { email: EMAIL, phone: PHONE } });

test("a roster email is [contact] in any case it is written; the roster keeps it as given", () => {
  const r = view.contactRedactor();
  for (const typed of [EMAIL, "maria@exampleholdings.com", "MARIA@EXAMPLEHOLDINGS.COM", "maria@ExampleHoldings.COM"]) {
    const out = r.text(`write to ${typed} today`);
    assert.equal(out, "write to [contact] today", typed);
    assert.ok(!out.toLowerCase().includes("exampleholdings"), typed);
  }
  assert.deepEqual(r.deep({ q: ["mail: maria@exampleholdings.com"] }), { q: ["mail: [contact]"] });
  // the roster, its contact values and a write's own arguments are as given
  assert.equal(orgs.readRoster(org.id).find((p) => p.id === maria.id)?.contact?.email, EMAIL);
  assert.ok(view.contactValues().includes(EMAIL));
  assert.deepEqual(view.scrubContactArgs({ contact: { email: EMAIL } }), { contact: "[contact]" });
});

test("a phone stays redacted as written and as its digits; ordinary words are left", () => {
  const r = view.contactRedactor();
  assert.equal(r.text(`call ${PHONE} or 905551234567, not 555 widgets`), "call [contact] or [contact], not 555 widgets");
  assert.equal(r.text("Maria at Example Holdings"), "Maria at Example Holdings");
});

test("a value is a literal, never a pattern; the longest of two overlapping values wins", () => {
  const r = view.contactRedactor(["a.b+c(1)@x.io", "x.io/[q]{2}|$", "Ann.Lee@x.io", "Lee@x.io"]);
  assert.equal(r.text("a.b+c(1)@X.IO aXb+c(1)@x.io aab+c1@x.io"), "[contact] aXb+c(1)@x.io aab+c1@x.io");
  assert.equal(r.text("see X.IO/[Q]{2}|$ now"), "see [contact] now");
  assert.equal(r.text("ann.lee@x.io and lee@X.io"), "[contact] and [contact]");
  assert.equal(view.contactRedactor([]).text("Maria@ExampleHoldings.com"), "Maria@ExampleHoldings.com");
  assert.equal(view.contactRedactor([""]).text("abc"), "abc");
});
