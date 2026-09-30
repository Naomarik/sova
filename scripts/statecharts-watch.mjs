#!/usr/bin/env node
// Fast loop for org-charts/ (the org's statecharts): one shadow-cljs server running `watch lib test`,
// rooted at org-charts/, writing only its gitignored out/ and .shadow-cljs/. Run tests against its
// output with `pnpm statecharts:test`. The vendored bundle still comes from scripts/build-org-charts.mjs.
//
// Each worktree's server keeps its port files in its own org-charts/.shadow-cljs/, so it never attaches to
// another worktree's server; its HTTP port moves up from 9630 when taken, and nREPL takes a random port.
// Devtools are off: the lib build's dev client needs npm `ws`.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = join(dirname(fileURLToPath(import.meta.url)), "..", "org-charts");
const pidFile = join(project, ".shadow-cljs", "server.pid");
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) {
    console.error(`a shadow-cljs server (pid ${pid}) already runs for this worktree's org-charts/; use it, or stop it first`);
    process.exit(1);
  }
}
const child = spawn("clojure", ["-Srepro", "-M:build", "-m", "shadow.cljs.devtools.cli",
  "watch", "lib", "test", "--config-merge", "{:devtools {:enabled false}}"], { cwd: project, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
