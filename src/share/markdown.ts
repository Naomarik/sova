import MarkdownIt from "markdown-it";

// The share page's renderer: plain CommonMark, raw HTML off (markdown-it escapes it), links
// autodetected. Nothing of the operator app's renderer (session links, path chips, highlighting):
// a reply here is prose for a person, and every link opens outside the page with no referrer.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer nofollow");
  return defaultLink(tokens, idx, options, env, self);
};
// No images: a reply could otherwise make the reader's browser fetch any URL.
md.disable("image");

export const renderShareMarkdown = (text: string): string => md.render(text);
