// Run: pnpm test -- server/playbook-tools.test.ts
// playbook_read (§chat.schedules/playbook-read): only the delivered playbook's folder, never out of it
// by `..`, an absolute path or a link; the session's sandbox refuses what it hides; each result
// records the version it read; a session with no delivered playbook reads nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HEntry } from "../shared/harness-history";
import type { ToolCtx } from "../shared/harness";
import { renderBlock } from "../shared/playbook-delivery";
import { deliveredHint, hasDelivery, playbookReadTool } from "./playbook-tools";
import { PlaybookVersions, shaOf } from "./playbook-versions";

const dir = mkdtempSync(join(tmpdir(), "sova-playbook-tools-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const pb = join(dir, "p", ".sova", "playbooks", "merge-round");
mkdirSync(join(pb, "references"), { recursive: true });
writeFileSync(join(pb, "PLAYBOOK.md"), "# Merge round\n");
writeFileSync(join(pb, "references", "land.md"), "Land it.\n");
writeFileSync(join(dir, "secret.txt"), "outside\n");
symlinkSync(join(dir, "secret.txt"), join(pb, "references", "escape.md"));
const bundle = { id: "merge-round", dir: pb, entry: "PLAYBOOK.md" };
const versions = new PlaybookVersions(join(dir, "versions"));

const fired: HEntry = { id: "u1", parentId: null, kind: "user", blocks: [{ type: "text", text: `[schedule s1] Scheduled run fired (every 6h, automation merge-round).\n${renderBlock(bundle, "0123456789abcdef", { load: "full", body: "# Merge round" }, [])}` }] };
const ctx = (branch: HEntry[]): ToolCtx => ({ sessionId: "sess", cwd: join(dir, "p"), leafId: () => null, branch: () => branch, state: () => ({}) as never });
const tool = (opts: { bound?: boolean; hidden?: string } = {}) =>
  playbookReadTool({
    bundleFor: async (sid, hint) => (opts.bound !== false && sid === "sess" && hint?.id === "merge-round" ? bundle : null),
    readDenial: (_c, canonical) => (opts.hidden && canonical.startsWith(opts.hidden) ? `${canonical} is hidden by the sandbox policy` : undefined),
    versions,
  });
const run = (t: ReturnType<typeof tool>, file: string, branch: HEntry[] = [fired]) => t.execute("c1", { file }, undefined, undefined, ctx(branch));

test("reads a file of the delivered playbook whole, and records which version", async () => {
  const r = await run(tool(), "references/land.md");
  assert.deepEqual(r.content, [{ type: "text", text: "Land it.\n" }]);
  assert.deepEqual(r.details, { v: 1, playbook: "merge-round", file: "references/land.md", sha: shaOf("Land it.\n") });
  assert.equal(versions.get(shaOf("Land it.\n")), "Land it.\n", "kept, for a later diff");
  assert.equal((await run(tool(), "PLAYBOOK.md")).details?.file, "PLAYBOOK.md");
});

test("never leaves the folder: .., an absolute path, a link out, or a file that isn't there", async () => {
  await assert.rejects(run(tool(), "../../../secret.txt"), /leaves the playbook's folder/);
  await assert.rejects(run(tool(), join(dir, "secret.txt")), /relative to it/);
  await assert.rejects(run(tool(), "references/escape.md"), /points outside the playbook's folder/);
  await assert.rejects(run(tool(), "references/nope.md"), /No file "references\/nope\.md"/);
});

test("the session's sandbox refuses what it hides", async () => {
  await assert.rejects(run(tool({ hidden: join(pb, "references") }), "references/land.md"), /Refused: .* is hidden by the sandbox policy/);
});

test("a session no fire delivered a playbook to reads nothing, and has no tool", async () => {
  await assert.rejects(run(tool({ bound: false }), "references/land.md"), /runs no automation's playbook/);
  assert.equal(hasDelivery(ctx([])), false);
  assert.equal(hasDelivery(ctx([fired])), true);
  assert.deepEqual(deliveredHint(ctx([fired])), { id: "merge-round", dir: pb });
  // A user's message that merely quotes a block mid-line is not a delivery.
  const quoted: HEntry = { id: "u2", parentId: null, kind: "user", blocks: [{ type: "text", text: 'look: <playbook id="x" sha="0123456789abcdef" load="full"> inline' }] };
  assert.equal(hasDelivery(ctx([quoted])), false);
});
