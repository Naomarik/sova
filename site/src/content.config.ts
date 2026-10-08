import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// The /docs pages: hand-written Markdown, one file per page. A file's path is its URL under /docs/
// (index.md is its folder's own page). `group` and `order` place it in the sidebar.
const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    group: z.enum(["Start", "Modes", "Features", "Setup"]),
    order: z.number(),
  }),
});

export const collections = { docs };
