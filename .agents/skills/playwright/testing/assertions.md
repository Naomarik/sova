# Testing Assertions

> MCP tool reference. See [main README](../README.md) for overview and shell CLI usage.

Requires: `--caps=testing`

## browser_generate_locator
Generate locator for the given element to use in tests.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | string | Yes | Human-readable element description |
| `ref` | string | Yes | Exact target element reference from page snapshot |

## browser_verify_element_visible
Verify element is visible on the page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `role` | string | Yes | ROLE of element from snapshot (e.g., `button`, `link`) |
| `accessibleName` | string | Yes | Accessible name from snapshot |

## browser_verify_text_visible
Verify text is visible on the page. Prefer `browser_verify_element_visible` if possible.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | Text to verify |

## browser_verify_list_visible
Verify list is visible on the page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | string | Yes | Human-readable list description |
| `ref` | string | Yes | Exact target element reference |
| `items` | array | Yes | Items to verify |

## browser_verify_value
Verify element value.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Type of element |
| `element` | string | Yes | Human-readable element description |
| `ref` | string | Yes | Exact target element reference |
| `value` | string | Yes | Value to verify (for checkbox: "true"/"false") |
