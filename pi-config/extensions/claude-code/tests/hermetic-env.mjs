// Tests run in a throwaway home, whatever they inherit. A test process started from a Pi session
// inherits its HOME, PI_CODING_AGENT_DIR and CLAUDE_CONFIG_DIR — and a session that runs on an added
// Claude login has CLAUDE_CONFIG_DIR = that login's real directory — so any code under test that
// falls back to "the host's" agent dir or Claude directory (hostLogins(), leases, the state file,
// usage readers) would read or write the real ones. Importing this module first points HOME at a
// fresh temp dir per process (removed at exit) and drops every variable naming a real directory, so
// the agent dir and `~/.claude` resolve inside it. Runners import it (`tests/run.mjs`, `test.mjs`),
// and `pnpm test` loads it with `--import`. `scripts/test-sentinel.mjs` proves it holds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sova-test-home-"));
const home = path.join(root, "home");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const name of [
	"PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_SESSIONS_DIR", "CLAUDE_CONFIG_DIR", "SOVA_EXTENSIONS_FILE",
	"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
	// Not the host's device, mesh identity or login dev switch either.
	"SOVA_DEVICE_ID", "SOVA_MESH_IDENTITY", "SOVA_CLAUDE_ACCOUNTS_DEV",
]) delete process.env[name];
process.env.SOVA_TEST_HOME = root;
process.on("exit", () => {
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});
