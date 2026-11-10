/**
 * Which changed files the live server only picks up at its restart, which need the packages installed again, and
 * which change the built page. One rule for the session readiness (merge-readiness.ts needsRestart) and for Sova's own
 * restart after landings (server/merge-queue/restart.ts: merge.live and merge.restart). Imports nothing, and uses only
 * syntax Node runs with its type stripping.
 */

/**
 * The `src/` files the server or a chat process loads at runtime (the frontend guide's "src/ files the server
 * imports"): an edit to one reaches the live server only at its restart. Sorted. restart-paths.test.ts holds this list
 * to a walk of the server's import graph (restart-paths-walk.ts), so a new import of src/ fails it until it is here.
 */
export const SERVER_SRC_IMPORTS: readonly string[] = [
  "src/lib/design-frame.ts",
  "src/lib/diff/parse.ts",
  "src/lib/diff/types.ts",
  "src/lib/fences.ts",
  "src/lib/format.ts",
  "src/lib/insights.ts",
  "src/lib/mesh-resync.ts",
  "src/lib/message.ts",
  "src/lib/summary-diff.ts",
  "src/lib/tool-diff-stats.ts",
  "src/lib/usage-burn.ts",
  "src/share/markdown.ts",
  "src/vis/core/emphasis.ts",
  "src/vis/core/grammar.ts",
  "src/vis/core/scale.ts",
  "src/vis/core/text.ts",
  "src/vis/icons.ts",
  "src/vis/kinds/chart/layout.ts",
  "src/vis/kinds/chart/parse.ts",
  "src/vis/kinds/chart/parts.ts",
  "src/vis/kinds/chart/scale.ts",
  "src/vis/kinds/code/layout.ts",
  "src/vis/kinds/code/parse.ts",
  "src/vis/kinds/flow/layout.ts",
  "src/vis/kinds/flow/parse.ts",
  "src/vis/kinds/flow/sections.ts",
  "src/vis/kinds/frame/height.ts",
  "src/vis/kinds/frame/parse.ts",
  "src/vis/kinds/frame/srcdoc.ts",
  "src/vis/kinds/layers/height.ts",
  "src/vis/kinds/layers/parse.ts",
  "src/vis/kinds/matrix/height.ts",
  "src/vis/kinds/matrix/parse.ts",
  "src/vis/kinds/sequence/layout.ts",
  "src/vis/kinds/sequence/parse.ts",
  "src/vis/kinds/steps/height.ts",
  "src/vis/kinds/steps/layout.ts",
  "src/vis/kinds/steps/parse.ts",
  "src/vis/kinds/timeline/height.ts",
  "src/vis/kinds/timeline/parse.ts",
  "src/vis/kinds/tree/height.ts",
  "src/vis/kinds/tree/measure.ts",
  "src/vis/kinds/tree/parse.ts",
  "src/vis/kinds/wireframe/layout.ts",
  "src/vis/kinds/wireframe/parse.ts",
  "src/vis/parse.ts",
  "src/vis/registry.ts",
];

/** The files whose change needs `pnpm install --frozen-lockfile` before anything is built or restarted. */
export const INSTALL_FILES: readonly string[] = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "mise.toml"];

const DOC_OR_TEST = /\.md$|\.test\.[cm]?[jt]sx?$/;

/** A changed file that needs the server restarted: server-side code (server/, shared/, pi-config/, the src/ files the
 *  server imports), the packages and the toolchain; never the page alone, docs or tests. */
export function needsRestart(file: string): boolean {
  if (INSTALL_FILES.includes(file)) return true;
  if (DOC_OR_TEST.test(file)) return false;
  return /^(?:server|shared|pi-config)\//.test(file) || SERVER_SRC_IMPORTS.includes(file);
}

/** A changed file that needs `pnpm install --frozen-lockfile` first. */
export function needsInstall(file: string): boolean {
  return INSTALL_FILES.includes(file);
}

/** A changed file that changes the built page (`pnpm run build`): the page's own files, and everything the server
 *  needs restarted for (shared/ and the packages are the page's too). */
export function needsBuild(file: string): boolean {
  if (needsRestart(file)) return true;
  if (DOC_OR_TEST.test(file)) return false;
  return /^(?:src|public)\//.test(file) || file === "index.html" || /^vite\.config\.[cm]?[jt]s$/.test(file) || /^tsconfig[^/]*\.json$/.test(file);
}

/** Whether two package.json texts differ only in the top-level `version` (a release's bump): such a change needs no
 *  install, no build and no restart. Unreadable JSON on either side counts as a real change. */
export function onlyVersionBumped(before: string, after: string): boolean {
  try {
    const a = JSON.parse(before) as Record<string, unknown>;
    const b = JSON.parse(after) as Record<string, unknown>;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    delete a.version;
    delete b.version;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** What a set of landed files owes the live server: a restart (with an install first when `install`), a build of the
 *  page only, or nothing. `versionOnly`: files whose change is only a version bump (package.json, by onlyVersionBumped),
 *  left out, so a release's own commit owes nothing. needsRestart (the session readiness) stays file-level: it reads
 *  names only, and a release commit there just asks for a restart it doesn't need. */
export function restartPlan(files: readonly string[], opts: { versionOnly?: readonly string[] } = {}): { action: "restart" | "build" | "nothing"; install: boolean; restart: string[]; build: string[] } {
  const counted = files.filter((f) => !opts.versionOnly?.includes(f));
  const restart = counted.filter(needsRestart);
  const build = counted.filter((f) => !needsRestart(f) && needsBuild(f));
  return { action: restart.length ? "restart" : build.length ? "build" : "nothing", install: counted.some(needsInstall), restart, build };
}
