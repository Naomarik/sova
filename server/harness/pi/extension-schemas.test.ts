// Run: pnpm test -- server/harness/pi/extension-schemas.test.ts. The team tools' schemas as a Sova chat
// gets them: pi-config's subagents extension imported natively (quirk P26), so with pi-ai's real entry
// and not the view pi's own loader would alias in. That is the one place a schema library's marker shows:
// under pi's loader (pi-config's own suites) pi-ai's StringEnum is a TypeBox schema and nothing leaks.
// The other tools a chat declares are in the loadout snapshot and the modes recordings, which have the
// same check (server/agent-loadouts.test.ts, server/modes/modes-sova.golden.test.ts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Imported by a computed path: pi-config's code is typechecked there, not by the server's tsc.
const MEMBER: string = new URL("../../../pi-config/extensions/subagents/member.ts", import.meta.url).href;
const { registerMemberTools } = (await import(MEMBER)) as { registerMemberTools(pi: unknown, me: unknown): void };

const dir = mkdtempSync(join(tmpdir(), "sova-extension-schemas-"));
after(() => rmSync(dir, { recursive: true, force: true }));

type Tool = { name: string; parameters: { properties?: Record<string, unknown>; required?: string[] } };
function toolsOf(extra: Record<string, unknown>): Tool[] {
  const tools: Tool[] = [];
  registerMemberTools({ registerTool: (t: Tool) => tools.push(t) }, { version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_02", role: "dev", orchestrator: false, dir, ...extra });
  return tools;
}

test("a team member's tools, loaded as a chat loads them, declare plain JSON Schema: no schema library's marker (a \"~…\" key)", () => {
  const optionalEnums: string[] = [];
  for (const extra of [{}, { coordinated: true }, { duty: "coordinator" }, { duty: "monitor" }, { orchestrator: true }]) {
    const tools = toolsOf(extra);
    assert.ok(tools.length > 0, JSON.stringify(extra));
    for (const t of tools) {
      assert.deepEqual(JSON.stringify(t.parameters).match(/"~[A-Za-z]+":/g) ?? [], [], `${t.name} (${JSON.stringify(extra)})`);
      for (const [name, schema] of Object.entries(t.parameters.properties ?? {}))
        if (Array.isArray((schema as { enum?: unknown }).enum) && !(t.parameters.required ?? []).includes(name)) optionalEnums.push(`${t.name}.${name}`);
    }
  }
  // The control: the parameters that leaked on pi 1.5 before the wrap are among what was checked.
  for (const p of ["team_msg.notice", "team_inbox.action"]) assert.ok(optionalEnums.includes(p), `${p} is an optional string enum (found: ${[...new Set(optionalEnums)].join(", ")})`);
});
