import { launchTourBrowser } from "./browser";

// Deliberately no application request interception here: b1 proves the OS boundary, not consent.
const browser = await launchTourBrowser(process.argv[2]);
console.log("browser-ready");
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const target = process.argv[3]!;
  const mode = process.argv[4] ?? "navigation";
  let refused = false;
  if (mode === "navigation") {
    try {
      const response = await page.goto(target, { timeout: 5000 });
      refused = !response || response.status() >= 400;
    } catch { refused = true; }
  } else {
    const virtual = "https://tour-probe.invalid/";
    await page.route(virtual, async (route) => {
      if (mode === "redirect") await route.fulfill({ status: 302, headers: { location: target }, body: "" });
      else await route.fulfill({ contentType: "text/html", body: `<img src=${JSON.stringify(target)}><script>window.done=false;fetch(${JSON.stringify(target)},{mode:'no-cors'}).then(()=>window.done=true,()=>window.done=true)</script>` });
    });
    if (mode === "redirect") {
      try { const response = await page.goto(virtual, { timeout: 5000 }); refused = !response || response.status() >= 400; } catch { refused = true; }
    } else {
      await page.goto(virtual);
      await page.waitForFunction(() => (window as unknown as { done: boolean }).done, undefined, { timeout: 5000 });
      refused = await page.locator("img").evaluate((el) => !(el as HTMLImageElement).naturalWidth);
    }
  }
  console.log(JSON.stringify({ refused }));
} finally { await browser.close(); }
