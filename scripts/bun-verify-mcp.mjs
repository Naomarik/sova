#!/usr/bin/env node
// Runs chosen pi-config tests that spawn helpers with process.execPath (the team MCP server, the
// Claude spec hooks), under whichever runtime runs this file:
//   VERIFY_TESTS=subagents/member-mcp.test.ts,claude-code/spec-hooks.test.ts node scripts/bun-verify-mcp.mjs
//   VERIFY_TESTS=…  bun test ./scripts/bun-verify-mcp.mjs   (Bun's node:test needs its runner)
// PI_PACKAGE_DIR avoids `npm root -g` through a mise shim (the hermetic HOME hides mise's trust db).
import "../pi-config/extensions/claude-code/tests/hermetic-env.mjs";
import path from "node:path";
import { jiti } from "../pi-config/extensions/subagents/tests/runtime.mjs";
const ext = path.join(import.meta.dirname, "..", "pi-config", "extensions");
for (const f of (process.env.VERIFY_TESTS ?? "subagents/member-mcp.test.ts").split(",")) await jiti.import(path.join(ext, f));
