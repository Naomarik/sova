// The confined child that draws a chat's pasted images: the darkroom on its own, with no page and no network.
// Reads one JSON job per line from stdin, writes one JSON result per line to stdout, then exits when stdin closes.
import { createInterface } from "node:readline";
import { launchTourBrowser } from "./browser";
import { openDarkroom, sniffImage } from "./page-capture";

const MAX_LINE = 12 * 1024 * 1024;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

const reader = lines[Symbol.asyncIterator]();
// The first line says which browser: macOS's server picks it, since this child's environment can't.
const config = JSON.parse(String((await reader.next()).value ?? "{}")) as { browser?: unknown };
const browser = await launchTourBrowser(typeof config.browser === "string" ? config.browser : undefined);
const darkroom = await openDarkroom(browser);
send({ type: "ready" });
try {
  for (let next = await reader.next(); !next.done; next = await reader.next()) {
    const line = String(next.value);
    if (line.length > MAX_LINE) { send({ error: "too large" }); continue; }
    const job = JSON.parse(line) as { i?: unknown; base64?: unknown };
    if (!Number.isInteger(job.i) || typeof job.base64 !== "string") { send({ error: "bad job" }); continue; }
    const bytes = Buffer.from(job.base64, "base64");
    const kind = sniffImage(bytes);
    if (!kind) { send({ i: job.i, error: "It isn't an image." }); continue; }
    try {
      const d = await darkroom.develop(bytes, kind.mime, { w: 512, h: 512 });
      send({ i: job.i, width: d.width, height: d.height, full: { base64: d.full.bytes.toString("base64"), w: d.full.w, h: d.full.h }, small: { base64: d.small.bytes.toString("base64"), w: d.small.w, h: d.small.h }, describe: { base64: d.describe.bytes.toString("base64"), w: d.describe.w, h: d.describe.h } });
    } catch { send({ i: job.i, error: "It couldn't be drawn." }); }
  }
} finally {
  await darkroom.close().catch(() => {});
  await browser.close().catch(() => {});
}
process.exit(0);
