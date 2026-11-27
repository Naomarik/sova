// The Transport agent fetches dependencies only through the project's own build tools from their registries, and never
// copies a download cache or a dependency folder from another folder or device: its brief and its tool say so.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBrief } from "./agent-prompt";
import { TRANSPORT_SETUP_DESCRIPTION } from "./agent-tool";

test("the agent's brief and its tool say dependencies come only through the project's build tools from their registries, never a copied cache", () => {
  const brief = agentBrief({ title: "Fix the build", device: "laptop-b", source: "laptop", folder: "/h/webapps/motors", remotes: [], branches: [], checks: [{ id: "deps:node_modules", ok: false, detail: "node_modules is missing: pnpm install" }] });
  const rule = brief.split("\n").find((l) => l.startsWith("Fetch the project's dependencies only through its own build tools, from their registries"));
  assert.ok(rule, "the brief states the rule");
  for (const cache of ["~/.m2", "~/.gitlibs", "~/.cargo/registry", "~/go/pkg/mod", "node_modules"]) assert.ok(rule.includes(cache), `it names ${cache}`);
  assert.match(rule, /never copy a dependency folder or a download cache .* from another folder on this device or from laptop, and never ask for a file in one with outside_file/);
  assert.match(TRANSPORT_SETUP_DESCRIPTION, /never a file in a download cache \(~\/\.m2\/repository, ~\/\.gitlibs, ~\/\.cargo\/registry, ~\/go\/pkg\/mod, bun's or npm's cache\): dependencies come only through the project's own build tools from their registries, never copied from another folder or device/);
});
