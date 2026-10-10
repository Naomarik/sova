// The developer check of Claude re-sends (§app.insights/usage-resend): reads the usage ledger's files
// and the price history, writes nothing, calls no model.
//
//   pnpm run claude:cache-check [--usage <agent dir>/usage/v1] [--prices <file>] [--from yyyy-mm-dd] [--to yyyy-mm-dd] [--top 5] [--json]
//
// Defaults: the agent dir's ledger (PI_CODING_AGENT_DIR, else ~/.pi/agent) and Sova's price history
// (`<agent dir>/sova/model-prices.json`), else the checked-in seed.
import fs from "node:fs";
import path from "node:path";
import { defaultAgentDir, usageRoot } from "../pi-config/extensions/llm-inflight/usage-record.ts";
import { parseTable, type Aliases } from "../shared/model-prices/prices";
import { ALIASES_FILE, SEED_FILE } from "../server/usage-helper/price-book";
import { cacheCheck, formatCheck, readLedger } from "../server/claude-cache-check";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const agentDir = defaultAgentDir();
const usage = flag("usage") ?? usageRoot(agentDir);
const pricesFile = flag("prices") ?? [path.join(agentDir, "sova", "model-prices.json"), SEED_FILE].find((f) => fs.existsSync(f))!;
const table = parseTable(JSON.parse(fs.readFileSync(pricesFile, "utf8")));
if (!table) {
  console.error(`claude-cache-check: ${pricesFile} is not a price table`);
  process.exit(2);
}
const aliases = JSON.parse(fs.readFileSync(ALIASES_FILE, "utf8")) as Aliases;
const from = flag("from");
const to = flag("to");
const report = cacheCheck(readLedger(usage, from, to), { table, aliases, ...(from ? { from } : {}), ...(to ? { to } : {}) });
if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else console.log(formatCheck(report, Number(flag("top") ?? 5)));
