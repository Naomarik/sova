// `bun server/modes/tests/show.fixture.ts <case> [<json path, e.g. 3.calls.0.add>]`: a recording read back whole
// (its store references resolved), as JSON.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decode, GOLDEN_DIR } from "./store.fixture";

const [name, at] = process.argv.slice(2);
if (!name) throw new Error("usage: show.ts <case> [path]");
let v = decode(readFileSync(join(GOLDEN_DIR, `${name.replace(/\.json$/, "")}.json`), "utf8"));
for (const k of at ? at.split(".") : []) v = (v as Record<string, unknown>)[k];
console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
