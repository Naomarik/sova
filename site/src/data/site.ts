// One place for the facts the page repeats. The site installs `stable`, the one tag that moves:
// each release points it at its own numbered tag (vX.Y.Z), and numbered tags never move, so the
// install URL, command and script link stay the same across releases. `release` names the
// numbered tag `stable` points at; it drives only the hero pill's label and its release-page link.
// A release sets it in its release commit (and re-verifies every claim on the page against it):
// .sova/playbooks/release/PLAYBOOK.md.

export const release = "v0.4.0";
export const installRef = "stable";
export const repo = "https://github.com/Naomarik/sova";
export const installUrl = `https://raw.githubusercontent.com/Naomarik/sova/${installRef}/scripts/install.sh`;
export const installCommand = `curl -fsSL ${installUrl} | bash`;
export const installScript = `${repo}/blob/${installRef}/scripts/install.sh`;
// The hero pill: the release `stable` points at, linking to its release page.
export const releaseLabel = release;
export const releaseUrl = `${repo}/releases/tag/${release}`;
export const license = `${repo}/blob/master/LICENSE`;
export const contributing = `${repo}/blob/master/CONTRIBUTING.md`;
export const gettingStarted = `${repo}/blob/master/docs/getting-started.md`;
export const customization = `${repo}/blob/master/docs/customization.md`;
export const meshDoc = `${repo}/blob/master/docs/mesh.md`;
export const publicLinksDoc = `${repo}/blob/master/docs/public-links.md`;
export const piConfig = `${repo}/tree/master/pi-config`;
export const pi = "https://pi.dev";

// The revision and date the page's claims were checked against (derive-website playbook).
export const verified = { ref: "master", rev: "0ba0e92c", date: "2026-10-13" };

// The revision and date the /docs pages were written from Sova's spec and checked against its source.
export const docsVerified = { rev: "094c968e", date: "2026-10-16" };
