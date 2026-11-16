#!/usr/bin/env node
// The A/B cycle's collage: ONE image with every cycle as a row and each arm's result side by side,
// master's Round 0 first, each picture labelled with its arm, what changed, and the case's verdict and
// the arm's pass rate. Saves collage.png and collage.html in the campaign folder. Draws through Sova's
// own playwright-core and a local Chromium; with no browser, ImageMagick's montage (no labels' detail).
//
//   node collage.mjs <campaign> [--case <id>] [--model m@effort] [--rounds 0,1,2] [--extra "Label=path.png" ...]
//
// --case: the case shown in every cell (default: the first case whose verdict differs between arms, else
// the first case). --model: the test model shown (default the first). --extra: more pictures, such as
// the playbook card at key moments, in a last row (repeat the flag, or join with ";").
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { args, campaign, die, launchBrowser, listDir, modelText, parseModel, readJson, slug } from "./lib.mjs";

const argv = process.argv.slice(2);
// --extra may repeat: gather every one before the generic reader keeps the last.
const extras = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--extra" && argv[i + 1]) extras.push(...argv[i + 1].split(";"));
const { pos, opt } = args(argv);
if (!pos[0]) die("usage: collage.mjs <campaign> [--case id] [--model m@effort] [--rounds 0,1] [--extra \"Label=path.png\"]", 3);
const K = campaign(pos[0]);
const model = opt.model ? parseModel(opt.model) : K.models()[0];
const ledger = K.ledger();
const roundNs = opt.rounds ? String(opt.rounds).split(",").map(Number) : listDir(join(K.W, "rounds")).map(Number).filter((x) => Number.isInteger(x)).sort((a, b) => a - b);
if (!roundNs.length) die("no rounds yet", 3);

const verdict = (n, a, id) => {
  const g = K.grade(n, a, model, id);
  return existsSync(g) ? (readJson(g).pass ? "pass" : "fail") : "not graded";
};

// The case to show: one where the arms disagree says the most.
let caseId = typeof opt.case === "string" ? opt.case : null;
if (!caseId) {
  const ids = K.cases().filter((k) => k.group !== "sealed").map((k) => k.id);
  caseId =
    ids.find((id) => {
      const vs = new Set();
      for (const n of roundNs) for (const a of Object.keys(K.arms(n))) vs.add(verdict(n, a, id));
      vs.delete("not graded");
      return vs.size > 1;
    }) ?? ids[0];
}

const rows = roundNs.map((n) => {
  const arms = K.arms(n);
  const row = ledger.find((r) => r.round === n);
  return {
    title: n === 0 ? "Round 0 · master" : `Cycle ${n}`,
    cells: Object.entries(arms).map(([a, arm]) => ({
      label: `${a}${arm.baseline ? " · master" : ""}${row?.best === a ? " · best" : ""}`,
      sub: `${arm.change ?? arm.label ?? ""}`.slice(0, 120),
      tag: `${caseId}: ${verdict(n, a, caseId)} · round ${row?.arms?.[a]?.rate ?? "-"}%`,
      img: K.shot(n, a, model, caseId),
    })),
  };
});
if (extras.length)
  rows.push({
    title: "Key moments",
    cells: extras.map((e) => {
      const eq = e.indexOf("=");
      return { label: eq > 0 ? e.slice(0, eq) : e, sub: "", tag: "", img: eq > 0 ? e.slice(eq + 1) : e };
    }),
  });

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dataUrl = (p) => (existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString("base64")}` : null);
const cols = Math.max(...rows.map((r) => r.cells.length));
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:20px;font:14px/1.4 system-ui,sans-serif;color:#182028;background:#e9edf0}
h1{font-size:18px;margin:0 0 4px}.meta{color:#55606b;margin:0 0 16px}
.row{display:grid;grid-template-columns:120px repeat(${cols},1fr);gap:12px;margin-bottom:12px;align-items:start}
.rt{font-weight:700;padding-top:6px}.cell{background:white;border:1px solid #aab4be;border-radius:8px;padding:8px;overflow:hidden}
.l{font-weight:700}.s{color:#55606b;font-size:12px;min-height:16px}.t{font-size:12px;margin:2px 0 6px}
.pass{color:#1d7a3a}.fail{color:#b3261e}
img{display:block;width:100%;height:auto;border:1px solid #dde2e7;border-radius:4px}.none{height:120px;display:flex;align-items:center;justify-content:center;color:#8a949e;background:#f7f8fa;border-radius:4px}
</style></head><body>
<h1>${esc(K.c.subject ?? "A/B campaign")}</h1>
<p class="meta">${esc(`Case ${caseId} on ${modelText(model)}. Each row is a cycle; each picture is one arm's reply. Master is Round 0, measured once.`)}</p>
${rows
  .map(
    (r) =>
      `<div class="row"><div class="rt">${esc(r.title)}</div>${r.cells
        .map((c) => {
          const src = dataUrl(c.img);
          const cls = c.tag.includes(": pass") ? "pass" : c.tag.includes(": fail") ? "fail" : "";
          return `<div class="cell"><div class="l">${esc(c.label)}</div><div class="s">${esc(c.sub)}</div><div class="t ${cls}">${esc(c.tag)}</div>${src ? `<img src="${src}">` : `<div class="none">no screenshot</div>`}</div>`;
        })
        .join("")}</div>`,
  )
  .join("\n")}
</body></html>`;
const htmlFile = join(K.W, "collage.html");
const pngFile = join(K.W, "collage.png");
writeFileSync(htmlFile, html);

let made = false;
try {
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ viewport: { width: 380 * cols + 180, height: 200 }, deviceScaleFactor: 1 });
    await ctx.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    await page.setContent(html);
    await page.evaluate(async () => {
      await Promise.all([...document.images].map((im) => im.decode().catch(() => {})));
    });
    await page.screenshot({ path: pngFile, fullPage: true });
    await ctx.close();
    made = true;
  } finally {
    await browser.close();
  }
} catch (e) {
  console.error(`browser collage failed (${String(e.message ?? e).split("\n")[0]}); trying ImageMagick`);
}
if (!made) {
  const imgs = rows.flatMap((r) => r.cells.map((c) => c.img)).filter((p) => existsSync(p));
  const tool = ["magick", "montage"].find((t) => spawnSync(t, ["-version"]).status === 0);
  if (tool && imgs.length) {
    const r = spawnSync(tool, [...(tool === "magick" ? ["montage"] : []), ...imgs, "-tile", `${cols}x`, "-geometry", "+8+8", "-background", "#e9edf0", pngFile]);
    made = r.status === 0;
  }
}
console.log(made ? `collage: ${pngFile} (and ${htmlFile}); case ${caseId}, ${modelText(model)}, ${rows.length} rows` : `no image made; open ${htmlFile}`);
process.exit(made ? 0 : 1);
