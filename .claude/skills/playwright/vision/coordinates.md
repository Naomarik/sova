# Coordinate-Based Interactions

> MCP tool reference. See [main README](../README.md) for overview and shell CLI usage.

Requires: `--caps=vision`

## browser_mouse_click_xy
Click left mouse button at a given position.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | string | Yes | Human-readable element description |
| `x` | number | Yes | X coordinate |
| `y` | number | Yes | Y coordinate |

## browser_mouse_move_xy
Move mouse to a given position.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | string | Yes | Human-readable element description |
| `x` | number | Yes | X coordinate |
| `y` | number | Yes | Y coordinate |

## browser_mouse_drag_xy
Drag left mouse button to a given position.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | string | Yes | Human-readable element description |
| `startX` | number | Yes | Start X coordinate |
| `startY` | number | Yes | Start Y coordinate |
| `endX` | number | Yes | End X coordinate |
| `endY` | number | Yes | End Y coordinate |
