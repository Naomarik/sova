// Offline regression tests. PI_PACKAGE_DIR can override the global npm installation.
import "../../claude-code/tests/hermetic-env.mjs"; // first: never the inherited agent dir / Claude directory
import { readdirSync } from "node:fs";
import path from "node:path";
import { jiti, root } from "./runtime.mjs";
// fork/ is the shared fork core (background forks and the fork cache identity), tested here too.
for (const dir of [root, path.join(root, "fork")])
	for (const file of readdirSync(dir)
		.filter((f) => f.endsWith(".test.ts"))
		.sort())
		await jiti.import(path.join(dir, file));
