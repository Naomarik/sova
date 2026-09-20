// Resolve the installed Pi runtime without installing a second copy of its packages.
// Same approach as ../../subagents/tests/runtime.mjs, kept local so this extension's
// tests do not depend on another extension's harness. PI_PACKAGE_DIR overrides the
// global npm installation.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir =
	process.env.PI_PACKAGE_DIR ??
	path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const require = createRequire(path.join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const resolver = createJiti(path.join(packageDir, "package.json"));
const alias = Object.fromEntries(
	["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"].map((name) => [
		name,
		resolver.esmResolve(name),
	]),
);
export const root = fileURLToPath(new URL("../", import.meta.url));
export const cli = path.join(packageDir, "dist/bundle/cli.js");
export const jiti = createJiti(import.meta.url, { alias });
