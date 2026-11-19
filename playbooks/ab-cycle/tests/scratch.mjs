// This playbook's tests run on their own (`node --test playbooks/ab-cycle/tests/`), with no test runner to make them
// safe, so each file makes itself safe on import, before any script runs: a throwaway root in the OS temp dir, proven to
// be in no git repository; HOME, the agent dir and the XDG folders pointed inside it; every variable that points git at
// a repository, or at a real home or login, dropped; and git's repository search stopped at the temp dir. Every script a
// test spawns inherits that environment, so none can read or write the real home, agent dir or a repository the test
// didn't make. Node built-ins only.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";

/** What points git at a repository whatever its cwd. */
const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"];
/** What names a real home, agent dir, login or install the scripts could fall back to. */
const REAL_PLACES = ["PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_SESSIONS_DIR", "CLAUDE_CONFIG_DIR", "SOVA_EXTENSIONS_FILE", "SOVA_ROOT", "SOVA_DEVICE_ID", "SOVA_MESH_IDENTITY", "SOVA_CLAUDE_ACCOUNTS_DEV", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

/** The repository git finds from `dir` (with the environment as it is now), or null. */
function repositoryAt(dir) {
  try {
    return execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * This file's throwaway root, removed when the process exits. Throws, removing it, when the temp dir is inside a git
 * repository (found before git's search is stopped): run with a TMPDIR outside every repository.
 */
export function scratchRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  for (const name of [...GIT_LOCATION_VARS, ...REAL_PLACES]) delete process.env[name];
  const found = repositoryAt(root);
  if (found) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`scratchRoot: ${root} is inside the git repository ${found}; these tests make folders that must belong to no repository. Run them with a TMPDIR outside every repository.`);
  }
  const home = join(root, "home");
  for (const d of [join(home, ".pi", "agent"), join(home, ".claude"), join(home, ".config"), join(home, ".local", "share"), join(home, ".local", "state"), join(home, ".cache")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    // No system or user git config of the machine's (hooks, signing, templates): only what a test passes with -c.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    // Git started under the root never looks above the temp dir; the folder above it too stops a git started in it.
    GIT_CEILING_DIRECTORIES: [...new Set([root, realpathSync(tmpdir()), dirname(realpathSync(tmpdir()))])].filter((d) => d !== parse(d).root).join(delimiter),
  });
  return root;
}
