---
name: playwright
description: Browser automation using Playwright via CDP. Load when doing browser testing, UI verification, form interaction, taking screenshots, or any task that requires controlling a web browser. Provides both shell CLI (pw.sh) and MCP tool interfaces.
---

# Playwright Browser Automation

Browser automation using Playwright via CDP (Chrome DevTools Protocol). Two equivalent interfaces are available:

| Interface | Use Case |
|-----------|----------|
| **Shell CLI** (`pw.sh`) | Direct bash commands, scripts |
| **MCP Tools** (`browser_*`) | AI agents with MCP integration |

Both control the same browser instance. Use whichever fits your workflow.

## Quick Start (Shell CLI)

`start-browser.sh` gives you **your own browser** and prints its port. Pass that
port as `PW_PORT` on every subsequent command:

```bash
SK=<path-to-this-skill>/scripts

# 1. Start your own browser — prints "PW_PORT=<port>"
$SK/start-browser.sh --headless

# 2. Run commands, carrying the port every time
PW_PORT=9481 $SK/pw.sh navigate https://example.com
PW_PORT=9481 $SK/pw.sh snapshot
PW_PORT=9481 $SK/pw.sh click e5
PW_PORT=9481 $SK/pw.sh type e3 "hello world"

# 3. Stop when done — leaked browsers cost ~150MB each
PW_PORT=9481 $SK/stop-browser.sh
```

## Concurrency — read this before anything else

Several agents routinely run in the same working directory at the same time.
The browser is shared state, and the failure mode is silent: your `navigate`
lands on someone else's tab, their `resize` changes your viewport, their
`stop-browser.sh` kills your session mid-task, and your screenshot shows their
page while reporting success.

Three rules keep that from happening:

1. **Always start your own browser.** `start-browser.sh` is isolated by default:
   a freshly claimed port, its own profile, nothing written to the working
   directory.
2. **Never attach to a browser you did not start.** Do not go hunting with
   `ps aux | grep chromium`, and do not reuse a port you found lying around —
   it belongs to another agent that is still using it. Starting a second browser
   is cheap; hijacking someone's session is not.
3. **Pass `PW_PORT=<your port>` on every single call.** Shell environment does
   not persist between tool calls, so `export PW_PORT` in one call is gone by
   the next. Prefix each command inline.

`stop-browser.sh --list` shows every browser this skill started. It is
informational — browsers you did not start are not yours to kill, and there is
deliberately no `--all`.

To confirm you are driving your own browser, evaluate what you're looking at
rather than trusting the screenshot:

```bash
PW_PORT=9481 $SK/pw.sh eval "JSON.stringify({url: location.href, w: innerWidth})"
```

## What your own commands do to the page

Concurrency above is another agent's doing. These are yours, and every one of
them returns success.

**A width you set and did not re-read is a width you do not have.** `resize`
survives any number of later `pw.sh` calls — snapshot, eval, screenshot — but
**any command that loads a document throws it away**: `navigate` to a new URL,
`page.reload()`, `page.goto()` inside `run`, and `console` (which reloads).
The viewport goes back to the headless default, 780x437, and `Navigated to: ...`
still prints. It is the document load that resets it, not the call boundary.
Measured: `resize 1440 900` then `navigate` reads `innerWidth` 780. One agent
resized once, navigated 23 times, measured every screen at 780 and reported no
folded-width problems anywhere; re-measured, it found three, and a whole review
round was thrown away.

**So resize AFTER the navigate, and assert the width before believing a reading:**

```bash
PW_PORT=9481 $SK/pw.sh navigate http://localhost:3059/settings
PW_PORT=9481 $SK/pw.sh resize 1440 900
PW_PORT=9481 $SK/pw.sh eval "innerWidth"    # must print 1440 before you trust anything
```

**Assert `window.innerWidth`, never `page.viewportSize()`** — over CDP the latter
returns `null` while the viewport is 1440 wide, so it can neither pass nor fail.

**`console` with no argument reloads the page it was called to read.** It
destroys the state you clicked your way to: measured, a clicked-in value reverted
to its initial text and the width went 1440 -> 780 in that one call, with
`Reloading page to capture console...` on stderr only. **Never call `console` to
read the result of an interaction** — by the time it answers, the interaction is
gone. `console 800` captures for 800ms instead and leaves the page alone.

**`snapshot -g` prints its failure as its answer.** `No matches found for:
"<pattern>"` goes to stdout at exit 0, and it is the same output whether the
element is absent, the page never loaded, or the pattern uses syntax `-g` does
not honour — it is a case-insensitive substring test, so `"Start\|Stop"` matches
nothing on a tree containing `button "Start"`. Measured: after a `navigate` that
exited 1, `snapshot -g "Press"` printed `No matches found` at exit 0. Take a bare
`snapshot` before concluding an element is missing.

**A locator that matches nothing costs the full 30-second action timeout.**
`await page.locator('#nope').innerText()` waits 30s and then throws; a
twenty-iteration poll written that way is a ten-minute hang with no output. Test
existence with `.count()`, which answers `0` immediately, or pass an explicit
`{timeout: 2000}`.

## Port Management

- **Default (isolated)**: `start-browser.sh` claims a free port in 9300-9999
  atomically, prints `PW_PORT=<port>`, and writes **no** file into the working
  directory. Concurrent-safe.
- **`--shared`**: legacy mode — the port is stored in `$PWD/.playwright-port` and
  every caller in that directory drives the same browser and the same tab. Only
  safe when you are certain nothing else is running there.
- **`PW_PORT=XXXX`**: address a specific browser. This is how you talk to the one
  you started.

If `PW_PORT` is unset, `pw.sh` falls back to `.playwright-port` and prints a
warning to stderr. That warning means you forgot your port — you are now driving
a shared browser.

**Never hardcode port 9222.**

## Shell CLI Commands

### Navigation

| Command | Description |
|---------|-------------|
| `navigate <url>` | Go to URL |
| `back` | Go back to previous page |
| `close` | Close current page |

### Page State

| Command | Description |
|---------|-------------|
| `snapshot` | Get page accessibility tree with element refs (see **Element Refs** — including what to do if it errors) |
| `snapshot -g <pattern>` | Case-insensitive **substring** filter, not a regex; prints `No matches found` on stdout at exit 0 (see **What your own commands do to the page**) |
| `snapshot -g <pattern> -C <N>` | Search with N lines of context above/below (default: 3) |
| `screenshot [file]` | Take screenshot (auto-resized to max 2000px) |
| `console [ms]` | Get console messages — **with no `ms` it RELOADS the page** (see **What your own commands do to the page**) |
| `network [--static]` | List network requests |

### Interaction

| Command | Description |
|---------|-------------|
| `click <ref>` | Click element by ref |
| `hover <ref>` | Hover over element by ref |
| `type <ref> <text>` | Type text into element |
| `fill <json>` | Fill multiple form fields: `[{"ref":"e1","value":"..."},...]` |
| `press <key>` | Press keyboard key (Enter, Escape, Tab, ArrowUp, etc.) |
| `select <ref> <values...>` | Select dropdown option(s) |
| `drag <startRef> <endRef>` | Drag from one element to another |

### Coordinate-Based (Vision)

| Command | Description |
|---------|-------------|
| `click-xy <x> <y>` | Click at coordinates |
| `move-xy <x> <y>` | Move mouse to coordinates |
| `drag-xy <x1> <y1> <x2> <y2>` | Drag between coordinates |
| `scroll <dir> [amount]` | Scroll page (up/down/left/right, default 300px) |

### Execution

| Command | Description |
|---------|-------------|
| `eval <js>` | Evaluate JavaScript in page context |
| `run <code>` | Run Playwright code: `await page.click('x'); return 1;` |

### Utilities

| Command | Description |
|---------|-------------|
| `wait <seconds>` | Wait for specified time |
| `wait text <text>` | Wait for text to appear |
| `wait gone <text>` | Wait for text to disappear |
| `resize <width> <height>` | Resize viewport — **does not survive the next document load** (see **What your own commands do to the page**) |
| `dialog accept [text]` | Accept next dialog |
| `dialog dismiss` | Dismiss next dialog |
| `upload <paths...>` | Upload files via file chooser |
| `tabs list/new/close/select` | Tab management |

## Element Refs

Run `snapshot` to get the accessibility tree with a ref on each element:

```
- generic [ref=e3]:
  - img "Fold" [ref=e6]
  - button "Send" [disabled] [ref=e250]
```

Then use the ref: `$SK/pw.sh click e250`

For large pages, use greppable snapshots to reduce context:

```bash
$SK/pw.sh snapshot -g "login"        # Find login-related elements
$SK/pw.sh snapshot -g "button" -C 5  # 5 lines of context
```

**`snapshot` works on every build**, because `pw-client.mjs` tries three things
in order. You never pick one; this is here so you can read the output correctly:

| Tier | Source | Refs |
|---|---|---|
| 1 | `page._snapshotForAI()` | Yes. A Playwright private, absent from 1.60+ — and guarded by a `typeof` check, so it can no longer throw `page._snapshotForAI is not a function`. |
| 2 | `locator.ariaSnapshot({ mode: 'ai' })` | Yes. The public, durable path. `mode: 'ai'` is load-bearing — the default mode renders a tree with **no refs at all**. |
| 3 | `locator.ariaSnapshot()` | **No.** Only for a build that rejects the `mode` option. |

**Tier 3 prints a warning on stderr and the tree below it carries no refs**, so
`click e5` will fail with "ref not found". Read stderr before trusting a ref.

**When you have no refs, drive by accessible name instead.** It works on any
build, and it doubles as an accessibility check — anything you cannot address
this way is unlabelled:

```bash
$SK/pw.sh run 'await page.getByRole("button",{name:"Send",exact:true}).click(); return 1'
```

Note `exact:true`: without it, `{name:"Folded"}` also matches "Unfolded" and
fails on strict mode.

## MCP Tool Mapping

| Shell CLI | MCP Tool |
|-----------|----------|
| `navigate <url>` | `browser_navigate` |
| `back` | `browser_navigate_back` |
| `snapshot` | `browser_snapshot` |
| `screenshot` | `browser_take_screenshot` |
| `click <ref>` | `browser_click` |
| `type <ref> <text>` | `browser_type` |
| `hover <ref>` | `browser_hover` |
| `press <key>` | `browser_press_key` |
| `select <ref> <values>` | `browser_select_option` |
| `drag` | `browser_drag` |
| `fill <json>` | `browser_fill_form` |
| `eval <js>` | `browser_evaluate` |
| `run <code>` | `browser_run_code` |
| `wait` | `browser_wait_for` |
| `resize` | `browser_resize` |
| `close` | `browser_close` |
| `dialog` | `browser_handle_dialog` |
| `upload` | `browser_file_upload` |
| `console` | `browser_console_messages` |
| `network` | `browser_network_requests` |
| `tabs` | `browser_tabs` |

## Common Workflows

### Login and Verify Dashboard

```bash
$SK/start-browser.sh --headless        # prints PW_PORT, say 9481
PW_PORT=9481 $SK/pw.sh navigate http://localhost:3059/login
PW_PORT=9481 $SK/pw.sh snapshot
PW_PORT=9481 $SK/pw.sh type e5 "user@example.com"
PW_PORT=9481 $SK/pw.sh type e7 "password"
PW_PORT=9481 $SK/pw.sh click e9
PW_PORT=9481 $SK/pw.sh wait text "Dashboard"
PW_PORT=9481 $SK/pw.sh screenshot /tmp/dashboard.png
PW_PORT=9481 $SK/stop-browser.sh
```

### Fill a Form

```bash
PW_PORT=9481 $SK/pw.sh fill '[{"ref":"e1","value":"username"},{"ref":"e2","value":"password"}]'
PW_PORT=9481 $SK/pw.sh click e3
```

### Test Responsive Layout

The resize goes **after** the navigate, and the width is asserted before the
shot — a navigate between the two silently returns you to 780px:

```bash
PW_PORT=9481 $SK/pw.sh navigate http://localhost:3059/settings
PW_PORT=9481 $SK/pw.sh resize 375 667              # Mobile
PW_PORT=9481 $SK/pw.sh eval "innerWidth"           # 375, or the shot below is a lie
PW_PORT=9481 $SK/pw.sh screenshot /tmp/mobile.png
PW_PORT=9481 $SK/pw.sh resize 1440 900             # Desktop, same page, no navigate
PW_PORT=9481 $SK/pw.sh eval "innerWidth"           # 1440
PW_PORT=9481 $SK/pw.sh screenshot /tmp/desktop.png
```

## Additional Resources

For detailed MCP tool parameter documentation:

- [Navigation](core/navigation.md) - `browser_navigate`, `browser_navigate_back`
- [Page State](core/page-state.md) - `browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`
- [Interaction](core/interaction.md) - `browser_click`, `browser_type`, `browser_hover`, `browser_drag`, `browser_press_key`, `browser_select_option`, `browser_fill_form`
- [Execution](core/execution.md) - `browser_evaluate`, `browser_run_code`
- [Utilities](core/utilities.md) - `browser_wait_for`, `browser_resize`, `browser_close`, `browser_handle_dialog`, `browser_file_upload`
- [Coordinate-Based](vision/coordinates.md) - Vision-based coordinate interactions
- [Testing Assertions](testing/assertions.md) - `browser_verify_*`, `browser_generate_locator`
- [Extras](extras/tabs-install-pdf-tracing.md) - Tab management, browser install, PDF, tracing

## Scripts

The shell scripts are in the `scripts/` subdirectory of this skill:

| File | Description |
|------|-------------|
| `scripts/start-browser.sh` | Start Chromium with CDP enabled |
| `scripts/pw.sh` | Run commands against the browser |
| `scripts/stop-browser.sh` | Stop the browser |
| `scripts/pw-client.mjs` | Node.js Playwright CDP client |

## Dependencies

Requires `playwright` and `sharp` (for screenshot resizing):

```json
{
  "dependencies": {
    "playwright": "^1.40.0",
    "sharp": "^0.33.0"
  }
}
```
