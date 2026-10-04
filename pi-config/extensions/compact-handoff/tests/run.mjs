// Offline unit tests (*.test.ts): no pi session, no model requests, no real pi child. Loaded
// through jiti with the installed pi runtime's packages, since index.ts needs pi-tui and the fork core.
import "../../claude-code/tests/hermetic-env.mjs"; // first: never the inherited agent dir
import { readdirSync } from "node:fs";
import path from "node:path";
import { jiti, root } from "./runtime.mjs";

for (const file of readdirSync(root).filter((f) => f.endsWith(".test.ts")).sort()) await jiti.import(path.join(root, file));
