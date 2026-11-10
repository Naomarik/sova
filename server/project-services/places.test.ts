import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition, type ProjectDef } from "../../shared/project-contract";
import { checkoutPortsAt, slotLayoutOf } from "../../shared/project-slots";
import { countPlaces, placeStates, type PlacesInput } from "./places";
import { pickSlot, type InstanceRecord, type Registry, type SharedRecord } from "./store";

const P = "/w/a";
const def = (services: Record<string, unknown>): ProjectDef => parseDefinition(JSON.stringify({ version: 1, services }));
const WEB = def({ web: { cmd: ["x"], ports: { http: { base: 5000 } } } });

const inst = (x: Partial<InstanceRecord> & Pick<InstanceRecord, "id" | "slot">): InstanceRecord => ({
  project: P,
  checkout: `/co/${x.id}`,
  branch: null,
  generation: 0,
  createdBy: "operator",
  createdAt: "",
  cutWorktree: false,
  desired: { web: "running" },
  prints: {},
  data: {},
  ports: {},
  ...x,
});
const shared = (x: Pick<SharedRecord, "id" | "project" | "ports">): SharedRecord => ({ desired: {}, ...x }) as SharedRecord;
const input = (x: Partial<PlacesInput>): PlacesInput => ({ registry: { instances: [], shared: [] }, project: P, isProject: (p) => p === P, def: WEB, numbering: WEB, listening: new Set(), ...x });
const stateOf = (x: Partial<PlacesInput>, slot: number) => placeStates(input(x)).find((p) => p.slot === slot)?.state;

test("each usable place is exactly one of running, stopped, used elsewhere, free", () => {
  const cases: [string, Partial<PlacesInput>, string][] = [
    ["nothing on it", {}, "free"],
    ["this project's running copy", { registry: { instances: [inst({ id: "c", slot: 3 })], shared: [] } }, "running"],
    ["this project's copy, created, never started", { registry: { instances: [inst({ id: "c", slot: 3, desired: {} })], shared: [] } }, "stopped"],
    ["this project's stopped copy", { registry: { instances: [inst({ id: "c", slot: 3, desired: { web: "stopped" } })], shared: [] } }, "stopped"],
    ["another project's stopped copy on the port", { registry: { instances: [inst({ id: "o", slot: 1, project: "/w/b", desired: { web: "stopped" }, ports: { web: { http: 5003 } } })], shared: [] } }, "elsewhere"],
    ["another project's shared service on the port", { registry: { instances: [], shared: [shared({ id: "s", project: "/w/b", ports: { bus: { p: 5003 } } })] } }, "elsewhere"],
    ["this project's own shared service on the port", { registry: { instances: [], shared: [shared({ id: "s", project: P, ports: { bus: { p: 5003 } } })] } }, "free"],
    ["a listening program", { listening: new Set([5003]) }, "elsewhere"],
    ["same slot of another project, other ports", { registry: { instances: [inst({ id: "o", slot: 3, project: "/w/b", ports: { web: { http: 9003 } } })], shared: [] } }, "free"],
    ["a conformance record sitting on it", { registry: { instances: [inst({ id: "f", slot: 3, createdBy: "conform:x" })], shared: [] } }, "elsewhere"],
    ["no list of listening ports", { listening: null }, "unchecked"],
    ["no list, but another instance holds the port", { listening: null, registry: { instances: [inst({ id: "o", slot: 1, project: "/w/b", ports: { web: { http: 5003 } } })], shared: [] } }, "elsewhere"],
    ["no valid definition: ports unknown", { def: null, numbering: null }, "unchecked"],
  ];
  for (const [name, x, want] of cases) assert.equal(stateOf(x, 3), want, name);
});

test("the record's project is matched by the caller's rule, whatever its spelling", () => {
  assert.equal(stateOf({ isProject: (p) => p.replace(/\/$/, "") === P, registry: { instances: [inst({ id: "c", slot: 3, project: `${P}/` })], shared: [] } }, 3), "running");
});

test("an adopted unit's port is held though nothing listens, with or without the list", () => {
  // A fixed port is left out of the layout, so a slot can still need the adopted unit's port.
  const adopted = { services: [{ name: "web", scope: "checkout", ports: { http: { fixed: 5003 } }, adopt: { unit: "shop.service", ports: { http: 5003 } } }] } as unknown as ProjectDef;
  assert.equal(stateOf({ def: adopted, numbering: adopted }, 3), "elsewhere");
  assert.equal(stateOf({ def: adopted, numbering: adopted, listening: null }, 3), "elsewhere");
});

test("overlapping ports reduce the usable places; a place the numbering rules out is not one, and the slots' ports follow the numbering", () => {
  const two = def({ web: { cmd: ["x"], ports: { http: { base: 3000 } } }, api: { cmd: ["y"], ports: { http: { base: 3010 } } } });
  const places = placeStates(input({ def: two, numbering: two }));
  assert.deepEqual(places.map((p) => p.slot), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(countPlaces(input({ def: two, numbering: two })), { usable: 9, running: 0, stopped: 0, elsewhere: 0, free: 9 });
  const renumbered = def({ web: { cmd: ["x"], ports: { http: { base: 7000 } } } });
  assert.equal(stateOf({ numbering: renumbered, listening: new Set([7003]) }, 3), "elsewhere");
  assert.equal(stateOf({ numbering: renumbered, listening: new Set([5003]) }, 3), "free");
});

test("a record outside the usable slots is on no place", () => {
  assert.deepEqual(countPlaces(input({ registry: { instances: [inst({ id: "stale", slot: 19 }), inst({ id: "main", slot: 0 })], shared: [] } })), { usable: 16, running: 0, stopped: 0, elsewhere: 0, free: 16 });
});

test("free is unknown wherever the places can't all be checked, however they fall: none held, or every one held", () => {
  const all = [...Array(16)].map((_, i) => inst({ id: `c${i + 1}`, slot: i + 1 }));
  for (const instances of [[], all])
    for (const x of [{ listening: null }, { def: null, numbering: null }]) assert.equal(countPlaces(input({ ...x, registry: { instances, shared: [] } })).free, null, `${instances.length} held`);
  assert.equal(countPlaces(input({ registry: { instances: all, shared: [] } })).free, 0, "checked and every place held: none free, known");
});

/** A small seeded generator: the same registries on every run. */
function rng(seed: number) {
  return (n: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed >>> 8) % n;
  };
}

test("rule: the places called free are exactly the slots pickSlot accepts (generated registries)", () => {
  let freeSeen = 0;
  let refusedSeen = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const base = 4000 + r(40) * 5;
    const services: Record<string, unknown> = { web: { cmd: ["x"], ports: { http: { base, ...(r(2) ? { stride: 1 + r(3) } : {}) } } } };
    if (r(2)) services.api = { cmd: ["y"], ports: { http: { base: base + r(30) } } };
    if (!r(4)) services.cache = { cmd: ["z"], ports: { p: { fixed: base + 500 } } };
    if (!r(3)) (services.web as Record<string, unknown>).adopt = { unit: "shop.service", ports: { http: base + r(16) } };
    let d: ProjectDef;
    try {
      d = def(services);
    } catch {
      continue; // the parser refuses this definition: no project has it
    }
    const near = () => base + r(50);
    const ports = () => ({ web: { http: near() } });
    const instances = [...Array(r(8))].map((_, i) => inst({ id: `i${i}`, slot: r(20), project: r(3) ? P : "/w/b", desired: r(2) ? { web: "running" } : { web: "stopped" }, createdBy: r(6) ? "operator" : "conform:x", ports: ports() }));
    const sh = [...Array(r(3))].map((_, i) => shared({ id: `s${i}`, project: r(2) ? P : "/w/b", ports: { bus: { p: near() } } }));
    const table = new Set([...Array(r(6))].map(near));
    const registry: Registry = { version: 1, instances, shared: sh };
    const adopted = new Set(Object.values((d.services.find((s) => s.adopt)?.adopt?.ports ?? {}) as Record<string, number>));
    // The engine's own `listening`: an adopted port is held, then the listeners.
    const listening = (p: number): boolean | string => (adopted.has(p) ? "slot 0's adopted unit" : table.has(p));
    const accepted = slotLayoutOf(d, d).ordinary.filter((slot) => "slot" in pickSlot(registry, P, (s) => checkoutPortsAt(d, d, s), [], listening, slot));
    const free = placeStates(input({ registry, def: d, numbering: d, listening: table })).filter((p) => p.state === "free").map((p) => p.slot);
    assert.deepEqual(free, accepted, `seed ${seed}`);
    freeSeen += free.length;
    refusedSeen += slotLayoutOf(d, d).ordinary.length - free.length;
  }
  assert.ok(freeSeen > 100 && refusedSeen > 100, `the generator reaches both sides (free ${freeSeen}, refused ${refusedSeen})`);
});
