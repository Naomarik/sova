// Run: pnpm exec tsx --test server/sessions-configure.test.ts
// POST /api/sessions/configure's body checks and refusals (§mesh.links/configure), before any
// runtime opens: a bad field refuses the whole call, and nothing changes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";

const tmp = mkdtempSync(join(tmpdir(), "sova-configure-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
after(() => rmSync(tmp, { recursive: true, force: true }));
const { configureRefusal, parseConfigure } = await import("./sessions-configure");

test("an unknown mode, minor mode or thinking level refuses the whole call", () => {
  assert.ok("error" in parseConfigure({ path: "/x.jsonl", model: "p/m", mode: "nope" }));
  assert.ok("error" in parseConfigure({ path: "/x.jsonl", thinking: "high", minorModes: ["nope"] }));
  assert.ok("error" in parseConfigure({ path: "/x.jsonl", thinking: "extreme" }));
  assert.ok("error" in parseConfigure({ path: "/x.jsonl", model: "no-slash" }));
  assert.ok("error" in parseConfigure({ path: "/x.jsonl" }));
  assert.ok("error" in parseConfigure({ model: "p/m" }));
  const ok = parseConfigure({ path: "/x.jsonl", model: "p/m", thinking: "low", mode: "normal", minorModes: [] });
  assert.ok(!("error" in ok));
  assert.deepEqual(ok.req, { path: "/x.jsonl", model: "p/m", thinking: "low", mode: "normal", minorModes: [] });
  assert.ok(ok.patch);
});

test("refusals: special sessions, TUI-live, archived, mid-turn, subagents working", () => {
  const s = { title: "t", live: null, archived: false } as unknown as SessionSummary;
  assert.equal(configureRefusal(s, false, 0), null);
  assert.match(configureRefusal({ ...s, overseer: true }, false, 0)!, /Overseer/);
  assert.match(configureRefusal({ ...s, projectOverseer: { orgId: "o", projectId: "p" } }, false, 0)!, /project overseer/);
  assert.match(configureRefusal({ ...s, workerSession: true }, false, 0)!, /subagent/);
  assert.match(configureRefusal({ ...s, live: { pid: 3, status: "x" } }, false, 0)!, /terminal/);
  assert.match(configureRefusal({ ...s, archived: true }, false, 0)!, /archived/);
  assert.match(configureRefusal(s, true, 0)!, /running a turn/);
  assert.match(configureRefusal(s, false, 2)!, /subagents are working/);
  // A profile-only switch is allowed while the chat is busy: it reaches later turns and team actions.
  assert.equal(configureRefusal(s, true, 3, true), null, "profile-only: turn and working subagents do not block");
  assert.match(configureRefusal({ ...s, live: { pid: 3, status: "x" } }, true, 3, true)!, /terminal/, "profile-only: a TUI-owned session still refuses");
  assert.match(configureRefusal({ ...s, workerSession: true }, false, 0, true)!, /subagent/);
});
