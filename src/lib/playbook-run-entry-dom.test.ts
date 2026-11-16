// Run: pnpm test -- src/lib/playbook-run-entry-dom.test.ts
// The run's entry in the conversation (§chat.playbooks/run-card) offers Open Card exactly where a
// chat's cards can open it: in a chat view, which provides its runs, and never in a read-only watch,
// which has none. Both are drawn with Solid's SSR build (src/lib/align-card-ssr.mjs) from one entry
// that imports the row and the context together, so the context the row reads is the one provided.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");

const dir = mkdtempSync(join(tmpdir(), "sova-run-entry-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const components = relative(dir, fileURLToPath(new URL("../components/", import.meta.url)));
const entry = join(dir, "entry.tsx");
writeFileSync(
  entry,
  [
    `import { PlaybookRunMessage } from "${components}/PlaybookRunMessage";`,
    `import { PlaybookRunsContext } from "${components}/PlaybookCard";`,
    `export const inChat = (store: any, props: any) => <PlaybookRunsContext.Provider value={store}><PlaybookRunMessage {...props} /></PlaybookRunsContext.Provider>;`,
    `export const inWatch = (props: any) => <PlaybookRunMessage {...props} />;`,
  ].join("\n"),
);
const { inChat, inWatch } = await importSsr(pathToFileURL(entry), (s: string) => import.meta.resolve(s));

const props = { run: { runId: "pr_aaaaaaaaaaaa", title: "A/B cycle", revision: 4 }, text: "Run the playbook…" };
/** A chat's runs, as far as the row can tell: any store at all. */
const store = { runs: () => [] };
const draw = (fn: () => unknown) => renderToString(() => solid.createComponent(fn as never, {} as never));
const OPEN_CARD = /<button[^>]*class="[^"]*pb-mark-open[^"]*"[^>]*>Open Card<\/button>/;

test("a chat view's run entry offers Open Card", () => {
  const html = draw(() => inChat(store, props));
  assert.match(html, /Playbook A\/B cycle started/, "the row itself is drawn");
  assert.match(html, OPEN_CARD);
});

test("a read-only watch's run entry has no Open Card", () => {
  const html = draw(() => inWatch(props));
  assert.match(html, /Playbook A\/B cycle started/, "the row itself is drawn");
  assert.doesNotMatch(html, /Open Card/);
});
