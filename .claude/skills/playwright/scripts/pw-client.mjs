#!/usr/bin/env node
/**
 * Playwright CDP client - connects directly to browser via Chrome DevTools Protocol
 * 
 * No MCP SDK, no SSE transport - just Playwright connecting to a running browser.
 * 
 * Usage:
 *   node pw-client.mjs <command> [args...]
 * 
 * Commands:
 *   navigate <url>      - Go to URL
 *   snapshot [-g pat] [-C n] - Get page accessibility tree with element refs
 *   click <ref>         - Click element by ref (e.g., e5)
 *   hover <ref>         - Hover over element by ref
 *   type <ref> <text>   - Type into element by ref
 *   fill <json>         - Fill multiple form fields at once
 *   press <key>         - Press keyboard key (Enter, Escape, Tab, ArrowUp, etc.)
 *   select <ref> <val>  - Select dropdown option(s) by ref
 *   drag <start> <end>  - Drag from one element to another
 *   screenshot [file]   - Take screenshot (saves to file or outputs base64)
 *   pdf [file]          - Save page as PDF
 *   eval <js>           - Evaluate JavaScript
 *   run <code>          - Run arbitrary Playwright code with page context
 *   back                - Go back
 *   close               - Close page
 *   console             - Get console messages
 *   resize <w> <h>      - Resize viewport
 *   tabs <action>       - Tab management (list, new, close, select)
 *   click-xy <x> <y>    - Click at coordinates
 *   move-xy <x> <y>     - Move mouse to coordinates
 *   drag-xy <x1> <y1> <x2> <y2> - Drag from one position to another
 *   scroll <dir> [amt]  - Scroll the page (up/down/left/right, default 300px)
 *   wait <seconds>      - Wait for time
 *   wait text <text>    - Wait for text to appear
 *   wait gone <text>    - Wait for text to disappear
 *   dialog accept|dismiss - Handle dialogs (alert, confirm, prompt)
 *   upload <paths...>   - Upload files via file chooser
 *   network [--static]  - List network requests
 * 
 * Environment:
 *   PW_PORT   CDP port (read from .playwright-port by pw.sh wrapper)
 */

import { chromium } from 'playwright';
import sharp from 'sharp';

const SCREENSHOT_MAX_DIMENSION = 2000;

/**
 * Downscale a PNG buffer so no dimension exceeds SCREENSHOT_MAX_DIMENSION.
 * Returns the original buffer if already within limits.
 */
async function ensureMaxDimensions(buffer) {
  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;
  if (width <= SCREENSHOT_MAX_DIMENSION && height <= SCREENSHOT_MAX_DIMENSION) {
    return buffer;
  }
  const scale = Math.min(SCREENSHOT_MAX_DIMENSION / width, SCREENSHOT_MAX_DIMENSION / height);
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);
  const resized = await sharp(buffer)
    .resize(newWidth, newHeight, { fit: 'inside' })
    .png()
    .toBuffer();
  console.error(`Screenshot resized: ${width}x${height} -> ${newWidth}x${newHeight} (max ${SCREENSHOT_MAX_DIMENSION}px)`);
  return resized;
}

const CDP_PORT = process.env.PW_PORT;
if (!CDP_PORT) {
  console.error('Error: PW_PORT environment variable not set.');
  console.error('Use pw.sh wrapper which reads from .playwright-port');
  process.exit(1);
}
const CDP_URL = `http://localhost:${CDP_PORT}`;

/**
 * Get a YAML accessibility tree with refs (e.g. `[ref=e5]`), and register those
 * refs so `aria-ref=` locators resolve — which is what makes `click <ref>` work.
 *
 * THREE TIERS, because `page._snapshotForAI()` is a private method that comes
 * and goes. It is absent from 1.60.0 and 1.62.1, where calling it fails with
 * `page._snapshotForAI is not a function` and takes every ref-driven command
 * down with it. The `typeof` guard below is why that error can no longer
 * surface: it is never called on a build that lacks it.
 *
 *   1. `page._snapshotForAI()`            refs, incremental format
 *   2. `ariaSnapshot({ mode: 'ai' })`     refs, public API — the durable path
 *   3. `ariaSnapshot()`                   NO REFS, and it says so on stderr
 *
 * `mode: 'ai'` in tier 2 is the whole point of tier 2: the default mode renders
 * a readable tree with NO refs, so a fallback that omitted it would return
 * something `click` cannot use — worse than failing, because it looks fine.
 * It is what Playwright's own bundled MCP backend calls
 * (`lib/mcp/test/browserBackend.js`), and it registers refs the same way.
 *
 * Tier 3 exists for a build that rejects the `mode` option entirely. Its tree is
 * still worth printing, but every ref-driven command is dead there, so it warns
 * rather than degrading quietly.
 *
 * Ordered newest-private-first only because `_snapshotForAI` returns the
 * incremental format on versions that have it; where both work they agree.
 */
async function getAriaSnapshot(page) {
  if (typeof page._snapshotForAI === 'function') {
    const snapshot = await page._snapshotForAI();
    // Object format (1.58+ alpha) or plain string (1.56.x).
    return typeof snapshot === 'string' ? snapshot : snapshot.full;
  }

  try {
    return await page.locator('body').ariaSnapshot({ mode: 'ai' });
  } catch (err) {
    // `mode` rejected by this build. A tree without refs is still worth
    // printing, but say so — silently returning one is how `click e5` starts
    // failing with "ref not found" on a snapshot that never had any.
    const plain = await page.locator('body').ariaSnapshot();
    console.error(
      'Warning: this Playwright build supports neither _snapshotForAI() nor ' +
      "ariaSnapshot({mode:'ai'}), so the tree below carries NO refs and " +
      'click/type/hover by ref will not work. Drive the page by accessible ' +
      'name instead: pw.sh run \'await page.getByRole("button",{name:"…"}).click(); return 1\''
    );
    return plain;
  }
}

/**
 * Find and locate an element by ref using Playwright's aria-ref locator
 * The ref comes directly from the snapshot (e.g., e5, e10)
 * 
 * Note: We take a fresh snapshot first to ensure refs are registered and current.
 */
async function findElementByRef(page, ref) {
  // Take a fresh snapshot to register refs (required for aria-ref to work)
  await getAriaSnapshot(page);
  
  // Playwright has a special locator for aria refs from snapshots
  const locator = page.locator(`aria-ref=${ref}`);
  
  // Verify the element exists
  const count = await locator.count();
  if (count === 0) {
    throw new Error(`Element ref "${ref}" not found. Run "snapshot" to see available refs.`);
  }
  
  return locator.first();
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Playwright CDP Client

Usage:
  node pw-client.mjs <command> [args...]

Commands:
  navigate <url>           Go to URL
  snapshot [options]       Get page accessibility tree with element refs
    -g, --grep <pattern>   Filter snapshot by pattern (case-insensitive)
    -C, --context <N>      Lines of context around matches (default: 3)
  click <ref>              Click element by ref (e.g., e5)
  hover <ref>              Hover over element by ref
  type <ref> <text>        Type into element by ref
  fill <json>              Fill multiple form fields at once
                           JSON format: [{"ref":"e1","value":"hello"},...]
  press <key>              Press keyboard key (Enter, Escape, Tab, ArrowUp, etc.)
  select <ref> <values...> Select dropdown option(s) by ref
  drag <startRef> <endRef> Drag from one element to another
  screenshot [file]        Take screenshot (saves to file or outputs base64)
  pdf [file]               Save page as PDF (default: page-{timestamp}.pdf)
  eval <js>                Evaluate JavaScript in page context
  run <code>               Run arbitrary Playwright code with page context
                           Code is a function body: await page.click('x'); return 1;
  back                     Go back
  close                    Close page
  console [ms]             Get console messages (captures for ms, or reloads)
  resize <w> <h>           Resize viewport (e.g., resize 1920 1080)
  tabs list                List all tabs with index and URL
  tabs new [url]           Create new tab, optionally navigate to URL
  tabs close [index]       Close tab by index (or current if no index)
  tabs select <index>      Switch to tab by index

Coordinate Commands:
  click-xy <x> <y>              Click at coordinates
  move-xy <x> <y>               Move mouse to coordinates
  drag-xy <x1> <y1> <x2> <y2>   Drag from (x1,y1) to (x2,y2)
  scroll <dir> [amount]         Scroll page (up/down/left/right, default 300px)

Wait/Timing:
  wait <seconds>           Wait for specified time
  wait text <text>         Wait for text to appear on page
  wait gone <text>         Wait for text to disappear from page

Dialogs/Uploads/Network:
  dialog accept [text]     Accept next dialog (with optional prompt text)
  dialog dismiss           Dismiss next dialog
  upload <paths...>        Upload files via file chooser
  network [--static]       List network requests (--static includes static resources)

Environment:
  PW_PORT   CDP port (set by pw.sh from .playwright-port)

Examples:
  node pw-client.mjs navigate https://example.com
  node pw-client.mjs snapshot
  node pw-client.mjs snapshot --grep "login"
  node pw-client.mjs snapshot -g "button" -C 5
  node pw-client.mjs click e5
  node pw-client.mjs hover e3
  node pw-client.mjs type e3 "hello world"
  node pw-client.mjs fill '[{"ref":"e1","value":"user"},{"ref":"e2","value":"pass"}]'
  node pw-client.mjs press Enter
  node pw-client.mjs select e7 "Option 1" "Option 2"
  node pw-client.mjs drag e5 e10
  node pw-client.mjs screenshot page.png
  node pw-client.mjs pdf report.pdf
  node pw-client.mjs run "await page.click('button'); return await page.title();"
  node pw-client.mjs tabs list
  node pw-client.mjs tabs new https://google.com
  node pw-client.mjs tabs select 0
  node pw-client.mjs click-xy 100 200
  node pw-client.mjs move-xy 150 300
  node pw-client.mjs drag-xy 100 200 300 400
  node pw-client.mjs scroll down 500
  node pw-client.mjs wait 2
  node pw-client.mjs wait text "Loading complete"
  node pw-client.mjs wait gone "Please wait..."
  node pw-client.mjs dialog accept
  node pw-client.mjs dialog accept "my input"
  node pw-client.mjs upload /path/to/file.pdf
  node pw-client.mjs network
`);
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  let browser;
  try {
    // Connect to running browser via CDP
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error(`Error: Cannot connect to browser at ${CDP_URL}`);
    console.error('Make sure the browser is running with CDP enabled.');
    console.error(`  ./start-browser.sh  (or: chromium --remote-debugging-port=${CDP_PORT})`);
    process.exit(1);
  }

  try {
    // Get default context and page, or create one
    const contexts = browser.contexts();
    let context = contexts[0];
    if (!context) {
      context = await browser.newContext();
    }
    
    let pages = context.pages();
    let page = pages[0];
    if (!page) {
      page = await context.newPage();
    }

    switch (command) {
      case 'navigate': {
        const url = commandArgs[0];
        if (!url) {
          console.error('Usage: navigate <url>');
          process.exit(1);
        }
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        console.log(`Navigated to: ${page.url()}`);
        break;
      }

      case 'snapshot': {
        // Parse optional grep/context arguments
        let grepPattern = null;
        let contextLines = 3;
        
        for (let i = 0; i < commandArgs.length; i++) {
          const arg = commandArgs[i];
          if (arg === '--grep' || arg === '-g') {
            grepPattern = commandArgs[i + 1];
            i++;
          } else if (arg === '--context' || arg === '-C') {
            contextLines = parseInt(commandArgs[i + 1]) || 3;
            i++;
          }
        }
        
        const snapshot = await getAriaSnapshot(page);
        
        if (!snapshot) {
          console.log('No accessibility tree available');
          break;
        }
        
        // If no grep pattern, output full snapshot
        if (!grepPattern) {
          console.log(snapshot);
          break;
        }
        
        // Apply grep filtering
        const lines = snapshot.split('\n');
        const pattern = grepPattern.toLowerCase();
        
        // Find all matching line indices
        const matchingIndices = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(pattern)) {
            matchingIndices.push(i);
          }
        }
        
        if (matchingIndices.length === 0) {
          console.log(`No matches found for: "${grepPattern}"`);
          break;
        }
        
        // Build ranges with context, merging overlapping ranges
        const ranges = [];
        for (const idx of matchingIndices) {
          const start = Math.max(0, idx - contextLines);
          const end = Math.min(lines.length - 1, idx + contextLines);
          
          // Check if this range overlaps with the last one
          if (ranges.length > 0 && start <= ranges[ranges.length - 1].end + 1) {
            // Merge with previous range
            ranges[ranges.length - 1].end = end;
            ranges[ranges.length - 1].matchIndices.push(idx);
          } else {
            ranges.push({ start, end, matchIndices: [idx] });
          }
        }
        
        // Output with separators between non-contiguous sections
        const outputParts = [];
        for (const range of ranges) {
          const sectionLines = [];
          for (let i = range.start; i <= range.end; i++) {
            sectionLines.push(lines[i]);
          }
          outputParts.push(sectionLines.join('\n'));
        }
        
        console.log(outputParts.join('\n--\n'));
        console.error(`\n[${matchingIndices.length} match(es) for "${grepPattern}"]`);
        break;
      }

      case 'click': {
        const ref = commandArgs[0];
        if (!ref) {
          console.error('Usage: click <ref>');
          console.error('Run "snapshot" first to get element refs');
          process.exit(1);
        }
        
        const locator = await findElementByRef(page, ref);
        await locator.click();
        console.log(`Clicked: ${ref}`);
        break;
      }

      case 'hover': {
        const ref = commandArgs[0];
        if (!ref) {
          console.error('Usage: hover <ref>');
          console.error('Run "snapshot" first to get element refs');
          process.exit(1);
        }
        
        const locator = await findElementByRef(page, ref);
        await locator.hover();
        console.log(`Hovered: ${ref}`);
        break;
      }

      case 'type': {
        const ref = commandArgs[0];
        const text = commandArgs.slice(1).join(' ');
        if (!ref || !text) {
          console.error('Usage: type <ref> <text>');
          console.error('Run "snapshot" first to get element refs');
          process.exit(1);
        }
        
        const locator = await findElementByRef(page, ref);
        await locator.fill(text);
        console.log(`Typed into ${ref}: "${text}"`);
        break;
      }

      case 'fill': {
        const jsonStr = commandArgs.join(' ');
        if (!jsonStr) {
          console.error('Usage: fill <json>');
          console.error('JSON format: [{"ref":"e1","value":"hello"},{"ref":"e2","value":"world"}]');
          process.exit(1);
        }
        
        let fields;
        try {
          fields = JSON.parse(jsonStr);
        } catch (e) {
          console.error('Error: Invalid JSON');
          console.error('Expected format: [{"ref":"e1","value":"hello"},...]');
          process.exit(1);
        }
        
        if (!Array.isArray(fields)) {
          console.error('Error: JSON must be an array');
          process.exit(1);
        }
        
        for (const field of fields) {
          if (!field.ref || field.value === undefined) {
            console.error(`Error: Each field must have "ref" and "value" properties`);
            process.exit(1);
          }
          
          const locator = await findElementByRef(page, field.ref);
          await locator.fill(String(field.value));
          console.log(`Filled ${field.ref}: "${field.value}"`);
        }
        console.log(`Filled ${fields.length} field(s)`);
        break;
      }

      case 'press': {
        const key = commandArgs[0];
        if (!key) {
          console.error('Usage: press <key>');
          console.error('Keys: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete, etc.');
          process.exit(1);
        }
        
        await page.keyboard.press(key);
        console.log(`Pressed: ${key}`);
        break;
      }

      case 'select': {
        const ref = commandArgs[0];
        const values = commandArgs.slice(1);
        if (!ref || values.length === 0) {
          console.error('Usage: select <ref> <value1> [value2...]');
          console.error('Run "snapshot" first to get element refs');
          process.exit(1);
        }
        
        const locator = await findElementByRef(page, ref);
        await locator.selectOption(values);
        console.log(`Selected in ${ref}: ${values.join(', ')}`);
        break;
      }

      case 'drag': {
        const startRef = commandArgs[0];
        const endRef = commandArgs[1];
        if (!startRef || !endRef) {
          console.error('Usage: drag <startRef> <endRef>');
          console.error('Run "snapshot" first to get element refs');
          process.exit(1);
        }
        
        const sourceLocator = await findElementByRef(page, startRef);
        const targetLocator = await findElementByRef(page, endRef);
        await sourceLocator.dragTo(targetLocator);
        console.log(`Dragged: ${startRef} -> ${endRef}`);
        break;
      }

      case 'screenshot': {
        const filename = commandArgs[0];
        const rawBuffer = await page.screenshot({ fullPage: true });
        const buffer = await ensureMaxDimensions(rawBuffer);
        if (filename) {
          const fs = await import('fs');
          fs.writeFileSync(filename, buffer);
          console.log(`Screenshot saved to: ${filename}`);
        } else {
          console.log(buffer.toString('base64'));
        }
        break;
      }

      case 'pdf': {
        const filename = commandArgs[0] || `page-${Date.now()}.pdf`;
        await page.pdf({ path: filename });
        console.log(`PDF saved to: ${filename}`);
        break;
      }

      case 'eval': {
        const js = commandArgs.join(' ');
        if (!js) {
          console.error('Usage: eval <javascript>');
          process.exit(1);
        }
        const result = await page.evaluate(js);
        if (result !== undefined) {
          console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
        }
        break;
      }

      case 'run': {
        const code = commandArgs.join(' ');
        if (!code) {
          console.error('Usage: run <code>');
          console.error('Code should be a function body like:');
          console.error('  await page.click("button"); return await page.title();');
          process.exit(1);
        }
        
        // Create async function with page and context in scope
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const fn = new AsyncFunction('page', 'context', 'browser', code);
        
        const result = await fn(page, context, browser);
        if (result !== undefined) {
          console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
        }
        break;
      }

      case 'back': {
        await page.goBack();
        console.log(`Navigated back to: ${page.url()}`);
        break;
      }

      case 'close': {
        await page.close();
        console.log('Page closed');
        break;
      }

      case 'console': {
        // Use CDP to get console messages
        const client = await context.newCDPSession(page);
        const messages = [];
        
        // Enable runtime to get console API calls
        await client.send('Runtime.enable');
        
        // Listen for new console messages
        client.on('Runtime.consoleAPICalled', event => {
          const text = event.args.map(arg => arg.value ?? arg.description ?? '').join(' ');
          messages.push({
            type: event.type,
            text,
          });
        });
        
        // Listen for exceptions
        client.on('Runtime.exceptionThrown', event => {
          messages.push({
            type: 'error',
            text: event.exceptionDetails.text || event.exceptionDetails.exception?.description || 'Unknown error',
          });
        });
        
        // Capture for specified time (or reload to capture page load messages)
        const captureTime = parseInt(commandArgs[0]) || 0;
        
        if (captureTime > 0) {
          console.error(`Capturing console for ${captureTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, captureTime));
        } else {
          // Reload page to capture console from page load
          console.error('Reloading page to capture console...');
          await page.reload({ waitUntil: 'domcontentloaded' });
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        await client.detach();
        
        if (messages.length === 0) {
          console.log('No console messages captured');
        } else {
          for (const msg of messages) {
            console.log(`[${msg.type}] ${msg.text}`);
          }
        }
        break;
      }

      case 'resize': {
        const width = parseInt(commandArgs[0]);
        const height = parseInt(commandArgs[1]);
        if (!width || !height) {
          console.error('Usage: resize <width> <height>');
          console.error('Example: resize 1920 1080');
          process.exit(1);
        }
        await page.setViewportSize({ width, height });
        console.log(`Viewport resized to: ${width}x${height}`);
        break;
      }

      case 'tabs': {
        const action = commandArgs[0];
        
        if (!action || action === 'list') {
          // List all tabs
          const allPages = context.pages();
          if (allPages.length === 0) {
            console.log('No tabs open');
          } else {
            for (let i = 0; i < allPages.length; i++) {
              const p = allPages[i];
              const current = p === page ? ' (current)' : '';
              console.log(`${i}: ${p.url()}${current}`);
            }
          }
        } else if (action === 'new') {
          // Create new tab
          const url = commandArgs[1];
          const newPage = await context.newPage();
          if (url) {
            await newPage.goto(url, { waitUntil: 'domcontentloaded' });
            console.log(`New tab created and navigated to: ${newPage.url()}`);
          } else {
            console.log('New tab created (blank)');
          }
          // Show new tab index
          const allPages = context.pages();
          console.log(`Tab index: ${allPages.indexOf(newPage)}`);
        } else if (action === 'close') {
          // Close tab by index
          const indexStr = commandArgs[1];
          const allPages = context.pages();
          
          if (indexStr === undefined) {
            // Close current tab
            await page.close();
            console.log('Closed current tab');
          } else {
            const index = parseInt(indexStr);
            if (isNaN(index) || index < 0 || index >= allPages.length) {
              console.error(`Invalid tab index: ${indexStr}`);
              console.error(`Valid indices: 0-${allPages.length - 1}`);
              process.exit(1);
            }
            await allPages[index].close();
            console.log(`Closed tab ${index}`);
          }
        } else if (action === 'select') {
          // Switch to tab by index
          const indexStr = commandArgs[1];
          if (indexStr === undefined) {
            console.error('Usage: tabs select <index>');
            process.exit(1);
          }
          
          const allPages = context.pages();
          const index = parseInt(indexStr);
          
          if (isNaN(index) || index < 0 || index >= allPages.length) {
            console.error(`Invalid tab index: ${indexStr}`);
            console.error(`Valid indices: 0-${allPages.length - 1}`);
            process.exit(1);
          }
          
          // Bring tab to front
          await allPages[index].bringToFront();
          console.log(`Switched to tab ${index}: ${allPages[index].url()}`);
        } else {
          console.error(`Unknown tabs action: ${action}`);
          console.error('Usage: tabs list|new|close|select');
          process.exit(1);
        }
        break;
      }

      case 'click-xy': {
        const x = parseInt(commandArgs[0]);
        const y = parseInt(commandArgs[1]);
        if (isNaN(x) || isNaN(y)) {
          console.error('Usage: click-xy <x> <y>');
          console.error('Example: click-xy 100 200');
          process.exit(1);
        }
        await page.mouse.click(x, y);
        console.log(`Clicked at: (${x}, ${y})`);
        break;
      }

      case 'move-xy': {
        const x = parseInt(commandArgs[0]);
        const y = parseInt(commandArgs[1]);
        if (isNaN(x) || isNaN(y)) {
          console.error('Usage: move-xy <x> <y>');
          console.error('Example: move-xy 100 200');
          process.exit(1);
        }
        await page.mouse.move(x, y);
        console.log(`Mouse moved to: (${x}, ${y})`);
        break;
      }

      case 'drag-xy': {
        const startX = parseInt(commandArgs[0]);
        const startY = parseInt(commandArgs[1]);
        const endX = parseInt(commandArgs[2]);
        const endY = parseInt(commandArgs[3]);
        if (isNaN(startX) || isNaN(startY) || isNaN(endX) || isNaN(endY)) {
          console.error('Usage: drag-xy <startX> <startY> <endX> <endY>');
          console.error('Example: drag-xy 100 200 300 400');
          process.exit(1);
        }
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(endX, endY);
        await page.mouse.up();
        console.log(`Dragged from (${startX}, ${startY}) to (${endX}, ${endY})`);
        break;
      }

      case 'scroll': {
        const direction = commandArgs[0];
        const amount = parseInt(commandArgs[1]) || 300;
        
        if (!direction || !['up', 'down', 'left', 'right'].includes(direction)) {
          console.error('Usage: scroll <direction> [amount]');
          console.error('  direction: up, down, left, right');
          console.error('  amount: pixels (default 300)');
          console.error('Example: scroll down 500');
          process.exit(1);
        }
        
        let deltaX = 0;
        let deltaY = 0;
        
        switch (direction) {
          case 'up':
            deltaY = -amount;
            break;
          case 'down':
            deltaY = amount;
            break;
          case 'left':
            deltaX = -amount;
            break;
          case 'right':
            deltaX = amount;
            break;
        }
        
        await page.mouse.wheel(deltaX, deltaY);
        console.log(`Scrolled ${direction} by ${amount}px`);
        break;
      }

      case 'wait': {
        const subCommand = commandArgs[0];
        
        if (!subCommand) {
          console.error('Usage: wait <seconds>');
          console.error('       wait text <text>');
          console.error('       wait gone <text>');
          process.exit(1);
        }
        
        if (subCommand === 'text') {
          // Wait for text to appear
          const text = commandArgs.slice(1).join(' ');
          if (!text) {
            console.error('Usage: wait text <text>');
            process.exit(1);
          }
          await page.getByText(text).waitFor();
          console.log(`Text appeared: "${text}"`);
        } else if (subCommand === 'gone') {
          // Wait for text to disappear
          const text = commandArgs.slice(1).join(' ');
          if (!text) {
            console.error('Usage: wait gone <text>');
            process.exit(1);
          }
          await page.getByText(text).waitFor({ state: 'hidden' });
          console.log(`Text disappeared: "${text}"`);
        } else {
          // Wait for time (seconds)
          const seconds = parseFloat(subCommand);
          if (isNaN(seconds) || seconds <= 0) {
            console.error('Usage: wait <seconds>');
            console.error('       wait text <text>');
            console.error('       wait gone <text>');
            process.exit(1);
          }
          await page.waitForTimeout(seconds * 1000);
          console.log(`Waited ${seconds} seconds`);
        }
        break;
      }

      case 'dialog': {
        const action = commandArgs[0];
        
        if (!action || (action !== 'accept' && action !== 'dismiss')) {
          console.error('Usage: dialog accept [promptText]');
          console.error('       dialog dismiss');
          console.error('Note: Run this BEFORE the action that triggers the dialog');
          process.exit(1);
        }
        
        const promptText = commandArgs.slice(1).join(' ') || undefined;
        
        // Set up a one-time dialog handler
        const dialogPromise = new Promise((resolve) => {
          page.once('dialog', async (dialog) => {
            const type = dialog.type();
            const message = dialog.message();
            
            if (action === 'accept') {
              await dialog.accept(promptText);
              resolve({ type, message, action: 'accepted', promptText });
            } else {
              await dialog.dismiss();
              resolve({ type, message, action: 'dismissed' });
            }
          });
        });
        
        console.log(`Dialog handler set: will ${action} next dialog${promptText ? ` with text "${promptText}"` : ''}`);
        console.log('Waiting for dialog... (trigger it now)');
        
        // Wait for dialog with timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timeout waiting for dialog (30s)')), 30000);
        });
        
        try {
          const result = await Promise.race([dialogPromise, timeoutPromise]);
          console.log(`Dialog ${result.action}: [${result.type}] "${result.message}"`);
        } catch (err) {
          console.error(err.message);
          process.exit(1);
        }
        break;
      }

      case 'upload': {
        const filePaths = commandArgs;
        
        if (filePaths.length === 0) {
          console.error('Usage: upload <path1> [path2...]');
          console.error('Note: Run this BEFORE clicking the upload button');
          process.exit(1);
        }
        
        // Set up file chooser handler
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 30000 });
        
        console.log(`File chooser handler set for: ${filePaths.join(', ')}`);
        console.log('Waiting for file chooser... (click the upload button now)');
        
        try {
          const fileChooser = await fileChooserPromise;
          await fileChooser.setFiles(filePaths);
          console.log(`Uploaded ${filePaths.length} file(s): ${filePaths.join(', ')}`);
        } catch (err) {
          if (err.message.includes('Timeout')) {
            console.error('Timeout waiting for file chooser (30s)');
          } else {
            console.error(`Error: ${err.message}`);
          }
          process.exit(1);
        }
        break;
      }

      case 'network': {
        const includeStatic = commandArgs.includes('--static');
        
        // Static resource extensions to filter out by default
        const staticExtensions = [
          '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
          '.woff', '.woff2', '.ttf', '.eot', '.otf',
          '.mp3', '.mp4', '.webm', '.ogg', '.wav',
          '.webp', '.avif'
        ];
        
        const staticContentTypes = [
          'image/', 'font/', 'audio/', 'video/',
          'text/css', 'application/javascript', 'text/javascript'
        ];
        
        const requests = [];
        
        // Set up request/response tracking
        const requestHandler = (request) => {
          requests.push({
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            status: null,
            contentType: null,
          });
        };
        
        const responseHandler = (response) => {
          const url = response.url();
          const req = requests.find(r => r.url === url && r.status === null);
          if (req) {
            req.status = response.status();
            req.contentType = response.headers()['content-type'] || '';
          }
        };
        
        page.on('request', requestHandler);
        page.on('response', responseHandler);
        
        console.error('Reloading page to capture network requests...');
        await page.reload({ waitUntil: 'networkidle' });
        
        // Remove handlers
        page.off('request', requestHandler);
        page.off('response', responseHandler);
        
        // Filter and display requests
        let filteredRequests = requests;
        
        if (!includeStatic) {
          filteredRequests = requests.filter(req => {
            // Filter by resource type
            const staticTypes = ['stylesheet', 'script', 'image', 'font', 'media'];
            if (staticTypes.includes(req.resourceType)) {
              return false;
            }
            
            // Filter by extension
            try {
              const urlPath = new URL(req.url).pathname.toLowerCase();
              if (staticExtensions.some(ext => urlPath.endsWith(ext))) {
                return false;
              }
            } catch {
              // Invalid URL, keep it
            }
            
            // Filter by content type
            if (req.contentType) {
              if (staticContentTypes.some(ct => req.contentType.includes(ct))) {
                return false;
              }
            }
            
            return true;
          });
        }
        
        if (filteredRequests.length === 0) {
          console.log(includeStatic ? 'No network requests captured' : 'No non-static network requests captured (use --static to see all)');
        } else {
          console.log(`Captured ${filteredRequests.length} request(s)${!includeStatic ? ' (excluding static resources)' : ''}:\n`);
          for (const req of filteredRequests) {
            const status = req.status ? `[${req.status}]` : '[pending]';
            console.log(`${status} ${req.method} ${req.url}`);
          }
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run with --help to see available commands');
        process.exit(1);
    }

  } finally {
    // Disconnect (but don't close the browser)
    await browser.close();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
