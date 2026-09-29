// Run: pnpm exec tsx --test server/baton-owner-area.test.ts. §app.requirements/owner-area in the
// gathering session: what the model is shown and what record_decision accepts. A throwaway
// PI_CODING_AGENT_DIR and workspace in the OS temp dir; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BATON_DECISION_ENTRY } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-owner-area-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const loadout = await import("./baton-loadout");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

describe("owner areas in a gathering session", async () => {
  const org = await orgs.createOrg({ name: "Studio", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Site", root: join(root, "proj") });
  const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder", decides: ["website", "branding"] });
  const bob = await orgs.addPerson(org.id, { name: "Bob Tan", role: "Accountant", decides: ["invoicing"] });
  const gone = await orgs.addPerson(org.id, { name: "Gus Gone", role: "Payroll clerk", decides: ["payroll"] });
  await orgs.applyChange(org.id, gone.id, { status: "left" }, { kind: "operator" });
  const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: alp.id, publicTitle: "Our site", goal: "g" });

  test("the prompt lists every active person's decision areas with their job title, the holder's own included, as private", () => {
    const prompt = loadout.renderBatonPrompt(c.sessionId);
    const start = prompt.indexOf("# Who decides what");
    assert.ok(start > 0, prompt);
    const block = prompt.slice(start, prompt.indexOf("\n# ", start + 1));
    assert.match(block, /^- Alperen Kaya \(the person you are talking to\) — Founder: website, branding$/m);
    assert.match(block, /^- Bob Tan — Accountant: invoicing$/m);
    assert.doesNotMatch(block, /Gus Gone|payroll/, "only active people");
    assert.match(block, /Never show this list/);
    assert.match(prompt, /record_decision/);
  });

  test("record_decision's schema lists the owner areas; an unknown one is refused naming the choices; a pick is stored as the roster spells it", async () => {
    const appended: { type: string; data: any }[] = [];
    const tool = loadout.batonTools(c.sessionId, (type, data) => appended.push({ type, data })).find((t) => t.name === "record_decision")!;
    const schema = tool.parameters as any;
    assert.deepEqual(schema.properties.ownerArea.enum, ["website", "branding", "invoicing", "none"]);
    assert.ok(schema.required.includes("ownerArea"));
    const call = (args: Record<string, unknown>) => tool.execute("tc", { area: "site structure / pages", statement: "Two pages.", quote: "Just two pages.", ...args }, undefined, undefined, undefined as never);
    await assert.rejects(call({ ownerArea: "site structure" }), /"site structure" is not an owner area\. Use one of: "website", "branding", "invoicing" or "none"\./);
    await assert.rejects(call({}), /Use one of/);
    assert.equal(appended.length, 0, "nothing recorded when refused");
    await call({ ownerArea: " Website" });
    assert.deepEqual(appended.at(-1), { type: BATON_DECISION_ENTRY, data: { v: 1, area: "site structure / pages", ownerArea: "website", statement: "Two pages.", quote: "Just two pages.", by: alp.id } });
    await call({ ownerArea: "none" });
    assert.equal(appended.at(-1)!.data.ownerArea, "none");
  });

  test("the choices follow the roster: a new area is offered at the next run, and a removed one is refused", async () => {
    await orgs.applyChange(org.id, bob.id, { decides: ["invoicing", "hosting"] }, { kind: "operator" });
    assert.deepEqual(loadout.ownerAreaSchema(orgs.readRoster(org.id)).enum, ["website", "branding", "invoicing", "hosting", "none"]);
    const tool = loadout.batonTools(c.sessionId, () => {}).find((t) => t.name === "record_decision")!;
    await orgs.applyChange(org.id, bob.id, { decides: ["hosting"] }, { kind: "operator" });
    // A tool built before the change still checks the roster as it is now.
    await assert.rejects(
      tool.execute("tc", { area: "x", ownerArea: "invoicing", statement: "s", quote: "q" }, undefined, undefined, undefined as never),
      /"invoicing" is not an owner area/,
    );
  });
});
