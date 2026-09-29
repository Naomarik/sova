// Run: pnpm exec tsx --test server/mesh-termux-share.test.ts. The phone's installer builds the share
// page beside the app (§mesh.phone/share-page): a link minted on a phone and opened through a
// gateway is served by the phone's share listener, which answers 503 without dist-share/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../scripts/mesh-termux/install.sh", import.meta.url), "utf8");
// The source block: from the "already built" check to the swap into app/.
const start = script.indexOf('if [ -f "$BASE/app/dist/index.html" ]');
const block = script.slice(start, script.indexOf('mv "$BASE/app.new" "$BASE/app"', start));

test("the installer builds the share page and checks it, beside the app's build", () => {
  assert.ok(start > 0 && block.length > 0, "the source block is where it was");
  const app = block.search(/vite\.js build --logLevel/);
  const share = block.search(/vite\.js build --mode share\b/);
  assert.ok(app > 0, "the app build");
  assert.ok(share > 0, "the share build (vite build --mode share)");
  assert.match(block, /\[ -f dist-share\/index\.html \] \|\| die /, "a missing dist-share/index.html stops the install");
});

test("a rerun keeps the builds only when the share page is there too", () => {
  const skip = block.slice(0, block.indexOf("then"));
  assert.match(skip, /\$BASE\/app\/dist\/index\.html/);
  assert.match(skip, /\$BASE\/app\/dist-share\/index\.html/, "an install from before this change rebuilds");
});
