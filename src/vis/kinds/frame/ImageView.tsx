import { createSignal, onCleanup, onMount } from "solid-js";
import { appTheme } from "../../../lib/explain";
import type { ViewProps } from "../../types";
import type { FrameSpec } from "./parse";
import { readTokens, tokenCss } from "./srcdoc";
import { svgImageSrc, svgNaturalWidth } from "./svg-image";
import "./frame.css";

/**
 * `vis svg` on a share or owner page (and the Share sheet's Preview): a still image of the parsed
 * document, never the document in the page, so it runs no script and fetches nothing. The page's
 * colour tokens and the frame's font are its defaults (svg-image.ts); a theme change (data-theme,
 * or a custom theme's inline tokens) draws it again. Natural size, centred, shrunk only to fit.
 */
export default function ImageView(props: ViewProps<FrameSpec>) {
  const root = document.documentElement;
  const src = () => svgImageSrc(props.spec.source, tokenCss(readTokens(root), appTheme()));
  const [url, setUrl] = createSignal(src());
  onMount(() => {
    const mo = new MutationObserver(() => setUrl(src()));
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "style"] });
    onCleanup(() => mo.disconnect());
  });
  const width = svgNaturalWidth(props.spec.source);
  return (
    <div class="vis-svg-image">
      <img src={url()} alt={props.label} style={width ? { width: `${width}px` } : undefined} />
    </div>
  );
}
