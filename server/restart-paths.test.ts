import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { needsBuild, needsInstall, needsRestart, restartPlan, SERVER_SRC_IMPORTS } from "./restart-paths";
import { runtimeSpecifiers, serverImportedSrc } from "./restart-paths-walk";
import * as readiness from "./merge-readiness";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("the src/ files the server loads are exactly the list: a new import of src/ fails here until it is listed", () => {
  const walked = serverImportedSrc(REPO);
  assert.ok(walked.includes("src/lib/message.ts") && walked.includes("src/lib/summary-diff.ts"), "the walk reaches the known imports");
  assert.deepEqual(walked.filter((f) => !SERVER_SRC_IMPORTS.includes(f)), [], "server-imported src/ files missing from SERVER_SRC_IMPORTS (server/restart-paths.ts)");
  assert.deepEqual(SERVER_SRC_IMPORTS.filter((f) => !walked.includes(f)), [], "SERVER_SRC_IMPORTS lists files the server no longer loads");
  assert.deepEqual([...SERVER_SRC_IMPORTS], [...SERVER_SRC_IMPORTS].sort(), "kept sorted");
});

test("the walk reads runtime imports only: type-only ones are left out, a src/ file's lazy View with them", () => {
  const text = [
    'import type { A } from "./a";',
    'import { b } from "./b";',
    'export type { C } from "./c";',
    'export { d } from "./d";',
    'import "./e";',
    'const f = () => import("./f");',
    'import {\n  g,\n  h,\n} from "./g";',
    '// import { z } from "./z";',
    'import { x } from "node:fs";',
  ].join("\n");
  assert.deepEqual(runtimeSpecifiers(text).sort(), ["./b", "./d", "./e", "./f", "./g"]);
  assert.deepEqual(runtimeSpecifiers(text, false).sort(), ["./b", "./d", "./e", "./g"]);
});

test("needsRestart: server code, shared, pi-config, the server's src/ imports, the packages and the toolchain", () => {
  for (const f of ["server/index.ts", "shared/protocol.ts", "pi-config/extensions/mode/align.ts", "src/lib/message.ts", "src/lib/tool-diff-stats.ts", "src/lib/summary-diff.ts", "src/lib/mesh-resync.ts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "mise.toml"])
    assert.equal(needsRestart(f), true, f);
  for (const f of ["src/app.tsx", "src/components/Sidebar.tsx", "src/lib/message.test.ts", "server/README.md", "pi-config/extensions/mode/spec-mode.md", "server/attention.test.ts", "server/x.integration.test.ts", ".sova/spec/manifest.json", "docs/commands.md", "index.html"])
    assert.equal(needsRestart(f), false, f);
  assert.equal(readiness.needsRestart, needsRestart, "merge-readiness reads the same rule");
});

test("needsInstall and needsBuild", () => {
  for (const f of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "mise.toml"]) assert.equal(needsInstall(f), true, f);
  assert.equal(needsInstall("server/index.ts"), false);
  for (const f of ["src/app.tsx", "public/icon.svg", "index.html", "vite.config.ts", "tsconfig.json", "shared/protocol.ts"]) assert.equal(needsBuild(f), true, f);
  for (const f of ["README.md", "src/lib/format.test.ts", "docs/x.md", ".sova/playbooks/merge-queue/PLAYBOOK.md"]) assert.equal(needsBuild(f), false, f);
});

test("restartPlan: a restart wins over a page build; the install rides along; docs alone owe nothing", () => {
  assert.deepEqual(restartPlan(["src/app.tsx", "server/app.ts"]), { action: "restart", install: false, restart: ["server/app.ts"], build: ["src/app.tsx"] });
  assert.equal(restartPlan(["src/app.tsx"]).action, "build");
  assert.deepEqual(restartPlan(["pnpm-lock.yaml"]), { action: "restart", install: true, restart: ["pnpm-lock.yaml"], build: [] });
  assert.equal(restartPlan(["README.md", "server/x.test.ts"]).action, "nothing");
  assert.equal(restartPlan([]).action, "nothing");
});
