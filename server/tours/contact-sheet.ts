import type { Browser, Page } from "playwright-core";
import type { TourStep } from "../../shared/tour";

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Every cell is represented, including reference views and unavailable sizes; 24 per sheet. */
export async function createTourContactSheets(browser: Browser, steps: TourStep[], assets: ReadonlyMap<string, Uint8Array>, save: (file: string, bytes: Buffer) => void): Promise<string[]> {
  const cells = steps.flatMap(s => s.views.flatMap(v => v.kind === "reference" ? [{ label: `${s.n}. ${s.title} / ${v.title} — Reference`, text: v.reference ?? "", image: undefined }] : (["desktop", "phone"] as const).map(size => ({ label: `${s.n}. ${s.title} / ${v.title} / ${size}`, text: v.captures[size] ? v.note : v.unavailableReason ?? "Unavailable", image: v.captures[size]?.image }))));
  const context = await browser.newContext({ viewport: { width: 1440, height: 2400 }, deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false });
  // Sheets are assembled offline from already-masked pictures only.
  await context.route("**/*", route => route.abort());
  const page: Page = await context.newPage();
  const files: string[] = [];
  try {
    for (let start = 0; start < cells.length; start += 24) {
      const part = cells.slice(start, start + 24);
      await page.setContent(`<html><head><style>*{box-sizing:border-box}body{margin:0;padding:16px;font:15px sans-serif;color:#182028;background:#e9edf0}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.cell{background:white;border:1px solid #aab4be;padding:8px;height:370px;overflow:hidden}.label{font-weight:bold;margin-bottom:8px;overflow-wrap:anywhere}img{display:block;width:100%;height:260px;object-fit:contain;background:#f7f8fa}.text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:hidden}</style></head><body><div class="grid">${part.map(c => `<div class="cell"><div class="label">${escape(c.label)}</div>${c.image ? `<img src="data:image/png;base64,${Buffer.from(assets.get(c.image)!).toString("base64")}">` : ""}<div class="text">${escape(c.text)}</div></div>`).join("")}</div></body></html>`);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(im => im.decode())); });
      const file = `overview-${files.length + 1}.png`;
      save(file, await page.screenshot({ fullPage: true, animations: "disabled" }));
      files.push(file);
    }
    return files;
  } finally { await context.close(); }
}
