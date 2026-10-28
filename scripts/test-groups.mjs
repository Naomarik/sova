// The integration tier's slow groups, and what triggers each: one list that a landing
// (`run-tests.mjs --landing`, the merge round's check) and a session's own `--changed` run both read,
// so the two agree on what gets tested (§app.server-runtime/test-tiers). Builtins only.
//
// A group is integration files (`files`, less `except`) and the paths whose change can break them
// (`triggers`). Its `landing` says when a landing runs it: "triggered" when the change touches a
// trigger, "never" not at all (a release runs every group: plain `pnpm test:int`). Every file in no
// group is the everyday set, which every landing runs. A changed test file triggers only the group
// it belongs to (editing a unit test next to an area isn't a change to that area).

/** What changes how every test runs: the testing guide's front-matter `watches`. */
const TEST_SETUP = [
  "scripts/run-tests.mjs",
  "scripts/test-tier-guard.mjs",
  "scripts/test-changed.mjs",
  "scripts/test-sentinel.mjs",
  "scripts/hermetic-agent-dir.mjs",
  "pi-config/extensions/claude-code/tests/hermetic-env.mjs",
  "server/test-scratch.ts",
  "scripts/sova-scenario.mjs",
  "server/testing/hermetic-server.ts",
];
/** Any package or toolchain change: a new pi, a new Bun, a new playwright-core. */
const PACKAGES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "mise.toml"];
const SELF = ["scripts/test-groups.mjs"];

export const GROUPS = [
  {
    name: "trial",
    title: "Chat processes",
    // The end-to-end trial: Sova and its chats started as real programs and driven from outside, so
    // what it reaches is never in its import closure.
    files: ["server/chat-runtime/trial-*.integration.test.ts"],
    except: [],
    landing: "triggered",
    triggers: [
      "server/chat-runtime/**",
      "scripts/chat-runtime-trial/**",
      "server/harness/**",
      "server/send-keys.ts",
      "server/index.ts",
      "server/app.ts",
      "server/chat-host*",
      "server/chat-handle*",
      "server/chat-manager*",
      "server/chat-workers*",
      "server/worker-*",
      "server/team-*",
      "server/baton*",
      "server/overseer*",
      "server/project-overseer*",
      "server/session-powers*",
      "server/llm-inflight*",
      "server/playbook-host*",
      "scripts/fake-claude.mjs",
      "scripts/stop-chats.ts",
      "pi-config/extensions/subagents/**",
      "pi-config/extensions/claude-code/**",
      "pi-config/extensions/btw/**",
      "pi-config/extensions/explain/**",
      "pi-config/extensions/compact-handoff/**",
      "pi-config/extensions/llm-inflight/**",
      "pi-config/extensions/sessions/**",
      "pi-config/extensions/wake-nudge.ts",
      ...PACKAGES,
      ...TEST_SETUP,
      ...SELF,
    ],
  },
  {
    name: "tours",
    title: "Tours",
    // The tour tests that drive a real Chrome; the nine that start no browser stay everyday.
    files: ["server/tours/*.integration.test.ts"],
    except: [
      "server/tours/bindings-app.integration.test.ts",
      "server/tours/bindings-backup.integration.test.ts",
      "server/tours/bindings-destination.integration.test.ts",
      "server/tours/bindings-portable.integration.test.ts",
      "server/tours/runner-proxy.integration.test.ts",
      "server/tours/runtime-app.integration.test.ts",
      "server/tours/sandbox-priority.integration.test.ts",
      "server/tours/shares-lock.integration.test.ts",
      "server/tours/sweep-startup.integration.test.ts",
    ],
    landing: "never",
    triggers: [
      "server/tours/**",
      "shared/tour*",
      "server/project-services/tour-target*",
      "server/share/tour-*",
      "server/tour-routes.ts",
      "pi-config/extensions/sandbox/**",
      ...PACKAGES,
      ...TEST_SETUP,
      ...SELF,
    ],
  },
];

/** The name of the everyday set: every integration file in no group. */
export const EVERYDAY = "core";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A path glob as a whole-path RegExp: `**` any depth (`dir/**` the dir's every file), `*` within one segment. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}
const matches = (globs, file) => globs.some((g) => globRe(g).test(file));
const isTestFile = (f) => /\.test\.[cm]?[jt]sx?$/.test(f);

/** The group a root-relative file belongs to, or null (the everyday set, or not a test). */
export function groupOf(file, groups = GROUPS) {
  return groups.find((g) => matches(g.files, file) && !g.except.includes(file)) ?? null;
}

/** For each group, the changed files that trigger it (a test file only its own group). */
export function triggersHit(changed, groups = GROUPS) {
  const hit = {};
  for (const g of groups) {
    hit[g.name] = changed.filter((f) => (isTestFile(f) ? groupOf(f, groups) === g : matches(g.triggers, f)));
  }
  return hit;
}

/**
 * Of `files` (root-relative test files), what a run in `mode` keeps:
 * - "landing": every file in no group, plus each "triggered" group the change touches; "never" groups never.
 * - "changed": the files `closure` (the import-closure pick, applied to files in no group) keeps,
 *   plus every file of each group the change touches; never a group's file by its imports alone.
 * - "groups": only the files of the groups named in `only` ("all": every group).
 * → { files, ran: [group names], skipped: [{ name, title, why: "untriggered" | "never" | "not asked", files, hits }] }
 */
export function selectFiles(files, changed, { mode, closure = (fs) => fs, only = [], groups = GROUPS } = {}) {
  const hit = triggersHit(changed, groups);
  const ofGroup = (g) => files.filter((f) => groupOf(f, groups) === g);
  const everyday = files.filter((f) => !groupOf(f, groups));
  const ran = [];
  const skipped = [];
  let chosen;
  if (mode === "groups") {
    const want = only.includes("all") ? groups.map((g) => g.name) : only;
    chosen = [];
    for (const g of groups) {
      if (want.includes(g.name)) { ran.push(g.name); chosen.push(...ofGroup(g)); }
      else skipped.push({ name: g.name, title: g.title, why: "not asked", files: ofGroup(g).length, hits: [] });
    }
  } else {
    chosen = mode === "changed" ? closure(everyday) : everyday;
    for (const g of groups) {
      const mine = ofGroup(g);
      const runs = hit[g.name].length > 0 && (mode === "changed" || g.landing === "triggered");
      if (runs) { ran.push(g.name); chosen.push(...mine); }
      else skipped.push({ name: g.name, title: g.title, why: mode === "landing" && g.landing === "never" ? "never" : "untriggered", files: mine.length, hits: [] });
    }
  }
  for (const s of skipped) s.hits = hit[s.name];
  const keep = new Set(chosen);
  return { files: files.filter((f) => keep.has(f)), ran, skipped, hits: hit };
}

/** The key the merge round keeps a run's timings under: "core", or "core+trial" for the everyday set and Chat processes. */
export const setKey = (ran) => [EVERYDAY, ...ran].join("+");
