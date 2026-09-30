// Run: ORG_HOST_BENCH=1 pnpm exec tsx --test server/org-host/bench.test.ts. Design C09's resume gate:
// an org of 500 sessions opens (journal replay, load, resume in chunks, past-due timers) in < 2 s
// wall, with no single blocking slice > 50 ms. Timing-sensitive, so off unless asked.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EngineOptions } from "../org-charts";
import { OrgHost } from "./index";
import { HOST_STATECHARTS } from "./test-chart";

test("resume of a 500-session org: < 2 s wall, no slice > 50 ms", { skip: !process.env["ORG_HOST_BENCH"] }, async () => {
  const root = mkdtempSync(join(tmpdir(), "org-host-bench-"));
  const at = { orgId: "o1", workspaceDir: join(root, "ws"), stateDir: join(root, "state"), durable: false, charts: HOST_STATECHARTS as unknown as EngineOptions["charts"] };
  try {
    const host = await OrgHost.open(at);
    for (let i = 0; i < 500; i++) {
      await host.start(`p/${i}`, "host-probe", {}, { by: "operator" });
      if (i % 3 === 0) await host.act(`p/${i}`, "wait", {}, { by: "operator" });
    }
    await host.close();
    let worst = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const t = performance.now();
      worst = Math.max(worst, t - last);
      last = t;
    }, 1);
    const t0 = performance.now();
    const again = await OrgHost.open(at);
    const wall = performance.now() - t0;
    clearInterval(probe);
    console.log(`resume of 500 sessions: ${wall.toFixed(0)} ms wall, worst slice ${worst.toFixed(1)} ms`);
    assert.equal(again.sessions().length, 500);
    assert.ok(wall < 2000, `wall ${wall} ms`);
    assert.ok(worst < 50, `worst slice ${worst} ms`);
    await again.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
