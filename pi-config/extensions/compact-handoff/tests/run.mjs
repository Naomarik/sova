// Offline unit tests (*.test.ts, Node's own type stripping): no pi session, no model requests.
import "../../claude-code/tests/hermetic-env.mjs"; // first: never the inherited agent dir
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const file of readdirSync(root).filter((f) => f.endsWith(".test.ts")).sort()) await import(path.join(root, file));
