// Lane F's check, runnable on its own against any tool tree: replay scenario a's claims-driver and
// manifest-order rows (two branches each promoting a new H2 at one spot, merged both ways). Prints the rows as JSON.
//   node claims-merge.mjs [--tree <extensions dir>]     (default: this checkout's pi-config/extensions)
// Exit 0: every guard held; 1: a guard failed.
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workspace, Tools, scrubProcessEnv } from "../replay/lib.mjs";
import { claimsMergeRows } from "../replay/scenarios.mjs";

const at = process.argv.indexOf("--tree");
const tree = resolve(at > 0 ? process.argv[at + 1] : join(dirname(fileURLToPath(import.meta.url)), "../../.."));
scrubProcessEnv();
const ws = workspace("claims-merge");
try {
  const rows = claimsMergeRows({ tools: new Tools(tree), ws });
  console.log(JSON.stringify(rows.map((r) => ({ metric: r.metric, value: r.value, guards: r.guards.map((g) => `${g.ok ? "ok" : "FAIL"} ${g.name}: ${g.detail}`) })), null, 2));
  process.exitCode = rows.every((r) => r.guards.every((g) => g.ok)) ? 0 : 1;
} finally { ws.dispose(); }
