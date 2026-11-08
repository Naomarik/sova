// Run: pnpm test -- server/profile-editor-routes.test.ts. The routes Settings → Profiles and the new
// chat's cards call, through Hono, against a throwaway PI_CODING_AGENT_DIR; ~/.pi is never touched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Hono } from "hono";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-profile-routes-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const stateDir = join(agentDir, "sova");
mkdirSync(stateDir, { recursive: true });
const sp = await import("../pi-config/extensions/subagents/subagent-profiles.ts");
sp.writeSubagentProfiles(agentDir, { version: 1, profiles: [sp.legacyProfile(agentDir, "house", "House"), sp.legacyProfile(agentDir, "solo", "Solo")] });
sp.writeProfilesDefault(agentDir, { version: 1, default: "house" });
writeFileSync(join(stateDir, "session-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "claude", label: "Claude", model: "claude-code-cli/claude-opus-5-5", subagents: "house" }] }));
writeFileSync(join(agentDir, "mode.json"), JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));

const { registerProfileRoutes } = await import("./session-profile-routes");
const { registerProfileEditorRoutes } = await import("./profile-editor-routes");
import type { ProfileWriteAnswer } from "../shared/profiles";

const sources = {
  piModels: async () => { throw new Error("offline"); },
  claudeModels: async () => { throw new Error("offline"); },
  policy: () => ({ version: 1 as const, disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }),
};
const app = new Hono();
registerProfileRoutes(app);
registerProfileEditorRoutes(app, sources);
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as ProfileWriteAnswer & { error?: string; field?: string } };
};

describe("the profile routes", () => {
  test("GET /api/profiles carries the joined list and the default, read from the older files before one is chosen", async () => {
    const { status, body } = await call("GET", "/api/profiles");
    assert.equal(status, 200);
    assert.deepEqual(body.joined?.map((r) => [r.key, r.kind]), [["sova:default", "off"], ["user:claude", "pair"], ["library:solo", "library"]]);
    assert.deepEqual(body.defaultProfile, { key: "user:claude", id: "claude", name: "Claude", chosen: false });
    assert.equal(body.joined?.find((r) => r.isDefault)?.key, "user:claude");
    assert.ok(body.template && !("id" in body.template));
  });

  test("POST /api/profiles/mine adds a pair and answers its key; a name refusal names the field", async () => {
    const made = await call("POST", "/api/profiles/mine", { name: "Night" });
    assert.equal(made.status, 200, made.body.error);
    assert.equal(made.body.savedKey, "user:night");
    assert.equal(made.body.joined?.find((r) => r.key === "user:night")?.kind, "pair");
    const dup = await call("POST", "/api/profiles/mine", { name: "night" });
    assert.deepEqual([dup.status, dup.body.error, dup.body.field], [400, "Another profile has this name.", "name"]);
  });

  test("PUT /api/profiles/default makes it the default and writes default-profile.json; deleting it is refused", async () => {
    const r = await call("PUT", "/api/profiles/default", { key: "library:solo" });
    assert.equal(r.status, 200, r.body.error);
    assert.deepEqual(r.body.defaultProfile, { key: "library:solo", id: "solo", name: "Solo", chosen: true });
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "default-profile.json"), "utf8")), { version: 1, profile: "solo" });
    assert.equal(JSON.parse(readFileSync(join(agentDir, "subagent-profiles-default.json"), "utf8")).default, "solo");
    const del = await call("POST", "/api/profiles/mine/delete", { key: "library:solo" });
    assert.deepEqual([del.status, del.body.error], [409, "Make another profile the default first."]);
    const off = await call("PUT", "/api/profiles/default", { key: "off" });
    assert.equal(off.body.defaultProfile?.key, "sova:default");
    assert.equal((await call("POST", "/api/profiles/mine/delete", { key: "library:solo" })).status, 200);
  });

  test("Duplicate answers the copy's key", async () => {
    const r = await call("POST", "/api/profiles/mine/duplicate", { key: "user:claude" });
    assert.equal(r.body.savedKey, "user:claude-copy");
    assert.equal(r.body.joined?.find((x) => x.key === "user:claude-copy")?.libraryId, "claude-copy");
  });
});
