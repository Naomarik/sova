// The core's usage line (--help, and the tail of every usage error) names every command main() dispatches
// and every packet part, so it can't drift from the commands again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec.mjs");
const { PACKET_PARTS } = await import(resolve(dirname(CORE), "packet.mjs"));

function usageLine() {
  const r = spawnSync(process.execPath, [CORE, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split("\n").filter(Boolean).length, 1, "one usage line");
  return r.stdout.trim();
}
// What main() runs, read from its own source: the arity table, the pull and look dispatch lines.
function dispatched() {
  const src = readFileSync(CORE, "utf8");
  const arity = /const arity = \{([^}]*)\}/.exec(src);
  assert.ok(arity, "the arity table is where the test expects it");
  const cmds = [...arity[1].matchAll(/([a-z-]+):/g)].map((m) => m[1]);
  for (const m of src.matchAll(/(?:pull|look)\?\.command === "([a-z-]+)"/g)) cmds.push(m[1]);
  return [...new Set(cmds)];
}

test("--help names every dispatched command and every packet part", () => {
  const usage = usageLine(), cmds = dispatched();
  for (const c of ["check", "census", "scope", "packet", "impact", "foreign", "toc", "read", "map", "where", "graph", "impact-near"])
    assert.ok(cmds.includes(c), `the source scan finds ${c}`);
  for (const c of cmds) {
    const shape = c === "impact-near" ? /(?:^|[<|] )impact §id --near\b/ : new RegExp(`(?:^usage: sova-spec <|\\| )${c}\\b`);
    assert.match(usage, shape, `${c} is in the usage line`);
  }
  const parts = /packet §id \[--part ([a-z|]+)\]/.exec(usage);
  assert.ok(parts, "packet's --part list is in the usage line");
  assert.deepEqual(parts[1].split("|"), PACKET_PARTS);
});

test("the core commands and an unknown or missing command end their usage error with the line; the paging commands keep their bounded refusals", () => {
  const usage = usageLine();
  const run = (args) => { const r = spawnSync(process.execPath, [CORE, ...args, "--json"], { encoding: "utf8" }); assert.equal(r.status, 2, args.join(" ")); return JSON.parse(r.stdout); };
  for (const args of [["check", "--bogus"], ["census", "--bogus"], ["scope", "--bogus"], ["impact", "--bogus"], ["foreign", "--bogus"], ["bogus"], []]) {
    const msg = run(args).findings.find((f) => f.code === "usage").message;
    assert.ok(msg.endsWith(`. ${usage}`), `${args.join(" ") || "(no command)"}: ${msg}`);
  }
  for (const args of [["packet", "--bogus"], ["toc", "--bogus"], ["read", "--bogus"], ["map", "--bogus"], ["where", "--bogus"], ["graph", "--bogus"], ["impact", "§a/b", "--near", "--bogus"]]) {
    const j = run(args);
    assert.deepEqual([j.status, j.code], ["refused", "usage"], args.join(" "));
    assert.ok(JSON.stringify(j).length < 200 && !JSON.stringify(j).includes("usage: sova-spec"), `${args[0]} keeps its small refusal`);
    if (args[0] === "packet") assert.equal(j.message, undefined, "packet's refusal carries no message");
    else assert.equal(j.message, "unknown flag --bogus");
  }
});
