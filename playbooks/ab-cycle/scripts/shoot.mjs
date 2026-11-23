#!/usr/bin/env node
// The A/B cycle's screenshots: each result's chat, as the arm's test copy of Sova draws it, saved as
// rounds/<n>/shots/<arm>/<model>/<case>.png for the collage. Only results run in a test copy have a
// chat to show; for the others it draws the reply itself on a plain card, so every arm has a picture.
//
//   node shoot.mjs <campaign> --round <n> [--arms A,B] [--models m@effort,...] [--cases ids|groups] [--again]
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { args, campaign, die, launchBrowser, listDir, modelText, pickCases, readJson, slug, sleep } from "./lib.mjs";

const { pos, opt } = args();
if (!pos[0] || opt.round === undefined) die("usage: shoot.mjs <campaign> --round <n> [--arms A,B] [--models ...] [--cases ...] [--again]", 3);
const K = campaign(pos[0]);
const n = Number(opt.round);
const arms = K.arms(n);
const armIds = opt.arms ? String(opt.arms).split(",") : Object.keys(arms);
const models = K.models(opt.models);
const picked = new Set(pickCases(K.cases(), opt.cases).map((k) => k.id));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const browser = await launchBrowser();
let shot = 0;
const failed = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const a of armIds)
    for (const m of models)
      for (const f of listDir(join(K.round(n), "results", a, slug(m)))) {
        const id = f.replace(/\.json$/, "");
        if (!f.endsWith(".json") || !picked.has(id)) continue;
        const out = K.shot(n, a, m, id);
        if (existsSync(out) && !opt.again) continue;
        mkdirSync(dirname(out), { recursive: true });
        const r = readJson(join(K.round(n), "results", a, slug(m), f));
        try {
          if (r.session?.url) {
            await page.goto(r.session.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            // The transcript loads after the shell: wait for a reply row, then a paint or two.
            await page.getByText(String(r.reply ?? "").trim().split("\n")[0].slice(0, 40), { exact: false }).first().waitFor({ timeout: 20_000 }).catch(() => {});
            await sleep(800);
          } else {
            await page.setContent(`<html><body style="margin:0;background:#f6f7f9"><div id="card" style="width:1000px;padding:24px;font:15px/1.5 sans-serif;color:#182028;background:#f6f7f9"><div style="font-weight:600;margin-bottom:8px">${esc(`${a} · ${modelText(m)} · ${id}`)}</div><pre style="white-space:pre-wrap;background:white;border:1px solid #ccd3da;border-radius:8px;padding:16px;margin:0">${esc(r.error ? `Run failed: ${r.error}` : r.reply)}</pre></div></body></html>`);
          }
          // A fresh page can refuse its first capture before it has painted: once more after a frame.
          const take = () => (r.session?.url ? page.screenshot({ path: out }) : page.locator("#card").screenshot({ path: out }));
          await take().catch(async () => {
            await sleep(300);
            await take();
          });
          shot++;
        } catch (e) {
          failed.push(`${a}/${slug(m)}/${id}: ${String(e.message ?? e).split("\n")[0]}`);
        }
      }
  await ctx.close();
} finally {
  await browser.close();
}
console.log(`round ${n}: ${shot} screenshots${failed.length ? `; ${failed.length} failed: ${failed.slice(0, 3).join(" | ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
