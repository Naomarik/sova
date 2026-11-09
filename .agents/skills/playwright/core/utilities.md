# Utilities

> MCP tool reference. See [main README](../README.md) for overview and shell CLI usage.

## browser_wait_for
Wait for text to appear/disappear or time to pass.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `time` | number | No | Time to wait in seconds |
| `text` | string | No | Text to wait for |
| `textGone` | string | No | Text to wait for to disappear |

## browser_resize
Resize the browser window.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `width` | number | Yes | Width of the browser window |
| `height` | number | Yes | Height of the browser window |

## browser_close
Close the page.

No parameters.

## browser_handle_dialog
Handle a dialog (alert, confirm, prompt).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `accept` | boolean | Yes | Whether to accept the dialog |
| `promptText` | string | No | Text for prompt dialog |

## browser_file_upload
Upload one or multiple files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | array | No | Absolute paths to files. If omitted, file chooser is cancelled. |
