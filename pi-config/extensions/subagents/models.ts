import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackendModel } from "./contracts.ts";

export interface CatalogModel extends BackendModel { backend: string }
/** Use the current session registry: it includes extension-provided/cloud models. */
export function piModels(ctx: ExtensionContext): BackendModel[] {
	return ctx.modelRegistry.getAvailable().map(model => ({
		id: `${model.provider}/${model.id}`,
		name: model.name || model.id,
		description: model.provider,
		vision: model.input?.includes("image") ?? false,
	}));
}
/** Punctuation-insensitive search: 'deepseek 4.1 flash' matches deepseek-v4.1-flash. */
export function matchingModels(models: CatalogModel[], query = ""): CatalogModel[] {
	const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	return models.filter(model => {
		const haystack = `${model.backend} ${model.id} ${model.name} ${model.description ?? ""} ${model.resolvedModel ?? ""}`.toLowerCase();
		return terms.every(term => haystack.includes(term));
	}).sort((a, b) => {
		const exactA = a.id.toLowerCase() === query.toLowerCase() ? 0 : 1;
		const exactB = b.id.toLowerCase() === query.toLowerCase() ? 0 : 1;
		return exactA - exactB || a.backend.localeCompare(b.backend) || a.id.localeCompare(b.id);
	});
}
