// Renders a round's comparison.html in YOUR browser and asserts what the sheet promises.
//
//   PW_PORT=<your browser> node .sova/marketing/playbooks/logos/check-sheet.mjs --round .sova/marketing/assets/logos/round-1
//
// Asserts: each candidate SVG parses as XML in the browser; the sheet has exactly
// 12 marks per candidate (per theme: a 72px hero, 16/24/32px, a 32px accent, and a 32px tile in
// accentInk on accent), no [id], no mask/clipPath/use; zero resource requests (everything is
// data:); zero page errors; no horizontal overflow at 1280 or 475 px; each theme's panel
// background is that theme's bg and its tile is accentInk on accent; the lockup's computed weight
// and tracking are the ones typeSettings() resolved from brand.json; and, when brand.json names
// font files, that the wordmark face actually loaded. Values that were defaults, not the brand's,
// are listed under "defaults" in validation.json and printed. Writes comparison.png
// (1280, full page), comparison-475.png and validation.json into the round folder.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { brand, connect, flags, run, sizeTo } from "../../lib/pw.mjs";
import { readRound, typeSettings } from "./build-sheet.mjs";

const MARKS_PER_CANDIDATE = 12;
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

run(async () => {
  const opts = flags({ round: "string" });
  if (!opts.round) throw new Error("--round <folder> is required");
  const dir = path.resolve(opts.round);
  const sheet = path.join(dir, "comparison.html");
  if (!fs.existsSync(sheet)) throw new Error(`no comparison.html in ${dir}; run build-sheet.mjs first`);
  const round = readRound(dir);
  const b = brand();
  const type = typeSettings(b);
  const expected = round.candidates.length * MARKS_PER_CANDIDATE;
  const failures = [];

  const browser = await connect();
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("request", (r) => {
      if (!r.url().startsWith("data:") && r.url() !== pathToFileURL(sheet).href) requests.push(r.url());
    });
    await page.goto(pathToFileURL(sheet).href, { waitUntil: "load" });
    await sizeTo(page, 1280, 1000);
    await page.evaluate(() => document.fonts.ready);

    const sources = round.candidates.map((c) => [c.slug, fs.readFileSync(path.join(dir, `${c.slug}.svg`), "utf8")]);
    const xml = await page.evaluate((list) => list.map(([slug, src]) => {
      const doc = new DOMParser().parseFromString(src, "image/svg+xml");
      return { slug, ok: !doc.querySelector("parsererror") && doc.documentElement.localName === "svg" };
    }), sources);
    for (const x of xml) if (!x.ok) failures.push(`${x.slug}.svg does not parse as SVG XML`);

    const desktop = await page.evaluate((family) => ({
      width: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      marks: document.querySelectorAll("svg").length,
      cards: document.querySelectorAll("section.card").length,
      ids: document.querySelectorAll("[id]").length,
      forbidden: document.querySelectorAll("mask, clipPath, use").length,
      resources: performance.getEntriesByType("resource").filter((r) => !r.name.startsWith("data:")).map((r) => r.name),
      // Not document.fonts.check(): it also answers true when no @font-face names the family at
      // all, so it can't tell the brand's face from a system fallback. Read the faces themselves.
      fontFaces: family ? [...document.fonts].filter((f) => f.family.replace(/^["']|["']$/g, "") === family).map((f) => f.status) : null,
      panels: [...document.querySelectorAll(".sample")].map((e) => {
        const tile = getComputedStyle(e.querySelector(".tile"));
        return { theme: e.dataset.theme, bg: getComputedStyle(e).backgroundColor, tileBg: tile.backgroundColor, tileInk: tile.color };
      }),
      lockup: [...document.querySelectorAll(".hero .word")].map((e) => {
        const st = getComputedStyle(e);
        return { weight: st.fontWeight, letterSpacing: st.letterSpacing, fontSize: parseFloat(st.fontSize) };
      }),
    }), b.visual.fonts.files.length ? b.visual.fonts.sans : null);

    if (desktop.marks !== expected) failures.push(`${desktop.marks} marks on the sheet, expected exactly ${expected} (${round.candidates.length} candidates × ${MARKS_PER_CANDIDATE})`);
    if (desktop.cards !== round.candidates.length) failures.push(`${desktop.cards} candidate cards, expected ${round.candidates.length}`);
    if (desktop.ids) failures.push(`${desktop.ids} element(s) with an id`);
    if (desktop.forbidden) failures.push(`${desktop.forbidden} mask/clipPath/use element(s)`);
    if (desktop.overflow > 0) failures.push(`1280px: ${desktop.overflow}px horizontal overflow`);
    if (desktop.fontFaces && (!desktop.fontFaces.length || desktop.fontFaces.some((st) => st !== "loaded"))) failures.push(`the wordmark face ${b.visual.fonts.sans} did not load from the embedded files (faces: ${JSON.stringify(desktop.fontFaces)})`);
    for (const p of desktop.panels) {
      const pal = b.visual.palette[p.theme];
      if (p.bg !== rgb(pal.bg)) failures.push(`a ${p.theme} panel's background is ${p.bg}, expected ${rgb(pal.bg)}`);
      if (p.tileBg !== rgb(pal.accent) || p.tileInk !== rgb(pal.accentInk)) failures.push(`a ${p.theme} accent tile is ${p.tileInk} on ${p.tileBg}, expected accentInk ${rgb(pal.accentInk)} on accent ${rgb(pal.accent)}`);
    }
    // letter-spacing computes to px; "normal" stays "normal".
    const wantSpacing = (size) => (type.tracking === "normal" ? "normal" : `${Number((parseFloat(type.tracking || "0") * size).toFixed(2))}px`);
    for (const l of desktop.lockup) {
      if (l.weight !== type.weight) failures.push(`the lockup's font-weight is ${l.weight}, expected ${type.weight}`);
      const want = wantSpacing(l.fontSize);
      const got = l.letterSpacing === "normal" ? "normal" : `${Number(parseFloat(l.letterSpacing).toFixed(2))}px`;
      if (got !== want && !(want === "0px" && got === "normal")) failures.push(`the lockup's letter-spacing is ${l.letterSpacing}, expected ${want} (${type.tracking} at ${l.fontSize}px)`);
    }
    if (!desktop.lockup.length) failures.push("no lockup (.hero .word) on the sheet");
    await page.screenshot({ path: path.join(dir, "comparison.png"), fullPage: true });

    await sizeTo(page, 475, 950);
    const folded = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth }));
    if (folded.overflow > 0) failures.push(`475px: ${folded.overflow}px horizontal overflow`);
    await page.screenshot({ path: path.join(dir, "comparison-475.png"), fullPage: true });
    await page.close();

    const external = [...new Set([...requests, ...desktop.resources])];
    for (const u of external) failures.push(`request for ${u} (the sheet must be self-contained)`);
    for (const e of errors) failures.push(`page error: ${e}`);

    const lockup = { weight: type.weight, tracking: type.tracking, weights: type.weights, source: b.visual.wordmark ? "visual.wordmark" : "defaults" };
    const validation = { sheet: path.relative(process.cwd(), sheet), candidates: round.candidates.map((c) => c.slug), expectedMarks: expected, lockup, defaults: type.notes, desktop: { ...desktop, lockup: desktop.lockup.length, resources: desktop.resources.length }, folded, xml, errors, failures, method: "Sova Playwright skill over CDP; viewport set after navigation and read back" };
    fs.writeFileSync(path.join(dir, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`);
    console.log(JSON.stringify(validation, null, 2));
    for (const n of type.notes) console.log(`default: ${n}`);
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
});
