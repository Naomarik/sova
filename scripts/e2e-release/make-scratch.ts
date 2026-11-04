#!/usr/bin/env bun
/**
 * Builds the Release e2e projects for a UI drive on a hermetic server (never ~/.pi, never the live tree):
 *
 *   bun scripts/e2e-release/make-scratch.ts --under <dir> [--kinds remote,local,bare] [--landings 3] [--versions 0.1.0,0.2.0]
 *
 * Prints one JSON line: {projects: [{kind, name, project, origin, state, deployTarget}]}. Register each `project`
 * with the hermetic server (POST /api/projects {root, name}).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ReleaseFixture, type Kind } from "./fixtures";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const under = resolve(opt("--under", ""));
if (!opt("--under", "")) throw new Error("--under <dir> is required");
for (const bad of [resolve(homedir(), ".pi"), resolve(homedir(), "webapps", "sova")]) {
  if (under === bad || under.startsWith(bad + "/")) throw new Error(`refusing ${under}: under ${bad}`);
}
const kinds = opt("--kinds", "remote,local,bare").split(",") as Kind[];
const landings = Number(opt("--landings", "3"));
const versions = opt("--versions", "0.1.0,0.2.0").split(",");

const projects = kinds.map((kind) => {
  const fx = new ReleaseFixture({ kind, under, versions });
  if (landings) fx.seedLandings(landings);
  return { kind, name: fx.name, project: fx.project, origin: fx.origin, state: fx.state, deployTarget: fx.deployTarget };
});
console.log(JSON.stringify({ projects }));
