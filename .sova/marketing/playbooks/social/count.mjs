// Measures post drafts against their platform's length limit.
//
//   node .sova/marketing/playbooks/social/count.mjs .sova/marketing/social/<occasion>/*.md
//
// A draft is named <platform>.md (bluesky, mastodon, x, linkedin, hn, reddit). Everything above
// its first line that is exactly "---" is notes; below it, each "---"-separated block is one
// post as it will be pasted (a thread has several). Lengths are counted in graphemes
// (Intl.Segmenter), with each URL weighed the way the platform weighs it. For hn and reddit the
// first line of the first post is the title and is measured against the title limit. An image
// line in the notes needs an "Alt:" line. Exit 1 if any draft is over, has a link-only post, or
// lacks alt text.
//
// It also reads social.platforms from brand.json, but only to inform: a draft for a platform the
// brand doesn't list is noted, and an empty list ([] = not decided yet) is noted once. Neither
// fails, because the platforms are agreed with the user in PLAYBOOK.md step 1, not here.
import fs from "node:fs";
import path from "node:path";
import { brand } from "../../lib/pw.mjs";

// Limits as this playbook was written; PLAYBOOK.md says to confirm them before posting near one.
const LIMITS = {
  bluesky: { post: 300, url: null },
  mastodon: { post: 500, url: 23 },
  x: { post: 280, url: 23 },
  linkedin: { post: 3000, url: null },
  hn: { title: 80, post: null, url: null },
  reddit: { title: 300, post: 40000, url: null },
};
const URL_RE = /https?:\/\/\S+/g;
const graphemes = (s) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
const weigh = (s, url) => (url ? graphemes(s.replace(URL_RE, "")) + (s.match(URL_RE) ?? []).length * url : graphemes(s));

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: count.mjs <draft.md>...");
  process.exit(1);
}
let platforms = null;
try {
  platforms = brand().social.platforms;
} catch (err) {
  console.log(`note: could not read social.platforms (${err.message.split("\n")[0]}); measuring against the limits only`);
}
if (Array.isArray(platforms) && !platforms.length)
  console.log("note: social.platforms in brand.json is [] (not decided). The platforms must have been agreed with the user (PLAYBOOK.md step 1); measuring each draft against its own platform's limits.");
let bad = 0;
for (const file of files) {
  const platform = path.basename(file, ".md");
  const limit = LIMITS[platform];
  if (!limit) {
    console.log(`${file}: skipped (not a platform name: ${Object.keys(LIMITS).join(", ")})`);
    continue;
  }
  if (Array.isArray(platforms) && platforms.length && !platforms.includes(platform)) console.log(`note: ${platform} is not in social.platforms (${platforms.join(", ")}); fine if the user asked for it in step 1`);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const fence = lines.indexOf("---");
  if (fence < 0) {
    console.log(`${file}: FAIL no "---" line; the posts go below it`);
    bad++;
    continue;
  }
  const notes = lines.slice(0, fence).join("\n");
  const posts = lines.slice(fence + 1).join("\n").split(/^---$/m).map((p) => p.trim()).filter(Boolean);
  const problems = [];
  if (!posts.length) problems.push("no post below the --- line");
  if (/^image:/im.test(notes) && !/^alt:\s*\S/im.test(notes)) problems.push("an Image: line without an Alt: line");
  const report = posts.map((p, i) => {
    let text = p;
    const parts = [];
    if (i === 0 && limit.title) {
      const [title, ...rest] = p.split("\n");
      const t = graphemes(title.trim());
      parts.push(`title ${t}/${limit.title}`);
      if (t > limit.title) problems.push(`title is ${t}, over ${limit.title}`);
      text = rest.join("\n").trim();
    }
    if (text) {
      const n = weigh(text, limit.url);
      if (limit.post) {
        parts.push(`post ${i + 1}: ${n}/${limit.post}`);
        if (n > limit.post) problems.push(`post ${i + 1} is ${n}, over ${limit.post}`);
      } else parts.push(`text ${n}`);
      if (!text.replace(URL_RE, "").trim()) problems.push(`post ${i + 1} is only a link`);
    }
    return parts.join(", ");
  });
  if (problems.length) bad++;
  console.log(`${file}: ${problems.length ? "FAIL" : "ok"}  ${report.join(" | ")}${problems.length ? `\n  - ${problems.join("\n  - ")}` : ""}`);
}
process.exit(bad ? 1 : 0);
