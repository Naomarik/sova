// Offline tests of index.ts against a fake pi API (no model requests). PI_PACKAGE_DIR can
// override the global npm installation the pi imports resolve from.
import path from "node:path";
import { jiti, root } from "./runtime.mjs";
await jiti.import(path.join(root, "index.test.ts"));
