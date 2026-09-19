/** Shared, versioned palette contract. No runtime dependency on the palette itself. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MenuItem } from "./menu.ts";
export type { MenuItem } from "./menu.ts";

export const CATEGORY_DISCOVER_EVENT = "command-palette:category-discover";
export const CATEGORY_REGISTER_EVENT = "command-palette:category-register";
export const OPEN_EVENT = "command-palette:open";

export interface CategoryDiscovery { version: 1 }
/** A root-level palette category. Ids are lowercase and must not collide with built-in groups. */
export interface CategoryProvider {
	version: 1;
	id: string;
	label: string;
	description?: string;
	/** Called on every palette open; must be cheap and read live state. */
	items(ctx: ExtensionContext): MenuItem[];
}
export interface OpenRequest {
	version: 1;
	ctx: ExtensionContext;
	/** Category ids to open at, matched case-insensitively; stops at the first miss. */
	path?: string[];
	/** Called synchronously by the palette if it will open; carries the open promise. */
	claim(opened: Promise<void>): void;
}

/** Answer discovery only: the palette asks afresh on every open and never caches providers. */
export function registerPaletteCategory(events: ExtensionAPI["events"], provider: CategoryProvider): () => void {
	return events.on(CATEGORY_DISCOVER_EVENT, (data: unknown) => {
		if ((data as CategoryDiscovery | undefined)?.version === 1) events.emit(CATEGORY_REGISTER_EVENT, provider);
	});
}

/** Returns the palette's promise, or undefined when no palette claimed the request. */
export function requestPaletteOpen(events: ExtensionAPI["events"], ctx: ExtensionContext, path?: string[]): Promise<void> | undefined {
	let opened: Promise<void> | undefined;
	const request: OpenRequest = { version: 1, ctx, path, claim: promise => { opened = promise; } };
	events.emit(OPEN_EVENT, request);
	return opened;
}
