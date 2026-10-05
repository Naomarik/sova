#!/usr/bin/env node
// sova-project: the project verbs from a terminal or a hook (§app.project-services/callers).
// A thin client of POST /api/project-services/<verb>: it prints the verb's JSON result on stdout
// and exits with its class (0 done, 1 failed part-way, 2 refused, 3 invalid, 4 busy). It acts as
// the operator. Node builtins, and the exit classes from shared/project-contract.ts (Node strips its types).
//
//   node scripts/sova-project.mjs <verb> [--project <path>] [--instance <id>] [--checkout <path>]
//     [--branch <name>] [--from <ref>] [--slot <n>] [--services a,b] [--restart] [--lines <n>]
//     [--keep-data] [--resources a,b] [--ref <ref>] [--select a,b] [--endpoint <service.port>] [--days <n>]
//     [--link <pv_…>] [--confirm] [--url <http://127.0.0.1:4800>]
//   e.g. share --instance <id> --endpoint web.http --days 3 --confirm; revoke --link <pv_…> | --instance <id> [--endpoint …]
//   deploy (§app.project-services/deploy): deploy.status [--target <name>]; deploy.logs --target <name> | --deploy <dp_…>;
//     deploy.check [--ref <ref>]; deploy.plan --target <name> [--commit <ref>] [--override-tests <reason>]
//     [--override-dirty <reason>]; deploy.run --plan <pl_…> --confirm (answers at once: follow it with deploy.status);
//     deploy.rollback --target <name> --confirm; deploy.request --target <name> --dismiss
//   node scripts/sova-project.mjs approve --project <path> --def-hash <sha256:…> [--checkout <path>]
//
// The server is --url, else $SOVA_URL, else http://127.0.0.1:$SOVA_PORT (default 4800). Its token
// is $SOVA_TOKEN, else the one in $PI_CODING_AGENT_DIR (default ~/.pi/agent) (scripts/sova-token.mjs).

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { exitOf } from "../shared/project-contract.ts";
import { tokenHeaders } from "./sova-token.mjs";

const VALUE = new Set(["project", "instance", "checkout", "branch", "from", "slot", "services", "lines", "resources", "ref", "select", "endpoint", "days", "link", "url", "def-hash", "target", "commit", "plan", "deploy", "why", "override-tests", "override-dirty"]);
const FLAG = new Set(["restart", "keep-data", "confirm", "dismiss"]);
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
} else if (verb.startsWith("deploy.")) {
  // The deploy verbs take their own keys (a target, never an instance).
  path = `/api/project-services/${encodeURIComponent(verb)}`;
  body = {
    project: opts.project ?? resolve("."),
    target: opts.target,
    commit: opts.commit,
    ref: opts.ref,
    plan: opts.plan,
    deploy: opts.deploy,
    why: opts.why,
    lines: num("lines"),
    overrideTests: opts["override-tests"],
    overrideDirty: opts["override-dirty"],
    confirm: opts.confirm,
    dismiss: opts.dismiss,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
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
    select: list(opts.select),
    endpoint: opts.endpoint,
    days: num("days"),
    link: opts.link,
    confirm: opts.confirm,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
}

// node:http, not fetch: fetch gives up on a response whose headers take more than 300 s, and a
// conformance run of a large project takes longer. This request waits as long as the verb runs.
function post(url, payload) {
  return new Promise((done, fail) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(payload));
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      { method: "POST", headers: { ...tokenHeaders(), "content-type": "application/json", "content-length": data.length } },
      (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => done({ status: r.statusCode ?? 0, ok: (r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 300, text: Buffer.concat(chunks).toString("utf8") }));
        r.on("error", fail);
      },
    );
    req.on("error", fail);
    req.end(data);
  });
}

let res;
try {
  res = await post(`${base}${path}`, body);
} catch (err) {
  console.error(`sova-project: cannot reach Sova at ${base} (${err instanceof Error ? err.message : err})`);
  process.exit(1);
}
const text = res.text;
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
