import { copiedLink } from "./public-links";
import { copyText } from "./ui-state";

/** Copy a public link and, under Cloudflare Free, tell the server it left Sova, so the
    broken-links notice judges it by this copy (§mesh.public/broken-links). `host`: the share's
    host; a peer's link is that peer's to judge, so nothing is reported for it. */
export async function copyLink(url: string, done: string, host?: string | null): Promise<boolean> {
  const ok = await copyText(url, done);
  if (ok) copiedLink(url, host);
  return ok;
}
