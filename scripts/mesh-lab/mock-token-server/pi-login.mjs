#!/usr/bin/env node
// A pi "login" for the mesh lab: mint a lineage at the mock token server and store it the way
// pi's /login does (AuthStorage.modify: pi's own lock, re-read, whole-file write). Prints metadata
// only. The lab never holds a real login, so this is the only way an oauth entry appears there.
//
//   node pi-login.mjs --mock <url> [--provider openai-codex] [--agent-dir <dir>] [--account <id>]
//
// The agent dir defaults to PI_CODING_AGENT_DIR; a real ~/.pi/agent is refused.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mock = arg("mock") ?? process.env.MOCK_TOKEN_URL;
const provider = arg("provider") ?? "openai-codex";
const agentDir = resolve(arg("agent-dir") ?? process.env.PI_CODING_AGENT_DIR ?? "");
if (!mock || !process.env.PI_CODING_AGENT_DIR && !arg("agent-dir")) {
  console.error("usage: pi-login.mjs --mock <url> [--provider p] [--agent-dir dir] (or PI_CODING_AGENT_DIR)");
  process.exit(2);
}
if (agentDir === resolve(join(homedir(), ".pi/agent"))) {
  console.error("refusing the real ~/.pi/agent");
  process.exit(2);
}

const res = await fetch(new URL("/mock/login", mock), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ shape: "pi", ...(arg("account") ? { account: arg("account") } : {}) }),
});
if (!res.ok) {
  console.error(`mock login failed: HTTP ${res.status}`);
  process.exit(1);
}
const { lineage, credential } = await res.json();
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { AuthStorage } = await import(pathToFileURL(join(piEntry, "..", "core", "auth-storage.js")).href);
await AuthStorage.create(join(agentDir, "auth.json")).modify(provider, async () => credential);
console.log(
  JSON.stringify({
    provider,
    lineage,
    expires: credential.expires,
    refreshSha256: createHash("sha256").update(credential.refresh).digest("hex"),
  }),
);
