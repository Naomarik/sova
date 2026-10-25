// Run: pnpm exec tsx --test shared/decisions.test.ts. The "owner-area" prepare rule a chat runs itself
// (record_decision's prepareArguments, §app.requirements/owner-area) answers exactly as the server's
// pickOwnerArea does over the same roster, reading the choices from the declaration's own enum.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Person } from "./orgs";
import { OWNER_AREA_NONE, prepareOwnerArea } from "./decisions";
import { ownerAreaChoices, pickOwnerArea } from "../server/decisions";

const person = (id: string, decides: string[], status: Person["status"] = "active") => ({ id, name: id, decides, status }) as unknown as Person;
const schemaOf = (roster: readonly Person[]) => ({ type: "object", properties: { ownerArea: { type: "string", enum: [...ownerAreaChoices(roster), OWNER_AREA_NONE] } } });

const rosters: Record<string, Person[]> = {
  none: [],
  noAreas: [person("a", [])],
  one: [person("a", ["Finance"])],
  many: [person("a", ["Finance", "Hiring Plans"]), person("b", ["finance", "Design"]), person("c", ["Legal"], "left" as Person["status"])],
  accents: [person("a", ["Café Menu"])],
};
const values: unknown[] = [undefined, null, 3, "", "  ", "none", "NONE", " None ", "finance", "FINANCE", " Finance ", "hiring  plans", "Hiring-Plans", "design", "legal", "Marketing", "cafe menu", "Café menu"];

describe("prepareOwnerArea", () => {
  for (const [name, roster] of Object.entries(rosters))
    test(`agrees with pickOwnerArea: ${name}`, () => {
      const schema = schemaOf(roster);
      for (const v of values) {
        const want = pickOwnerArea(roster, v);
        const args = { area: "x", ownerArea: v };
        if (want.ok) assert.deepEqual(prepareOwnerArea(schema, args), { ...args, ownerArea: want.ownerArea }, `value ${String(v)}`);
        else assert.throws(() => prepareOwnerArea(schema, args), (err: Error) => err.message === want.error, `value ${String(v)}`);
      }
    });
  test("arguments that aren't an object pass as they are", () => {
    assert.equal(prepareOwnerArea(schemaOf(rosters.one!), null), null);
    assert.equal(prepareOwnerArea(schemaOf(rosters.one!), "x"), "x");
  });
});
