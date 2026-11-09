# Execution

> MCP tool reference. See [main README](../README.md) for overview and shell CLI usage.

## browser_evaluate
Evaluate JavaScript expression on page or element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `function` | string | Yes | `() => { /* code */ }` or `(element) => { /* code */ }` when element provided |
| `element` | string | No | Human-readable element description |
| `ref` | string | No | Exact target element reference from page snapshot |

## browser_run_code
Run Playwright code snippet.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | JavaScript function with Playwright code. Example: `async (page) => { await page.getByRole('button', { name: 'Submit' }).click(); return await page.title(); }` |
