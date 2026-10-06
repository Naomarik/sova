// Tests run in a throwaway home, whatever they inherit. A test process started from a Pi session
// inherits its HOME, PI_CODING_AGENT_DIR and CLAUDE_CONFIG_DIR — and a session that runs on an added
// Claude login has CLAUDE_CONFIG_DIR = that login's real directory — so any code under test that
// falls back to "the host's" agent dir or Claude directory (hostLogins(), leases, the state file,
// usage readers) would read or write the real ones. Importing this module first points HOME at a
// fresh temp dir per process (removed at exit) and drops every variable naming a real directory, so
// the agent dir and `~/.claude` resolve inside it, and stops git's repository search at the temp dir,
// so no test reaches a repository it didn't create. Runners import it (`tests/run.mjs`, `test.mjs`),
// and `pnpm test` loads it with `--import`. `scripts/test-sentinel.mjs` proves it holds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What points git at a repository whatever its cwd. `scripts/run-tests.mjs` drops the same list. */
const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"];

/** GIT_CEILING_DIRECTORIES: the temp dir and the folder above it (real paths, never `/`), then any inherited. */
function gitCeilings(inherited) {
	const tmp = fs.realpathSync(os.tmpdir());
	const dirs = [tmp, path.dirname(tmp), ...(inherited ?? "").split(path.delimiter)].filter((d) => d && d !== path.parse(d).root);
	return [...new Set(dirs)].join(path.delimiter);
}

// A launcher that already made the throwaway home and put it in the ENVIRONMENT before the runtime
// started (`scripts/run-tests.mjs --runtime bun`, for runtimes whose os.homedir() ignores a later HOME change)
// sets SOVA_TEST_HOME to it, and owns its removal; it is kept as is.
const inherited = process.env.SOVA_TEST_HOME && process.env.HOME === path.join(process.env.SOVA_TEST_HOME, "home") ? process.env.SOVA_TEST_HOME : null;
const root = inherited ?? fs.mkdtempSync(path.join(os.tmpdir(), "sova-test-home-"));
const home = path.join(root, "home");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
process.env.HOME = home;
process.env.USERPROFILE = home;
// Everything under test resolves the home through os.homedir(). A runtime where it ignores the HOME
// just set (Bun 1.4.2) would point every "throwaway" path at the real home: refuse to run at all.
if (os.homedir() !== home) {
	if (!inherited) fs.rmSync(root, { recursive: true, force: true });
	throw new Error(`hermetic-env: os.homedir() is ${os.homedir()}, not the throwaway HOME ${home}. This runtime ignores an in-process HOME change, so the tests would touch the real home. Set HOME in the environment before the runtime starts: run Bun through \`pnpm test\` (scripts/run-tests.mjs).`);
}
for (const name of [
	"PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_SESSIONS_DIR", "CLAUDE_CONFIG_DIR", "SOVA_EXTENSIONS_FILE",
	"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
	// Not the host's device, mesh identity or login dev switch either.
	"SOVA_DEVICE_ID", "SOVA_MESH_IDENTITY", "SOVA_CLAUDE_ACCOUNTS_DEV",
	// Nor a repository: these point every git a test starts at one (a run from a git hook sets them).
	...GIT_LOCATION_VARS,
]) delete process.env[name];
// Git started from a test's temp folder never looks above the temp dir: a plain folder a test makes
// stays plain, wherever TMPDIR is. Without this, a TMPDIR inside a checkout made every such folder that
// checkout's, and tests promoted decisions and cut coding worktrees in it. Listing the folder above
// too stops a git started in the temp dir itself.
process.env.GIT_CEILING_DIRECTORIES = gitCeilings(process.env.GIT_CEILING_DIRECTORIES);
process.env.SOVA_TEST_HOME = root;
if (!inherited) process.on("exit", () => {
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});
