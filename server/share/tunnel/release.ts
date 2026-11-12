/**
 * The cloudflared build Sova may download for its share links (server/share/tunnel/download.ts): one pinned
 * release, each asset's sha256 written here, never fetched from the release page. A checksum read from the same
 * place as the file proves nothing about a tampered release, so a bump is a commit that changes this table.
 *
 * Linux assets are bare binaries. macOS assets are a .tgz holding one `cloudflared`: GitHub's own digest is the
 * archive's and the release notes' sum is the binary's inside it, so both are checked.
 *
 * Bumping: take each asset's `digest` from the GitHub releases API for the tag, download the asset, hash it
 * yourself, and for a .tgz hash its `cloudflared` member too (it is the notes' line for that asset).
 */

export const CLOUDFLARED_VERSION = "2026.10.7";

export interface CloudflaredAsset {
  /** The release asset's file name. */
  name: string;
  /** The asset's bytes, exactly. */
  size: number;
  /** sha256 of the asset as downloaded, lowercase hex. */
  sha256: string;
  /** A .tgz: the one member Sova takes from it, by name, and that member's sha256. */
  member?: { name: "cloudflared"; sha256: string };
}

/** By `${process.platform}-${process.arch}`. */
export const CLOUDFLARED_ASSETS: Readonly<Record<string, CloudflaredAsset>> = {
  "linux-x64": { name: "cloudflared-linux-amd64", size: 40_274_445, sha256: "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872" },
  "linux-arm64": { name: "cloudflared-linux-arm64", size: 37_667_293, sha256: "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775" },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    size: 21_834_416,
    sha256: "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848",
    member: { name: "cloudflared", sha256: "5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86" },
  },
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    size: 19_847_161,
    sha256: "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd",
    member: { name: "cloudflared", sha256: "2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12" },
  },
};

/** The platforms Sova offers the download on (each must have an asset above). */
export const DOWNLOAD_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

/** The most a download may be, whatever the server says: well over every asset above. */
export const CLOUDFLARED_MAX_BYTES = 80 * 1024 * 1024;

export const assetFor = (platform: string = process.platform, arch: string = process.arch): CloudflaredAsset | null => CLOUDFLARED_ASSETS[`${platform}-${arch}`] ?? null;

export const assetUrl = (a: CloudflaredAsset, version: string = CLOUDFLARED_VERSION): string => `https://github.com/cloudflare/cloudflared/releases/download/${version}/${a.name}`;

/** How a person installs it themselves, per platform: the line the share screens show beside Download. */
export function installCommand(platform: string = process.platform): string {
  if (platform === "darwin") return "brew install cloudflared";
  if (platform === "win32") return "winget install --id Cloudflare.cloudflared";
  if (platform === "linux") return "Install the cloudflared package from pkg.cloudflare.com (Debian, Ubuntu, Fedora, RHEL), or your distribution's own.";
  return "Install cloudflared from github.com/cloudflare/cloudflared/releases and put it on PATH.";
}
