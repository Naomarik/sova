// Run: pnpm exec tsx --test server/preview-links.test.ts. The preview link store (§mesh.public/preview)
// in a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-preview-links-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const store = await import("./preview-links");
const { onShareLinksChanged } = await import("./share/links-events");
const { PREVIEW_LABEL_RE } = await import("../shared/public-links");

const P = { orgId: "org1", projectId: "proj1" };
const none = new Set<number>();

test("a label is 52 lowercase base32 characters (256 bits), and only its SHA-256 is kept, 0600", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const l = store.newPreviewLabel();
    assert.match(l, PREVIEW_LABEL_RE);
    seen.add(l);
  }
  assert.equal(seen.size, 200);
  const { record, label } = store.mintPreview({ ...P, port: 5173 }, none);
  const text = readFileSync(store.previewLinksFile(), "utf8");
  assert.ok(!text.includes(label), "the label never reaches the disk");
  assert.equal(record.hash, store.hashLabel(label));
  assert.ok(text.includes(record.hash));
  assert.equal(statSync(store.previewLinksFile()).mode & 0o777, 0o600);
  assert.equal(store.findPreview(label)?.id, record.id);
  assert.equal(store.findPreview(label.toUpperCase()), null, "the label is case-exact");
  assert.equal(store.findPreview(store.newPreviewLabel()), null);
});

test("mint refuses a non-port, Sova's own defaults and every port this process uses", () => {
  for (const port of [0, 65536, 51.5, "5173", null]) assert.throws(() => store.mintPreview({ ...P, port }, none), (e: unknown) => e instanceof store.PreviewRefused && e.code === "bad-port", String(port));
  for (const port of [4800, 4801, 4802, 4810]) assert.throws(() => store.mintPreview({ ...P, port }, none), (e: unknown) => e instanceof store.PreviewRefused && e.code === "forbidden-port");
  assert.throws(() => store.mintPreview({ ...P, port: 9123 }, new Set([9123])), (e: unknown) => e instanceof store.PreviewRefused && e.code === "forbidden-port");
  assert.throws(() => store.mintPreview({ projectId: "", port: 3000 }, none), (e: unknown) => e instanceof store.PreviewRefused && e.code === "bad-project");
});

test("expiry: 1 day by default, at most 30; an expired one reads expired", () => {
  const t0 = Date.parse("2026-09-30T00:00:00.000Z");
  const a = store.mintPreview({ ...P, port: 3001 }, none, t0).record;
  assert.equal(Date.parse(a.expiresAt) - t0, 86_400_000);
  const b = store.mintPreview({ ...P, port: 3002, days: 30 }, none, t0).record;
  assert.equal(Date.parse(b.expiresAt) - t0, 30 * 86_400_000);
  assert.throws(() => store.mintPreview({ ...P, port: 3003, days: 31 }, none), (e: unknown) => e instanceof store.PreviewRefused && e.code === "bad-days");
  assert.equal(store.previewState(a, t0 + 86_400_000 - 1), "active");
  assert.equal(store.previewState(a, t0 + 86_400_000), "expired");
});

test("turn off: the state is off, a `p` revoke is emitted and the ended listeners hear its hash", async () => {
  const heard: string[] = [];
  const changes: string[] = [];
  const off1 = store.onPreviewEnded((h) => heard.push(h));
  const off2 = onShareLinksChanged((c) => void changes.push(`${c.kind}:${c.cause}`));
  const { record } = store.mintPreview({ ...P, port: 3004 }, none);
  store.revokePreview(record.id);
  await new Promise((r) => setImmediate(r));
  off1();
  off2();
  assert.deepEqual(heard, [record.hash]);
  assert.deepEqual(changes, ["p:mint", "p:revoke"]);
  assert.equal(store.findPreviewByHash(record.hash)?.revokedAt !== undefined, true);
  assert.equal(store.revokePreview("pv_missingmissingmi"), null);
  assert.throws(() => store.extendPreview(record.id, 7), (e: unknown) => e instanceof store.PreviewRefused);
});

test("extend moves an active preview's expiry to `days` from now", () => {
  const t0 = Date.parse("2026-09-30T00:00:00.000Z");
  const { record } = store.mintPreview({ ...P, port: 3005 }, none);
  const r = store.extendPreview(record.id, 7, t0)!;
  assert.equal(Date.parse(r.expiresAt) - t0, 7 * 86_400_000);
});

test("list filters by project; a file that breaks a rule serves nothing and is never overwritten", () => {
  store.mintPreview({ projectId: "other", port: 3006 }, none);
  assert.ok(store.listPreviews({ projectId: "other" }).every((v) => v.projectId === "other"));
  assert.ok(store.listPreviews({ projectId: "proj1" }).length >= 1);
  writeFileSync(store.previewLinksFile(), JSON.stringify({ version: 1, links: [{ id: "bad" }] }));
  assert.deepEqual(store.listPreviews(), []);
  assert.throws(() => store.mintPreview({ ...P, port: 3007 }, none), (e: unknown) => e instanceof store.PreviewUnavailable);
  assert.match(readFileSync(store.previewLinksFile(), "utf8"), /"bad"/);
});
