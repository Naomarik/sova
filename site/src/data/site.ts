// One place for the facts the page repeats. Bump `release` (and re-verify every claim on the page
// against that tag) when a new release is tagged.

export const release = "v0.2.0";
export const repo = "https://github.com/Naomarik/sova";
export const installUrl = `https://raw.githubusercontent.com/Naomarik/sova/${release}/scripts/install.sh`;
export const installCommand = `curl -fsSL ${installUrl} | bash`;
export const installScript = `${repo}/blob/${release}/scripts/install.sh`;
export const license = `${repo}/blob/master/LICENSE`;
export const contributing = `${repo}/blob/master/CONTRIBUTING.md`;
export const gettingStarted = `${repo}/blob/master/docs/getting-started.md`;
export const customization = `${repo}/blob/master/docs/customization.md`;
export const meshDoc = `${repo}/blob/master/docs/mesh.md`;
export const publicLinksDoc = `${repo}/blob/master/docs/public-links.md`;
export const modeExtension = `${repo}/blob/master/pi-config/extensions/mode/README.md`;
export const subagentsExtension = `${repo}/blob/master/pi-config/extensions/subagents/README.md`;
export const piConfig = `${repo}/tree/master/pi-config`;
export const pi = "https://pi.dev";

// The revision and date the page's claims were checked against (derive-website playbook).
export const verified = { ref: "master", rev: "9f94e69", date: "2026-09-28" };

// The revision and date the /docs pages were written from Sova's spec and checked against its source.
export const docsVerified = { rev: "92d26fc6", date: "2026-10-08" };
