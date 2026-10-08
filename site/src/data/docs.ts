import { getCollection, type CollectionEntry } from "astro:content";

export type DocEntry = CollectionEntry<"docs">;

// Sidebar order: groups in this order, pages by `order` within a group.
export const groups = ["Start", "Modes", "Features", "Setup"] as const;

// The page's path under /docs/: "index" is /docs/ itself, "modes/index" is /docs/modes/.
export const docSlug = (id: string) => id.replace(/(^|\/)index$/, "");
export const docHref = (id: string) => {
  const slug = docSlug(id);
  return slug ? `/docs/${slug}/` : "/docs/";
};

export async function sortedDocs(): Promise<DocEntry[]> {
  const all = await getCollection("docs");
  return all.sort((a, b) =>
    groups.indexOf(a.data.group) - groups.indexOf(b.data.group) || a.data.order - b.data.order || a.id.localeCompare(b.id));
}
