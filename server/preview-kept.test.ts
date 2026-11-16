// A Free preview's kept link (§mesh.public/preview-tunnels): kept by its key, built on read at its tunnel's
// current address (none while it has none), and redacted like any kept link. Throwaway agent dir.
import "./testing/scratch-agent-dir.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const kept = await import("./preview-kept");

const KEY = "k".repeat(52);
const SIB = "s".repeat(52);
const ID = "pv_aaaaaaaaaaaaaaaa";
const SIB_ID = "pv_bbbbbbbbbbbbbbbb";

test("a key entry stores no link, and every read builds it at the tunnel's current address", () => {
  let origin: string | null = "https://one-two-three-four.trycloudflare.com";
  kept.setKeptLinkResolver((key) => (origin ? `${origin}/_sova/open/${key}/` : null));
  // A url handed in beside the key (a read written back) is never stored.
  kept.keepPreview(ID, { key: KEY, url: "https://stale.trycloudflare.com/_sova/open/x/", target: { kind: "port" } });
  kept.keepSiblingKey(SIB_ID, SIB);
  const file = JSON.parse(readFileSync(kept.previewKeptFile(), "utf8"));
  assert.deepEqual(file.previews[ID], { key: KEY, target: { kind: "port" } });
  assert.deepEqual(file.siblingKeys, { [SIB_ID]: SIB });
  assert.equal(kept.keptPreview(ID)?.url, `${origin}/_sova/open/${KEY}/`);
  assert.equal(kept.keptSiblingLink(SIB_ID), `${origin}/_sova/open/${SIB}/`);
  origin = "https://five-six-seven-eight.trycloudflare.com";
  assert.equal(kept.keptPreviews()[ID]?.url, `${origin}/_sova/open/${KEY}/`);
  origin = null;
  assert.equal(kept.keptPreview(ID)?.url, undefined);
  assert.equal(kept.keptSiblingLink(SIB_ID), null);
  kept.setKeptLinkResolver(null);
});

test("keys are kept labels: redacted whole, link and bare key alike, and dropped with their sibling", () => {
  kept.keepPreview(ID, { key: KEY, target: { kind: "port" } });
  kept.keepSiblingKey(SIB_ID, SIB);
  const labels = kept.keptLabels();
  assert.ok(labels.includes(KEY) && labels.includes(SIB));
  const text = `open https://one-two.trycloudflare.com/_sova/open/${KEY}/deep?x=1 or ${SIB}.`;
  assert.equal(kept.redactPreviewLinks(text), `open ${kept.PREVIEW_LINK_REDACTED} or ${kept.PREVIEW_LINK_REDACTED}.`);
  assert.equal(kept.linkLabel(`https://one-two.trycloudflare.com/_sova/open/${KEY}/`), KEY);
  assert.deepEqual(kept.dropSiblingLinks((id) => id !== SIB_ID), [SIB_ID]);
  assert.ok(!kept.keptLabels().includes(SIB));
});
