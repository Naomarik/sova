// The previews' sweep stops only ended previews' folder serves, never a copy's static service
// (§app.project-services/supervisor, §mesh.public/preview-serve). A temp PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-preview-sweep-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
mkdirSync(join(root, "site"));
writeFileSync(join(root, "site", "index.html"), "<h1>Site</h1>");

const { startStaticServe, staticServes, stopStaticServe } = await import("./preview-serve");
const { sweepStaticPreviews } = await import("./project-previews");
const { mintPreview, revokePreview } = await import("./preview-links");

after(async () => {
  for (const s of staticServes()) await stopStaticServe(s.id);
});

test("the sweep stops an ended preview's serve and never a copy's static service", async () => {
  const unit = "sova-svc-abcdef12-inst1-web";
  await startStaticServe({ id: unit, root: join(root, "site") });
  const { port } = await startStaticServe({ id: "staging-1", root: join(root, "site") });
  await stopStaticServe("staging-1");
  const { record } = mintPreview({ projectId: "p_sweep", port, days: 1, createdBy: "operator" }, new Set());
  await startStaticServe({ id: record.id, root: join(root, "site"), port });

  await sweepStaticPreviews();
  assert.deepEqual(staticServes().map((s) => s.id).sort(), [record.id, unit].sort(), "an active preview and a copy's service both keep serving");

  revokePreview(record.id);
  await sweepStaticPreviews();
  assert.deepEqual(staticServes().map((s) => s.id), [unit], "the ended preview's serve stops; the copy's stays");
});
