import { chromium } from '/home/user/webapps/example-app/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
const browser = await chromium.connectOverCDP(`http://localhost:${process.env.PW_PORT}`);
try {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(new URL('./comparison.html', import.meta.url).href);
  await page.setViewportSize({width:1280,height:1250});
  await page.evaluate(() => document.fonts.ready);
  const check = await page.evaluate(() => ({url:location.href,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,fonts:document.fonts.status,svgs:document.querySelectorAll('svg').length,ids:document.querySelectorAll('[id]').length,resources:performance.getEntriesByType('resource').filter(r=>!r.name.startsWith('data:')).length}));
  if(check.width!==1280 || check.overflow || check.svgs!==32 || errors.length || check.resources) throw Error(JSON.stringify({check,errors}));
  const themes=await page.evaluate(()=>Array.from(document.querySelectorAll('.sample')).map(e=>({theme:e.dataset.theme,bg:getComputedStyle(e).backgroundColor,ink:getComputedStyle(e).color})));
  if(themes.some(t=>t.theme==='dark' && (t.bg!=='rgb(30, 30, 38)' || t.ink!=='rgb(242, 242, 246)'))) throw Error(JSON.stringify(themes));
  await page.screenshot({path:fileURLToPath(new URL('./comparison.png',import.meta.url)),fullPage:true});
  await page.setViewportSize({width:475,height:950});
  const folded=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}));
  if(folded.width!==475 || folded.overflow) throw Error(JSON.stringify(folded));
  console.log(JSON.stringify({desktop:check,themes,folded,errors},null,2));
  await page.close();
} finally { await browser.close(); }
