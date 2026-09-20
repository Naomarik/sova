// Offline regression tests. PI_PACKAGE_DIR can override the global npm installation.
import { readdirSync } from "node:fs";
import path from "node:path";
import { jiti, root } from "./runtime.mjs";
for (const file of readdirSync(root)
	.filter((f) => f.endsWith(".test.ts"))
	.sort())
	await jiti.import(path.join(root, file));
