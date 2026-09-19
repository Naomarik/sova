# Extras

> MCP tool reference. See [main README](../README.md) for overview and shell CLI usage.

## Tab Management (Default)

### browser_tabs
List, create, close, or select a browser tab.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | Operation: list, create, close, select |
| `index` | number | No | Tab index for close/select. If omitted for close, closes current tab. |

## Browser Installation (Default)

### browser_install
Install the browser specified in the config. Call this if you get an error about the browser not being installed.

No parameters.

## PDF Generation

Requires: `--caps=pdf`

### browser_pdf_save
Save page as PDF.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filename` | string | No | File name (default: `page-{timestamp}.pdf`) |

## Tracing

Requires: `--caps=tracing`

### browser_start_tracing
Start trace recording.

No parameters.

### browser_stop_tracing
Stop trace recording.

No parameters.
