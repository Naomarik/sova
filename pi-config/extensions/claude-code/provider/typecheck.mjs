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
 * pi-config is not covered by any tsconfig: @earendil-works/* lives inside the
 * installed pi package's node_modules, so the config below is generated with
 * paths pointing there (same resolution the test runner uses at runtime).
 * TypeScript comes from npx; nothing is installed into pi-config.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("./", import.meta.url));
const packageDir =
	process.env.PI_PACKAGE_DIR ??
	path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const nested = path.join(packageDir, "node_modules");

const requested = process.argv.slice(2);
const files = (requested.length > 0 ? requested : readdirSync(here).filter((file) => file.endsWith(".ts"))).map((file) =>
	path.resolve(here, file),
);

const paths = {
	"@earendil-works/pi-coding-agent": [path.join(packageDir, "dist/index.d.ts")],
	typebox: [path.join(nested, "typebox")],
};
for (const name of ["pi-ai", "pi-tui", "pi-agent-core", "pi-telemetry"]) {
	paths[`@earendil-works/${name}`] = [path.join(nested, "@earendil-works", name, "dist/index.d.ts")];
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
		typeRoots: [path.join(nested, "@types")],
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
process.exit(result.status ?? 1);
