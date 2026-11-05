// The Icon card's upload (§app.projects/icon): any picture the browser can draw (PNG, JPEG, WebP, GIF, SVG) up to 5 MB
// becomes a 256×256 PNG, fitted with see-through margins, never cropped, then base64 for PUT /api/projects/:pid/icon.
// Browser-only (canvas, Image): the server never imports it.

export const ICON_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const ICON_SIDE = 256;
export const ICON_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
export const TOO_BIG = "This image is over 5 MB.";
export const CANT_USE = "This image can't be used. Try a PNG.";

/** Where a w×h picture lands in a side×side square: fitted whole and centred. */
export function containRect(w: number, h: number, side: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(side / w, side / h);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  return { x: Math.round((side - dw) / 2), y: Math.round((side - dh) / 2), w: dw, h: dh };
}

function decode(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(CANT_USE));
    };
    img.src = url;
  });
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      const at = s.indexOf(",");
      if (at < 0) reject(new Error(CANT_USE));
      else resolve(s.slice(at + 1));
    };
    r.onerror = () => reject(new Error(CANT_USE));
    r.readAsDataURL(blob);
  });
}

/** The file as a square PNG in base64, or a thrown Error whose message the card shows. */
export async function iconPngFromFile(file: File): Promise<string> {
  if (file.size > ICON_UPLOAD_MAX_BYTES) throw new Error(TOO_BIG);
  const img = await decode(file);
  // An SVG without its own size reports 0: draw it at the full square.
  const w = img.naturalWidth || ICON_SIDE;
  const h = img.naturalHeight || ICON_SIDE;
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIDE;
  canvas.height = ICON_SIDE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(CANT_USE);
  const r = containRect(w, h, ICON_SIDE);
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
  } catch {
    throw new Error(CANT_USE);
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, "image/png");
    } catch {
      resolve(null); // a tainted canvas
    }
  });
  if (!blob) throw new Error(CANT_USE);
  return toBase64(blob);
}
