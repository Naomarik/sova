# Page State

> MCP tool reference. See [main README](../README.md) for overview and shell CLI usage.

## browser_snapshot
Capture accessibility snapshot of the current page. Better than screenshot for actions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filename` | string | No | Save snapshot to markdown file instead of returning in response |
| `grep` | string | No | Search pattern to filter snapshot (case-insensitive) |
| `context` | number | No | Lines of context above/below matches (default: 3) |

### Greppable Snapshot

For large pages, loading the entire DOM accessibility tree wastes context. Use `grep` to search for specific elements:

```bash
# Full snapshot (default behavior)
$SK/pw.sh snapshot

# Search for "login" with default context (3 lines above/below)
$SK/pw.sh snapshot --grep "login"
$SK/pw.sh snapshot -g "login"

# Search for "button" with 5 lines of context
$SK/pw.sh snapshot --grep "button" --context 5
$SK/pw.sh snapshot -g "button" -C 5
```

**Output format:**
- Shows matching lines with surrounding context
- Non-contiguous sections are separated by `--`
- Reports total number of matches found

Example output:
```
e12: [heading] "Login Section"
e13: [textbox] "Username"
e14: [textbox] "Password"
e15: [button] "Login"
e16: [link] "Forgot password?"
--
e45: [button] "Login with Google"
e46: [button] "Login with GitHub"
e47: [text] "Or continue with email"

[3 match(es) for "login"]
```

## browser_take_screenshot
Take a screenshot of the current page. Cannot perform actions based on screenshot - use `browser_snapshot` for that.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | No | Image format (default: png) |
| `filename` | string | No | File name (default: `page-{timestamp}.{ext}`) |
| `element` | string | No | Human-readable element description (for element screenshot) |
| `ref` | string | No | Exact target element reference (for element screenshot) |
| `fullPage` | boolean | No | Screenshot full scrollable page |

## browser_console_messages
Returns all console messages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `level` | string | No | Level filter: error, warning, info, debug (default: info) |

## browser_network_requests
Returns all network requests since loading the page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeStatic` | boolean | No | Include static resources (images, fonts, scripts). Default: false |
