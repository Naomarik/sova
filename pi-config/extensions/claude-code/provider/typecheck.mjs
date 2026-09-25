/**
 * Strict typecheck for the provider modules.
 *
 *   node provider/typecheck.mjs            # every .ts in provider/
 *   node provider/typecheck.mjs stream.ts  # a subset
 *   node provider/typecheck.mjs ../transport.ts ../runner.ts   # extension root
 *
 * Arguments are resolved against provider/, so relative paths reach the rest
 * of the extension. Test files that import ../../subagents/ drag that
 * extension's own pre-existing errors in; keep them out of a gate invocation.
 *
 * pi-config is not covered by any tsconfig: @earendil-works/* are the installed
 * pi package's own dependencies, so the config below is generated with paths
 * pointing where node resolves them from that package — nested in its
 * node_modules (npm) or beside its real path (pnpm), the same resolution the
 * test runner uses at runtime.
 * TypeScript comes from npx; nothing is installed into pi-config.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("./", import.meta.url));
const packageDir =
	process.env.PI_PACKAGE_DIR ??
	path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const lookup = createRequire(path.join(realpathSync(packageDir), "package.json")).resolve.paths("typebox");
const dep = (name) => {
	const dir = lookup.map((root) => path.join(root, name)).find((dir) => existsSync(path.join(dir, "package.json")));
	if (!dir) throw new Error(`${name} is not resolvable from ${packageDir}`);
	return dir;
};

const requested = process.argv.slice(2);
const files = (requested.length > 0 ? requested : readdirSync(here).filter((file) => file.endsWith(".ts"))).map((file) =>
	path.resolve(here, file),
);

const paths = {
	"@earendil-works/pi-coding-agent": [path.join(packageDir, "dist/index.d.ts")],
	typebox: [dep("typebox")],
};
for (const name of ["pi-ai", "pi-tui", "pi-agent-core", "pi-telemetry"]) {
	paths[`@earendil-works/${name}`] = [path.join(dep(`@earendil-works/${name}`), "dist/index.d.ts")];
}

const config = {
	compilerOptions: {
		strict: true,
		noEmit: true,
		module: "nodenext",
		moduleResolution: "nodenext",
		target: "es2023",
		lib: ["es2023"],
		types: ["node"],
		typeRoots: [path.dirname(dep("@types/node"))],
		skipLibCheck: true,
		allowImportingTsExtensions: true,
		baseUrl: "/",
		paths,
	},
	files,
};

const dir = mkdtempSync(path.join(tmpdir(), "claude-provider-tsc-"));
const configPath = path.join(dir, "tsconfig.json");
writeFileSync(configPath, JSON.stringify(config, null, "\t"));
const result = spawnSync("npx", ["--yes", "--package", "typescript@5", "tsc", "-p", configPath], { stdio: "inherit" });
// /tmp is inode-limited on the dev machine: never leave the config dir behind.
rmSync(dir, { recursive: true, force: true });
process.exit(result.status ?? 1);
