// Checks the built site in .sova/marketing/site/_site/ before anyone publishes it.
//
//   (cd .sova/marketing/site && npm run build)
//   PW_PORT=<your browser> node .sova/marketing/playbooks/doc-site/check-site.mjs
//
// 1. Serves _site/ under the base path from brand.json with a builtins-only static server.
// 2. Crawls every internal link from the home page: each must answer 200. A stylesheet, script,
//    image or font from another origin is a failure (no CDN); links out to other sites are fine.
//    Every page's <html> must carry visual.defaultTheme as data-theme ("system": none at all).
// 3. Checks the palette's text pairs reach 4.5:1 in both themes, accentInk on accent included.
// 4. With visual.weights set, no font-weight outside it may appear in the built CSS.
// 5. Opens every page at 475, 933 and 1280 px in light and dark. With a fixed defaultTheme it
//    first proves the reader's system setting is ignored (the page is the brand's theme under
//    both), then sets data-theme to render the other theme too; with "system" the system setting
//    picks it. Each render: no horizontal overflow, the page background is that theme's `bg`,
//    the primary action's text is `accentInk` on `accent`, every text's computed weight is in
//    visual.weights, no request leaves the local server, no page errors. A full-page screenshot
//    of each lands in site/_check/ (gitignored) for you to look at.
// Prints a JSON summary; exits 1 on any failure.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { brand, connect, MARKETING, run, sizeTo } from "../../lib/pw.mjs";

const SITE = path.join(MARKETING, "site");
const BUILT = path.join(SITE, "_site");
const SHOTS = path.join(SITE, "_check");
const WIDTHS = [475, 933, 1280];
const SCHEMES = ["light", "dark"];
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain", ".xml": "application/xml", ".webm": "video/webm", ".mp4": "video/mp4" };

function contrast(a, b) {
  const lum = (h) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** One theme's colours: accent and accentInk are per theme, never shared. */
const colours = (b, scheme) => b.visual.palette[scheme];

/** Every font-weight the built CSS sets (inline <style> included), outside @font-face ranges. */
function cssWeights(text) {
  const out = new Set();
  const plain = text.replace(/@font-face\s*\{[^}]*\}/g, "");
  for (const m of plain.matchAll(/(?:font-weight\s*:|--w-[\w-]+\s*:)\s*(\d{3})\b/g)) out.add(m[1]);
  for (const m of plain.matchAll(/(?:^|[;{\s])font\s*:\s*(\d{3})\s/g)) out.add(m[1]);
  for (const m of plain.matchAll(/font-weight\s*:\s*(bold|bolder|lighter)\b/g)) out.add(m[1]);
  return out;
}
const walkFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

function serve(base) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://local").pathname);
    if (!pathname.startsWith(base)) return res.writeHead(404).end();
    let file = path.join(BUILT, pathname.slice(base.length));
    if (file !== BUILT && !file.startsWith(BUILT + path.sep)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Every URL a page refers to, and whether it is a resource the page loads (vs a link out). */
function references(html) {
  const refs = [];
  for (const tag of html.matchAll(/<(a|link|img|script|source|video|audio|iframe)\b[^>]*>/gi)) {
    const name = tag[1].toLowerCase();
    for (const attr of tag[0].matchAll(/\s(href|src|srcset|poster)="([^"]*)"/gi)) {
      const urls = attr[1].toLowerCase() === "srcset" ? attr[2].split(",").map((s) => s.trim().split(/\s+/)[0]) : [attr[2]];
      for (const url of urls) if (url) refs.push({ url, resource: name !== "a" });
    }
  }
  return refs;
}

run(async () => {
  if (!fs.existsSync(path.join(BUILT, "index.html"))) throw new Error("no .sova/marketing/site/_site/index.html; run `npm run build` in .sova/marketing/site first");
  const b = brand();
  const base = b.facts.siteUrl ? new URL(b.facts.siteUrl).pathname : "/";
  const theme = b.visual.defaultTheme;
  const allowed = b.visual.weights?.map(String) ?? null;
  const failures = [];
  if (!["dark", "light", "system"].includes(theme)) failures.push(`brand: visual.defaultTheme is ${JSON.stringify(theme)}, expected dark, light or system`);

  for (const scheme of SCHEMES)
    for (const [label, fg, bg] of [
      ["ink on bg", "ink", "bg"],
      ["muted on bg", "muted", "bg"],
      ["accent on bg (links)", "accent", "bg"],
      ["accentInk on accent (primary action)", "accentInk", "accent"],
    ]) {
      const p = colours(b, scheme);
      const r = contrast(p[fg], p[bg]);
      if (r < 4.5) failures.push(`contrast ${scheme}: ${label} is ${r.toFixed(2)}:1, below 4.5:1`);
    }

  if (allowed) {
    const found = new Set();
    for (const file of walkFiles(BUILT).filter((f) => /\.(css|html)$/.test(f))) for (const w of cssWeights(fs.readFileSync(file, "utf8"))) found.add(w);
    for (const w of found) if (!allowed.includes(w)) failures.push(`weight: the built site sets font-weight ${w}, which is not in visual.weights [${allowed.join(", ")}]`);
  }

  const server = await serve(base);
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    // Crawl.
    const pages = [];
    const seen = new Set([base]);
    const queue = [base];
    const external = new Set();
    while (queue.length) {
      const url = queue.shift();
      const res = await fetch(origin + url);
      if (res.status !== 200) {
        failures.push(`broken: ${url} answered ${res.status}`);
        continue;
      }
      if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) continue;
      pages.push(url);
      const html = await res.text();
      const attr = /<html\b[^>]*\sdata-theme="([^"]*)"/i.exec(html)?.[1] ?? null;
      if (attr !== (theme === "system" ? null : theme)) failures.push(`theme: ${url} has <html data-theme=${JSON.stringify(attr)}>, expected ${theme === "system" ? "none (defaultTheme is system)" : JSON.stringify(theme)}`);
      for (const ref of references(html)) {
        if (/^(mailto:|tel:|data:|#)/i.test(ref.url)) continue;
        const target = new URL(ref.url, origin + url);
        if (target.origin !== origin) {
          if (ref.resource) failures.push(`external resource on ${url}: ${ref.url} (no CDN: ship it with the site)`);
          else external.add(target.href);
          continue;
        }
        const key = target.pathname;
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(key);
        }
      }
    }

    // Render.
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    browser = await connect();
    // A fresh context, so nothing cached from an earlier run can hide a failing request.
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    const offsite = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Both are needed: some failed loads (the browser's own /favicon.ico) never surface as a
    // response event, only as a console error, whose location names the URL.
    page.on("console", (m) => m.type() === "error" && errors.push(`${m.text()}${m.location()?.url ? ` (${m.location().url})` : ""}`));
    page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} for ${r.url()}`));
    page.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith(origin) && !u.startsWith("data:")) offsite.push(u);
    });
    const rendered = [];
    const bgNow = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    for (const scheme of SCHEMES) {
      // The reader's system setting. With a fixed defaultTheme it must change nothing.
      await page.emulateMedia({ colorScheme: scheme });
      const c = colours(b, scheme);
      for (const url of pages) {
        await page.goto(origin + url, { waitUntil: "load" });
        if (theme === "dark" || theme === "light") {
          const bg = await bgNow();
          const want = rgb(colours(b, theme).bg);
          if (bg !== want) failures.push(`theme: ${url} with the system set to ${scheme} has background ${bg}, expected ${want} (${theme}.bg: the brand's theme, whatever the system says)`);
          // Now render this pass's theme, the way a future toggle would.
          await page.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
        }
        for (const width of WIDTHS) {
          await sizeTo(page, width, 900); // after the navigation, and read back
          await page.evaluate(() => document.fonts.ready);
          const m = await page.evaluate(() => {
            const primary = document.querySelector(".primary");
            const ps = primary && getComputedStyle(primary);
            const weights = new Set();
            for (const el of document.body.querySelectorAll("*"))
              if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) weights.add(getComputedStyle(el).fontWeight);
            return { overflow: document.documentElement.scrollWidth - innerWidth, bg: getComputedStyle(document.documentElement).backgroundColor, primary: ps && { color: ps.color, bg: ps.backgroundColor }, weights: [...weights] };
          });
          const where = `${url} @${width} ${scheme}`;
          if (m.overflow > 0) failures.push(`overflow: ${where} is ${m.overflow}px wider than the viewport`);
          if (m.bg !== rgb(c.bg)) failures.push(`theme: ${where} background is ${m.bg}, expected ${rgb(c.bg)} (${scheme}.bg)`);
          if (m.primary && (m.primary.color !== rgb(c.accentInk) || m.primary.bg !== rgb(c.accent)))
            failures.push(`accent: ${where} primary action is ${m.primary.color} on ${m.primary.bg}, expected ${rgb(c.accentInk)} (${scheme}.accentInk) on ${rgb(c.accent)} (${scheme}.accent)`);
          if (allowed) for (const w of m.weights) if (!allowed.includes(w)) failures.push(`weight: ${where} renders text at weight ${w}, not in visual.weights [${allowed.join(", ")}]`);
          const file = `${(url.slice(base.length).replace(/\/$/, "") || "home").replace(/[^a-z0-9]+/gi, "-")}-${width}-${scheme}.png`;
          await page.screenshot({ path: path.join(SHOTS, file), fullPage: true });
          rendered.push(file);
        }
      }
    }
    await context.close();
    for (const e of [...new Set(errors)]) failures.push(`page error: ${e}`);
    for (const u of new Set(offsite)) failures.push(`request left the site: ${u}`);

    console.log(JSON.stringify({ base, theme, weights: allowed ?? "not restricted (no visual.weights)", pages, linksOut: [...external].sort(), screenshots: `${path.relative(process.cwd(), SHOTS)}/ (${rendered.length} files)`, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    server.close();
  }
});
