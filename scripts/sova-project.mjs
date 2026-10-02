#!/usr/bin/env node
// sova-project: the project verbs from a terminal or a hook (§app.project-services/callers).
// A thin client of POST /api/project-services/<verb>: it prints the verb's JSON result on stdout
// and exits with its class (0 done, 1 failed part-way, 2 refused, 3 invalid, 4 busy). It acts as
// the operator. Node builtins, and the exit classes from shared/project-contract.ts (Node strips its types).
//
//   node scripts/sova-project.mjs <verb> [--project <path>] [--instance <id>] [--checkout <path>]
//     [--branch <name>] [--from <ref>] [--slot <n>] [--services a,b] [--restart] [--lines <n>]
//     [--keep-data] [--resources a,b] [--ref <ref>] [--confirm] [--url <http://127.0.0.1:4800>]
//   node scripts/sova-project.mjs approve --project <path> --def-hash <sha256:…> [--checkout <path>]
//
// The server is --url, else $SOVA_URL, else http://127.0.0.1:$SOVA_PORT (default 4800). Its token
// is $SOVA_TOKEN, else the one in $PI_CODING_AGENT_DIR (default ~/.pi/agent) (scripts/sova-token.mjs).

import { resolve } from "node:path";
import { exitOf } from "../shared/project-contract.ts";
import { tokenHeaders } from "./sova-token.mjs";

const VALUE = new Set(["project", "instance", "checkout", "branch", "from", "slot", "services", "lines", "resources", "ref", "url", "def-hash"]);
const FLAG = new Set(["restart", "keep-data", "confirm"]);
const PATHS = new Set(["project", "checkout"]);

function usage(msg) {
  if (msg) console.error(`sova-project: ${msg}`);
  console.error("usage: sova-project <verb> [--project <path>] [--instance <id>] … (see the header of scripts/sova-project.mjs)");
  process.exit(3);
}

const [verb, ...rest] = process.argv.slice(2);
if (!verb || verb.startsWith("-")) usage("name a verb");
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) usage(`unexpected argument ${a}`);
  const key = a.slice(2);
  if (FLAG.has(key)) opts[key] = true;
  else if (VALUE.has(key)) {
    const v = rest[++i];
    if (v === undefined) usage(`--${key} needs a value`);
    opts[key] = PATHS.has(key) ? resolve(v) : v;
  } else usage(`unknown option --${key}`);
}

const base = (opts.url ?? process.env.SOVA_URL ?? `http://127.0.0.1:${process.env.SOVA_PORT ?? 4800}`).replace(/\/+$/, "");
const list = (v) => (v === undefined ? undefined : String(v).split(",").map((s) => s.trim()).filter(Boolean));
const num = (k) => {
  if (opts[k] === undefined) return undefined;
  const n = Number(opts[k]);
  if (!Number.isInteger(n) || n < 0) usage(`--${k} is a whole number`);
  return n;
};

let path;
let body;
if (verb === "approve") {
  if (!opts.project || !opts["def-hash"]) usage("approve needs --project and --def-hash (the hash status or doctor shows)");
  path = "/api/project-services/approve";
  body = { project: opts.project, defHash: opts["def-hash"], ...(opts.checkout ? { checkout: opts.checkout } : {}) };
} else {
  path = `/api/project-services/${encodeURIComponent(verb)}`;
  body = {
    project: opts.project,
    instance: opts.instance,
    checkout: opts.checkout,
    branch: opts.branch,
    from: opts.from,
    slot: num("slot"),
    services: list(opts.services),
    restart: opts.restart,
    lines: num("lines"),
    keepData: opts["keep-data"],
    resources: list(opts.resources),
    ref: opts.ref,
    confirm: opts.confirm,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
}

let res;
try {
  res = await fetch(`${base}${path}`, { method: "POST", headers: { ...tokenHeaders(), "content-type": "application/json" }, body: JSON.stringify(body) });
} catch (err) {
  console.error(`sova-project: cannot reach Sova at ${base} (${err instanceof Error ? err.message : err})`);
  process.exit(1);
}
const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  console.error(`sova-project: ${base}${path} answered ${res.status} without JSON: ${text.slice(0, 200)}`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
if (verb === "approve") process.exit(res.ok ? 0 : res.status === 409 ? 2 : 3);
process.exit(exitOf(json?.error?.code ? json : {}));
