// What a transport carries of the project besides its code (§app.transport/arrival, §app.transport/agent): its Sova
// settings for a device where it isn't registered, never a device-only thing, and the host values its definition
// declares, asked of you there prefilled with this device's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CarryDeps, carriedSettingsOf, hostAsksOf, hostCarry, parseCarried, parseHostCarry, pickHostValues, registerArrived } from "./project-carry";

const SHA = "b".repeat(64);

/** A device with projects (by root), their overseer settings and decisions, and what registering and writing did. */
function device(projects: { id: string; name: string; root: string }[], stores: { overseer?: Record<string, Record<string, unknown>>; approvals?: Record<string, { context: Record<string, unknown>; skills: Record<string, unknown> }> } = {}) {
  const wrote: { overseer: [string, unknown][]; approvals: [string, unknown][]; registered: [string, string | undefined][] } = { overseer: [], approvals: [], registered: [] };
  const deps: CarryDeps = {
    projects: () => projects,
    canonical: (p) => p.replace(/\/+$/, ""),
    readOverseer: (id) => stores.overseer?.[id] ?? null,
    readApprovals: (id) => stores.approvals?.[id] ?? null,
    register: async (root, name) => {
      wrote.registered.push([root, name]);
      projects.push({ id: "prj_new00001", name: name ?? "x", root });
      return "prj_new00001";
    },
    writeOverseer: (id, s) => void wrote.overseer.push([id, s]),
    writeApprovals: (id, d) => void wrote.approvals.push([id, d]),
  };
  return { deps, wrote };
}

test("arrival registers a project this device lacks with the carried settings, and leaves an existing registration's settings untouched", async () => {
  const source = device([{ id: "prj_src00001", name: "Motors", root: "/home/u/webapps/motors" }], {
    overseer: { prj_src00001: { version: 1, watch: false, model: "zai/glm-5.3" } },
    approvals: { prj_src00001: { context: { "AGENTS.md": { state: "approved", sha256: SHA } }, skills: { "skills/x/SKILL.md": { state: "disallowed", name: "x" } } } },
  });
  const carried = carriedSettingsOf("/home/u/webapps/motors/", source.deps);
  assert.ok(carried);
  // It travels as JSON in the offer, and is taken back through its parser.
  const taken = parseCarried(JSON.parse(JSON.stringify(carried)));
  const there = device([]);
  assert.deepEqual(await registerArrived("/home/v/webapps/motors", taken, there.deps), { registered: "prj_new00001" });
  assert.deepEqual(there.wrote.registered, [["/home/v/webapps/motors", "Motors"]]);
  assert.deepEqual(there.wrote.overseer, [["prj_new00001", { version: 1, watch: false, model: "zai/glm-5.3" }]]);
  assert.deepEqual(there.wrote.approvals, [["prj_new00001", { context: { "AGENTS.md": { state: "approved", sha256: SHA } }, skills: { "skills/x/SKILL.md": { state: "disallowed", name: "x" } } }]]);
  // A second arrival of it, or a device that already has it: nothing of its settings is written.
  const has = device([{ id: "prj_mine0001", name: "My motors", root: "/home/v/webapps/motors" }]);
  assert.deepEqual(await registerArrived("/home/v/webapps/motors/", taken, has.deps), { already: "prj_mine0001" });
  assert.deepEqual(has.wrote, { overseer: [], approvals: [], registered: [] });
  // A registration refused there (a reserved folder) changes nothing and says why.
  const refusing = device([]);
  refusing.deps.register = async () => Promise.reject(new Error("Sova's own state can't be a project."));
  assert.deepEqual(await registerArrived("/home/v/.pi/agent/x", taken, refusing.deps), { error: "Sova's own state can't be a project." });
  assert.deepEqual(refusing.wrote.overseer, []);
});

test("device-only things never travel: only the name, the overseer's settings and project-relative decisions; nothing for a folder that isn't a project", () => {
  const source = device([{ id: "prj_src00001", name: "Motors", root: "/r" }], {
    overseer: { prj_src00001: { version: 1, watch: true } },
    // An absolute item names a file of this device only.
    approvals: { prj_src00001: { context: { "/home/u/.pi/agent/AGENTS.md": { state: "approved", sha256: SHA }, "../up.md": { state: "approved" } }, skills: {} } },
  });
  const carried = carriedSettingsOf("/r", source.deps)!;
  assert.deepEqual(Object.keys(carried).sort(), ["name", "overseer", "v"]);
  assert.equal(carriedSettingsOf("/not-a-project", source.deps), null);
  // Whatever else an offer says is dropped on the way in: copy limit, host values, running copies, queue and landing.
  const smuggled = parseCarried({ v: 1, name: "M", copies: 8, host: { DB_URL: "x" }, instances: [{ id: "i" }], mergeQueue: { runs: [] }, landing: {}, overseer: { version: 1 } });
  assert.deepEqual(smuggled, { v: 1, name: "M", overseer: { version: 1 } });
  assert.equal(parseCarried({ v: 2 }), null);
});

test("host values: only the declared names travel, the card asks each one that device lacks prefilled with this device's, and Save takes only those", () => {
  const carry = hostCarry(["DB_URL", "PORT_BASE", "bad name"], { DB_URL: "postgres://laptop/motors", OTHER_SECRET: "never", PORT_BASE: "5400" });
  assert.deepEqual(carry, { names: ["DB_URL", "PORT_BASE"], values: { DB_URL: "postgres://laptop/motors", PORT_BASE: "5400" } });
  assert.ok(!JSON.stringify(carry).includes("never"), "another name's value never travels");
  assert.equal(hostCarry([], { DB_URL: "x" }), null);
  const taken = parseHostCarry(JSON.parse(JSON.stringify({ ...carry, values: { ...carry!.values, EXTRA: "x" } })));
  const asks = hostAsksOf(taken, new Set(["PORT_BASE"]));
  assert.deepEqual(asks, [{ name: "DB_URL", value: "postgres://laptop/motors" }]);
  assert.deepEqual(hostAsksOf(hostCarry(["API_KEY"], {}), new Set()), [{ name: "API_KEY", value: "" }], "a value the source lacks too is still asked, empty");
  assert.deepEqual(pickHostValues(asks, { DB_URL: "postgres://desk/motors" }), { DB_URL: "postgres://desk/motors" });
  assert.equal(pickHostValues(asks, { PORT_BASE: "1" }), "PORT_BASE isn't a host value this transport asks for");
  assert.equal(pickHostValues(asks, { DB_URL: "a\nb" }), "DB_URL must be one line of text");
});
