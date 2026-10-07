import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Who may call which deploy verb (§app.project-services/deploy-callers): reads are anyone's in scope;
 * a plan is the operator's or the global Overseer's (its act wrapper keeps that to a turn the user
 * started); run and rollback are the operator's alone, confirmed; an overseer may only ask
 * (deploy.request); a coding session's project_verbs gets forbidden for everything but the reads.
 * And the CLI's deploy flags reach the route as the deploy verbs' keys: the real CLI against a listener
 * here; the caller matrix and the tools are in deploy-callers.test.ts.
 */

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-deploy-cli-")));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the CLI: deploy.run --plan <id> --confirm posts the deploy keys, and exits with the result's class", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const srv = createServer((q, s) => {
    let b = "";
    q.on("data", (c) => (b += c));
    q.on("end", () => {
      seen.push({ path: q.url ?? "", body: JSON.parse(b) });
      s.setHeader("content-type", "application/json");
      s.statusCode = 409;
      s.end(JSON.stringify({ v: 1, verb: "deploy.run", error: { code: "deploy-refused", message: "expired" } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const cli = fileURLToPath(new URL("../../scripts/sova-project.mjs", import.meta.url));
  const code = await new Promise<number | null>((done) => {
    const p = spawn(process.execPath, [cli, "deploy.run", "--project", dir, "--plan", "pl_0123456789abcdef", "--confirm", "--url", url], { env: { ...process.env, SOVA_TOKEN: "t" }, stdio: "ignore" });
    p.on("exit", done);
  });
  srv.close();
  assert.equal(code, 2, "deploy-refused is a refusal");
  assert.deepEqual(seen, [{ path: "/api/project-services/deploy.run", body: { project: dir, plan: "pl_0123456789abcdef", confirm: true } }]);
});
