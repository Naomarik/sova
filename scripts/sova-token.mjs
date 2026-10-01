#!/usr/bin/env node
// The token a script presents to a Sova main listener: $SOVA_TOKEN when set, else the server's own
// token file, `<agent dir>/sova/auth-token`, where the agent dir is the one given, else
// $PI_CODING_AGENT_DIR, else ~/.pi/agent. Sent as `x-sova-token: <token>`.
//
//   import { sovaToken, tokenHeaders } from "./sova-token.mjs";
//   fetch(url, { headers: { ...tokenHeaders(), "content-type": "application/json" } });
//
// Run directly, it prints the token (`node scripts/sova-token.mjs [agent dir]`), for shell scripts
// in this repo. Nothing here mints one: a missing file means the server has never started there.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TOKEN_HEADER = "x-sova-token";

/** The token file under an agent dir. */
export const tokenFile = (agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) =>
  join(resolve(agentDir.replace(/^~(?=$|\/)/, homedir())), "sova", "auth-token");

/** The token, or null when there is none: $SOVA_TOKEN (a rig that pinned one), else the file. */
export function sovaToken(agentDir) {
  const env = process.env.SOVA_TOKEN?.trim();
  if (env) return env;
  try {
    return readFileSync(tokenFile(agentDir), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** `{ "x-sova-token": <token> }`, or `{}` when there is none (the server then answers 401). */
export function tokenHeaders(agentDir) {
  const t = sovaToken(agentDir);
  return t ? { [TOKEN_HEADER]: t } : {};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t = sovaToken(process.argv[2]);
  if (!t) {
    console.error(`no Sova token: SOVA_TOKEN is unset and ${tokenFile(process.argv[2])} is missing (start the server once)`);
    process.exit(1);
  }
  console.log(t);
}
