// Captures the screenshots named in a plan, from the running project, into
// .sova/marketing/assets/screenshots/, and writes manifest.json there naming what each shows.
//
//   PW_PORT=<your browser> node .sova/marketing/playbooks/demo-screenshots/capture.mjs \
//     [--plan .sova/marketing/assets/screenshots/plan.json]
//
// The plan's fields are documented in PLAYBOOK.md beside this file. For every shot: a fresh tab,
// the colour scheme emulated, navigate, size the viewport AFTER navigating and read innerWidth
// back, run `prepare`, size and read back again (prepare may navigate), wait for fonts, shoot.
// A shot whose page threw an error, or whose width did not take, fails; the others still run.
// The manifest lists only shots that succeeded in this run. Exit 1 if any failed.
import fs from "node:fs";
import path from "node:path";
import { brand, connect, flags, MARKETING, revision, run, sizeTo } from "../../lib/pw.mjs";

const OUT = path.join(MARKETING, "assets", "screenshots");
const FIELDS = { file: "string", path: "string", width: "number", height: "number", colorScheme: "string", prepare: "string|null", shows: "string", alt: "string", hero: "boolean", fullPage: "boolean" };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function checkPlan(plan) {
  const errs = [];
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.shots) || !plan.shots.length) return ["plan must be { \"baseUrl\": <url or null>, \"shots\": [ … at least one … ] }"];
  for (const k of Object.keys(plan)) if (!["baseUrl", "shots"].includes(k)) errs.push(`${k}: not a plan field`);
  if (plan.baseUrl !== null && plan.baseUrl !== undefined && !/^https?:\/\//.test(plan.baseUrl)) errs.push("baseUrl: must be an http(s) URL or null (null = brand.json project.demoUrl)");
  const files = new Set();
  plan.shots.forEach((s, i) => {
    const at = (k, m) => errs.push(`shots[${i}]${k ? `.${k}` : ""}: ${m}`);
    for (const k of Object.keys(s)) if (!(k in FIELDS)) at(k, "not a shot field");
    for (const [k, type] of Object.entries(FIELDS)) {
      if (!(k in s)) at(k, "is missing");
      else if (!type.split("|").some((t) => (t === "null" ? s[k] === null : typeof s[k] === t))) at(k, `must be ${type}`);
    }
    if (typeof s.file === "string" && !/^[a-z0-9][a-z0-9-]*\.png$/.test(s.file)) at("file", "must be a lowercase name ending .png, no folders");
    if (files.has(s.file)) at("file", `repeats ${s.file}`);
    files.add(s.file);
    if (!["light", "dark"].includes(s.colorScheme)) at("colorScheme", 'must be "light" or "dark"');
    if (typeof s.width === "number" && (s.width < 320 || s.width > 3840)) at("width", "must be 320–3840");
    for (const k of ["shows", "alt"]) if (typeof s[k] === "string" && !s[k].trim()) at(k, "must not be empty");
  });
  if (plan.shots.filter((s) => s.hero).length > 1) errs.push("shots: at most one shot may be the hero");
  return errs;
}

run(async () => {
  const opts = flags({ plan: "string" });
  const planFile = path.resolve(opts.plan ?? path.join(OUT, "plan.json"));
  if (!fs.existsSync(planFile)) throw new Error(`no plan at ${planFile}; write one first (see plan.example.json beside this script)`);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const errs = checkPlan(plan);
  if (errs.length) throw new Error(`the plan is invalid:\n  - ${errs.join("\n  - ")}`);
  const baseUrl = plan.baseUrl ?? brand().project.demoUrl;
  const rev = revision();
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await connect();
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const done = [];
  const failed = [];
  try {
    for (const shot of plan.shots) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.emulateMedia({ colorScheme: shot.colorScheme });
        const res = await page.goto(new URL(shot.path, baseUrl).href, { waitUntil: "load" });
        if (res && !res.ok()) throw new Error(`${res.url()} answered ${res.status()}`);
        await sizeTo(page, shot.width, shot.height);
        if (shot.prepare) await new AsyncFunction("page", shot.prepare)(page);
        await sizeTo(page, shot.width, shot.height);
        await page.evaluate(() => document.fonts.ready);
        if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
        await page.screenshot({ path: path.join(OUT, shot.file), fullPage: shot.fullPage });
        const { shows, alt, file, width, height, colorScheme, hero } = shot;
        done.push({ file, shows, alt, url: page.url(), width, height, colorScheme, hero, revision: rev.sha, dirtyTree: rev.dirty, capturedAt: new Date().toISOString() });
        console.log(`captured ${path.relative(process.cwd(), path.join(OUT, file))}  ${width}x${height} ${colorScheme}  ${page.url()}`);
      } catch (err) {
        failed.push(shot.file);
        console.error(`FAILED  ${shot.file}: ${err.message.split("\n")[0]}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify({ note: "Written by capture.mjs from plan.json. Each shot is the real app at `revision`.", shots: done }, null, 2)}\n`);
  console.log(`${done.length} captured, ${failed.length} failed; manifest: ${path.relative(process.cwd(), path.join(OUT, "manifest.json"))}`);
  if (rev.dirty) console.log(`note: the working tree differs from ${rev.sha}; the manifest says so (dirtyTree: true).`);
  if (failed.length) process.exitCode = 1;
});
