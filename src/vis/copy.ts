/**
 * A drawing card's Copy in the chat (Visual.tsx), deciding by copy-plan.ts: the fence text, the card as
 * a picture on the clipboard, or that picture in the image viewer. The picture is made by snapshot.ts,
 * imported on the first Copy so the chat's bundle doesn't carry it.
 */
import { announce, copyText, openLightbox, toast } from "../lib/ui-state";
import { COPY_DONE, copyRoute, nextRoute, pictureFileName, pictureHtml, type CopyRoute, type CopyWhat, type PictureSupport } from "./copy-plan";
import type { Picture } from "./snapshot";

/** What this browser, on this page, offers for putting a picture on the clipboard. */
export function pictureSupport(): PictureSupport {
  const CI = (globalThis as { ClipboardItem?: { supports?: (type: string) => boolean } }).ClipboardItem;
  return {
    secure: globalThis.isSecureContext === true,
    clipboardItem: typeof CI === "function" && typeof navigator.clipboard?.write === "function",
    png: typeof CI?.supports === "function" ? CI.supports("image/png") : undefined,
  };
}

const say = (text: string) => {
  toast(text);
  announce(text);
};

let viewerUrl: string | undefined;

const asDataUrl = (blob: Blob) =>
  new Promise<string>((done, fail) => {
    const fr = new FileReader();
    fr.onload = () => done(fr.result as string);
    fr.onerror = () => fail(fr.error);
    fr.readAsDataURL(blob);
  });

/** Copy on a card: `button` is the Copy button inside the card's figure. */
export function copyCard(button: HTMLElement, card: { what: CopyWhat; fence: string; label: string; svgSource?: string }): void {
  const copySource = async (done: string) => {
    if (await copyText(card.fence, done)) announce(done);
  };
  let route: CopyRoute | null = copyRoute(card.what, pictureSupport());
  if (route === "text") return void copySource(COPY_DONE.source);
  const figure = button.closest<HTMLElement>("figure.vis");
  if (!figure) return void copySource(COPY_DONE.source);
  // Started at once, in the click: Safari keeps the clipboard's permission only for a write begun in it.
  const picture: Promise<Picture> = import("./snapshot").then((m) => m.snapshot(figure, { svgSource: card.svgSource }));
  const view = (p: Picture) => {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(p.blob);
    openLightbox([{ src: viewerUrl, alt: `Picture of ${card.label}`, width: p.width, download: pictureFileName(card.label) }], 0, button);
    say(COPY_DONE.viewer);
  };
  const failed = async (failure: "no-picture" | "clipboard-refused") => {
    route = nextRoute(route!, failure);
    if (route === "text") await copySource(COPY_DONE.textInstead);
    else if (route === "viewer") view(await picture);
    else toast("Couldn't reach the clipboard. Nothing was copied.");
  };
  if (route === "clipboard") {
    let item: ClipboardItem;
    try {
      // The PNG, and beside it the same picture as HTML at the card's size: a target that pastes HTML
      // shows it as big as the card, one that takes only the image gets its pixels (its scale times larger).
      const types: Record<string, Promise<Blob>> = { "image/png": picture.then((p) => p.blob) };
      const CI = ClipboardItem as unknown as { supports?: (type: string) => boolean };
      if (typeof CI.supports !== "function" || CI.supports("text/html")) {
        types["text/html"] = picture.then(async (p) => new Blob([pictureHtml(await asDataUrl(p.blob), p.width, p.height, `Picture of ${card.label}`)], { type: "text/html" }));
      }
      item = new ClipboardItem(types);
    } catch {
      void picture.then(view, () => failed("no-picture"));
      return;
    }
    navigator.clipboard.write([item]).then(
      () => say(COPY_DONE.picture),
      () => picture.then(() => failed("clipboard-refused"), () => failed("no-picture")),
    );
    return;
  }
  picture.then(view, () => failed("no-picture"));
}
