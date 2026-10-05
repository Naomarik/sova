// Writes inputs/live-test.json: every store sequence src/lib/live.test.ts drives, as recorded calls, so the
// wire goldens (wire.test.ts) replay the same inputs through today's applyEvent and every later port of it.
// It replays the test file with `./live` swapped for live-calls.ts (the real mutators, logged) and node:test's
// `test` for one that runs the body at once; the tests' assertions still run. Explicit only:
//
//   bun server/harness/pi/golden/wire/extract-live.ts            # rewrite inputs/live-test.json
//   bun server/harness/pi/golden/wire/extract-live.ts --check    # exit 1 unless it equals the committed file
//
// The committed file is the input of record: once milestone 3 rewrites live.test.ts, --check is expected to
// differ, and the file stays as recorded.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const HERE = import.meta.dirname;
const REPO = join(HERE, "../../../../..");
const SOURCE = join(REPO, "src/lib/live.test.ts");
export const LIVE_INPUTS = join(HERE, "inputs/live-test.json");

/** The test file with its imports pointed at the shim, and every other relative import made absolute. */
function rewritten(text: string): string {
  return text.replace(/from "([^"]+)";/g, (whole, spec: string) => {
    if (spec === "./live") return `from ${JSON.stringify(join(HERE, "live-calls.ts"))};`;
    if (spec === "node:test") return `from ${JSON.stringify(join(HERE, "live-calls.ts"))};`;
    if (spec.startsWith(".")) return `from ${JSON.stringify(resolve(dirname(SOURCE), spec))};`;
    return whole;
  });
}

export async function extractLive(): Promise<string> {
  // Inside the repo, so its bare imports (solid-js) resolve from the repo's node_modules.
  const dir = join(REPO, "node_modules/.cache/sova-wire-extract");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `live.test.${process.pid}.ts`);
  writeFileSync(file, rewritten(readFileSync(SOURCE, "utf8")));
  try {
    await import(file);
  } finally {
    rmSync(file, { force: true });
  }
  const { recorded } = await import("./live-calls.ts");
  // A test that makes several stores (one per ordering it tries) gives several sequences: #1, #2, … in order.
  const count = new Map<string, number>();
  for (const s of recorded) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const named = recorded.map((s) => {
    const k = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, k);
    return { name: count.get(s.name)! > 1 ? `${s.name} #${k}` : s.name, calls: s.calls };
  });
  return `[\n${named.map((s) => `  ${JSON.stringify(s)}`).join(",\n")}\n]\n`;
}

if (import.meta.main) {
  const text = await extractLive();
  if (process.argv.includes("--check")) {
    const same = readFileSync(LIVE_INPUTS, "utf8") === text;
    console.log(same ? "[wire] inputs/live-test.json: as extracted" : "[wire] inputs/live-test.json differs from a fresh extraction");
    process.exit(same ? 0 : 1);
  }
  mkdirSync(dirname(LIVE_INPUTS), { recursive: true });
  writeFileSync(LIVE_INPUTS, text);
  console.log(`[wire] ${JSON.parse(text).length} sequences → ${LIVE_INPUTS}`);
}
