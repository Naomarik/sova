// Offline tests: the unit tests (*.test.ts, against pi's real ModelRuntime) and the pi end-to-end
// test (real pi CLI sessions against a local fake provider). No model requests.
// PI_PACKAGE_DIR can point at another pi install (default: the global one).
import "../../claude-code/tests/hermetic-env.mjs"; // first: never the inherited agent dir
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = realpathSync(
	process.env.PI_PACKAGE_DIR ??
		path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent"),
);
process.env.PI_PACKAGE_DIR = packageDir;
const require = createRequire(path.join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const resolver = createJiti(path.join(packageDir, "package.json"));
// Extensions get the pi-ai root as its compat entry (pi's extension loader does the same).
const alias = {
	"@earendil-works/pi-coding-agent": resolver.esmResolve("@earendil-works/pi-coding-agent"),
	"@earendil-works/pi-ai": resolver.esmResolve("@earendil-works/pi-ai/compat"),
};
const jiti = createJiti(import.meta.url, { alias });
const root = fileURLToPath(new URL("../", import.meta.url));
for (const file of readdirSync(root).filter((f) => f.endsWith(".test.ts")).sort()) await jiti.import(path.join(root, file));
await import("./pi-e2e.mjs");
