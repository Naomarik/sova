// node --test site/scripts/add-video.test.mjs — the deploy's video check refuses a missing video.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { addVideo } from "./add-video.mjs";

const dir = mkdtempSync(join(tmpdir(), "add-video-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const tree = join(dir, "tree");
const source = join(dir, "source");
mkdirSync(join(tree, "site/src/assets/screens"), { recursive: true });
mkdirSync(source);
writeFileSync(
  join(tree, "site/src/assets/screens/manifest.json"),
  JSON.stringify({ videos: { desk: { sources: [{ file: "/video/a.av1.mp4" }, { file: "/video/a.mp4" }] } } }),
);

test("refuses when a referenced video is missing", () => {
  writeFileSync(join(source, "a.mp4"), "x");
  assert.throws(() => addVideo(tree, source), /refusing to publish.*a\.av1\.mp4/);
  assert.equal(existsSync(join(tree, "site/public/video/a.mp4")), false);
});

test("copies every referenced video when all are present", () => {
  writeFileSync(join(source, "a.av1.mp4"), "y");
  assert.deepEqual(addVideo(tree, source), ["a.av1.mp4", "a.mp4"]);
  assert.equal(existsSync(join(tree, "site/public/video/a.av1.mp4")), true);
});
