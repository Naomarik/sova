// Offline tests: the core's unit tests, then the seam with a real pi (PI_PACKAGE_DIR, default the
// global install) and a local capture server. No model requests, no network.
import "../../claude-code/tests/hermetic-env.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const args of [["--test", "core.test.ts"], [path.join("tests", "seam.mjs")]]) {
	const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
	if (r.status !== 0) process.exit(r.status ?? 1);
}
