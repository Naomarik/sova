// What a real page and a real peer see on the lab that is up, for when m10-versions times out.
// Needs what m10-versions needs. Prints; asserts nothing. Run by .sova's lab-run script, or:
//   LAB_STATE=… node scripts/mesh-lab/e2e/m10-diag.mjs a b
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostUrl, labTokenHeaders, laptopFetch } from "./lib.mjs";

const [host = "a", peer = "b"] = process.argv.slice(2);
const OUT = process.env.SHOTS ?? ".";
const PW = process.env.PLAYWRIGHT_MODULE;
if (!PW || !existsSync(PW)) throw new Error(`Playwright not found: ${PW}`);
const { chromium, version } = await import(pathToFileURL(PW).href);
const dump = async (path) => {
  const r = await laptopFetch(host, path);
  const text = await r.text();
  console.log(`--- GET ${path} -> ${r.status} ${JSON.stringify(Object.fromEntries(r.headers))}\n${text.slice(0, 1500)}`);
};
await dump("/");
await dump("/api/health");
// The page's own JS as a browser asks for it, and as a script does: the gate judges Origin (server/auth.ts).
const asset = /src="(\/assets\/[^"]+)"/.exec(await (await laptopFetch(host, "/")).text())?.[1];
for (const origin of [hostUrl(host), "http://127.0.0.1:4800", null, "http://127.0.0.1:4899"]) {
  const r = await laptopFetch(host, asset, { headers: origin ? { origin } : {} });
  console.log(`--- GET ${asset} origin ${origin} -> ${r.status} ${JSON.stringify(Object.fromEntries(r.headers))}${r.ok ? "" : ` ${await r.text()}`}`);
}
await dump("/api/mesh");
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_BIN });
console.log(`browser ${browser.version()} playwright ${version ?? ""}`);
for (const [label, headers] of [["with the token header", labTokenHeaders()], ["with no header", {}]]) {
  const ctx = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: headers, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => console.log(`console ${m.type()}: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => console.log(`pageerror: ${e.message.slice(0, 400)} ${(e.stack ?? "").slice(0, 400)}`));
  page.on("requestfailed", (r) => console.log(`requestfailed: ${r.url().slice(0, 140)} ${r.failure()?.errorText}`));
  page.on("response", (r) => console.log(`response ${r.status()} ${r.url().slice(0, 140)}`));
  console.log(`=== page ${label}`);
  const res = await page.goto(`${hostUrl(host)}/#/mesh`);
  console.log(`goto: ${res?.status()} ${page.url()}`);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch((e) => console.log(`networkidle: ${e.message.split("\n")[0]}`));
  await page.locator(`[data-testid="mesh-host-row"][data-host-id="${peer}"]`).waitFor({ timeout: 15000 }).catch((e) => console.log(`row: ${e.message.split("\n")[0]}`));
  console.log(`body: ${JSON.stringify((await page.locator("body").innerText()).slice(0, 800))}`);
  console.log(`html: ${(await page.content()).slice(0, 800)}`);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `diag-${label.replace(/\W+/g, "-")}.png`) });
  await ctx.close();
}
await browser.close();
