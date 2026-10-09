// One place for the facts the page repeats. Until a release is tagged the site installs master,
// which master's install.sh installs by default. When a release is tagged (its commit sets
// install.sh's default ref to the tag), set `release` to the tag (and re-verify every claim on the
// page against it); the install URLs, command and labels follow. Also update the master command in
// content/docs/install.md.

export const release: string | null = null;
export const installRef = release ?? "master";
export const repo = "https://github.com/Naomarik/sova";
export const installUrl = `https://raw.githubusercontent.com/Naomarik/sova/${installRef}/scripts/install.sh`;
export const installCommand = `curl -fsSL ${installUrl} | bash`;
export const installScript = `${repo}/blob/${installRef}/scripts/install.sh`;
// The hero pill: the tagged release, or before one exists, master's commit history.
export const releaseLabel = release ?? "Pre-release · master";
export const releaseUrl = release ? `${repo}/releases/tag/${release}` : `${repo}/commits/master`;
export const license = `${repo}/blob/master/LICENSE`;
export const contributing = `${repo}/blob/master/CONTRIBUTING.md`;
export const gettingStarted = `${repo}/blob/master/docs/getting-started.md`;
export const customization = `${repo}/blob/master/docs/customization.md`;
export const meshDoc = `${repo}/blob/master/docs/mesh.md`;
export const publicLinksDoc = `${repo}/blob/master/docs/public-links.md`;
export const piConfig = `${repo}/tree/master/pi-config`;
export const pi = "https://pi.dev";

// The revision and date the page's claims were checked against (derive-website playbook).
export const verified = { ref: "master", rev: "9f94e69", date: "2026-09-28" };

// The revision and date the /docs pages were written from Sova's spec and checked against its source.
export const docsVerified = { rev: "92d26fc6", date: "2026-10-08" };
