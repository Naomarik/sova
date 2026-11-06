#!/usr/bin/env node
// project-setup: the Setup chat's mechanical reading, drawing, formatting and checking
// (playbooks/project-setup/PLAYBOOK.md). It reads the repository and writes only the files `fmt` is
// asked to format. It never runs a project command, a check, a build, a deploy or a release step,
// never contacts a remote or a target, and never calls Sova. Node builtins, plus Sova's own parser
// (shared/project-contract.ts) and the drivers of the playbooks it folds in, imported for their
// readers: project-verbs (the services and the canonical form), release-maker (release candidates
// and the release check), project-deploy (deploy lints).
//
//   node scripts/project-setup.mjs investigate [--root <checkout>] [--json]
//     what the repository says, for any stack: languages and build tools, test runners, lint and
//     type checks, the commands its CI runs, lockfiles (merge.install inputs), monorepo and Nix
//     markers, containers, hosting and deploy files, mobile and store files, release material
//     (tags, version files, changelogs, release automation), services and datastores, remotes and
//     the landing way origin suggests, and the setup already at HEAD. Read, never run. Exit 0.
//   node scripts/project-setup.mjs draw [--root …] [--ref <rev> | --worktree] [--base <rev>] [--plain]
//     the pipeline a definition declares, as a `vis steps` block (landing, each check with its
//     command and limit, the release's steps marked Sova / Before publish / After publish / Held for
//     you, each deploy target's steps): --ref (default HEAD) reads it from a commit, --worktree from
//     the file on disk. --base marks each row that differs from that commit's. --plain prints a
//     numbered list instead. Exit 0, 1 when the definition doesn't parse.
//   node scripts/project-setup.mjs fmt [--root …] [--check]
//     the canonical form of .sova/project.json and of the release playbook's release.json.
//   node scripts/project-setup.mjs check [--root …] [--base <rev>] [--json]
//     Sova's parser on the whole definition, then what it can't see: per section (merge, release,
//     deploy) the lints of the folded-in drivers and the queue's own refusals (a release on a project
//     that lands by request, a shell string in a check, a review or request folder that is missing).
//     --base lists the sections changed since that commit and whether the services' hash moved.
//     Exit 0 ok, 1 problems, 2 couldn't check.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { CONTRACT_FILE, formatText, inspect } from "../../project-verbs/scripts/project-verbs.mjs";
import { MANIFEST, candidates as releaseCandidates, check as releaseCheck, formatManifest } from "../../release-maker/scripts/release-maker.mjs";
import { deployProblems } from "../../project-deploy/scripts/project-deploy.mjs";

const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}
const git = (root, ...a) => sh("git", ["-C", root, ...a], root);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

async function loadContract() {
  try {
    const c = await import(new URL("../../../shared/project-contract.ts", import.meta.url).href);
    return typeof c.parseDefinition === "function" ? c : null;
  } catch {
    return null;
  }
}

// ---- investigate ---------------------------------------------------------------------------------

/** Marker files → what they say. A marker is a path at any depth up to 3 unless it starts with "/". */
export const ECOSYSTEMS = [
  ["JavaScript/TypeScript", ["package.json", "deno.json", "deno.jsonc", "bun.lockb", "bun.lock", "tsconfig.json"]],
  ["Python", ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "tox.ini", "noxfile.py", "uv.lock", "poetry.lock"]],
  ["Go", ["go.mod", "go.work"]],
  ["Rust", ["Cargo.toml"]],
  ["JVM (Java/Kotlin/Scala)", ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "build.sbt", "gradlew", "mvnw"]],
  ["Clojure", ["deps.edn", "project.clj", "bb.edn", "shadow-cljs.edn", "build.clj"]],
  ["Ruby", ["Gemfile", "Rakefile", ".ruby-version", "config.ru"]],
  ["PHP", ["composer.json", "artisan", "phpunit.xml", "phpunit.xml.dist"]],
  [".NET", ["global.json", "Directory.Build.props", "*.sln", "*.csproj", "*.fsproj"]],
  ["Elixir/Erlang", ["mix.exs", "rebar.config"]],
  ["Haskell", ["stack.yaml", "cabal.project", "*.cabal"]],
  ["Swift/iOS", ["Package.swift", "Podfile", "*.xcodeproj", "*.xcworkspace"]],
  ["Android", ["AndroidManifest.xml", "app/build.gradle", "app/build.gradle.kts"]],
  ["Flutter/Dart", ["pubspec.yaml"]],
  ["React Native/Expo", ["app.json", "eas.json", "metro.config.js"]],
  ["C/C++", ["CMakeLists.txt", "meson.build", "configure.ac", "conanfile.txt", "vcpkg.json"]],
  ["Zig", ["build.zig"]],
  ["Static site", ["index.html", "_config.yml", "hugo.toml", "config.toml", "mkdocs.yml", "astro.config.mjs", "docusaurus.config.js", "eleventy.config.js", ".eleventy.js"]],
];
export const TASK_RUNNERS = ["Makefile", "justfile", "Justfile", "Taskfile.yml", "Taskfile.yaml", "bb.edn", "Rakefile", "noxfile.py", "tox.ini", "magefile.go", "build.zig"];
export const MONOREPO = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "rush.json", "go.work", "Cargo.toml[workspace]", "package.json[workspaces]", "settings.gradle", "WORKSPACE", "MODULE.bazel", "BUILD.bazel", "pants.toml"];
export const TOOLCHAINS = ["mise.toml", ".mise.toml", ".tool-versions", ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".java-version", "rust-toolchain", "rust-toolchain.toml", ".sdkmanrc", "flake.nix", "shell.nix", "default.nix", "devenv.nix", "devbox.json", ".envrc"];
export const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "deno.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "requirements.txt", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock", "mix.lock", "pubspec.lock", "Podfile.lock", "gradle.lockfile", "packages.lock.json", "flake.lock", "deps.edn", "project.clj"];
export const CONTAINERS = ["Dockerfile", "Containerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", ".devcontainer/devcontainer.json", "skaffold.yaml", "tilt.json", "Tiltfile"];
/** Hosting and infrastructure markers: what each suggests as a deploy target kind. */
export const HOSTING = [
  ["fly.toml", "Fly.io app"],
  ["render.yaml", "Render blueprint"],
  ["vercel.json", "Vercel"],
  ["netlify.toml", "Netlify"],
  ["wrangler.toml", "Cloudflare Workers/Pages"],
  ["wrangler.json", "Cloudflare Workers/Pages"],
  ["wrangler.jsonc", "Cloudflare Workers/Pages"],
  ["firebase.json", "Firebase Hosting/Functions"],
  ["app.yaml", "Google App Engine"],
  ["app.json", "Heroku app manifest (or an Expo app)"],
  ["Procfile", "Heroku-style process file (Heroku, Dokku, a PaaS)"],
  ["railway.json", "Railway"],
  ["railway.toml", "Railway"],
  ["amplify.yml", "AWS Amplify"],
  ["serverless.yml", "Serverless Framework (AWS Lambda…)"],
  ["template.yaml", "AWS SAM"],
  ["samconfig.toml", "AWS SAM"],
  ["cdk.json", "AWS CDK"],
  ["Pulumi.yaml", "Pulumi"],
  ["*.tf", "Terraform"],
  ["Chart.yaml", "Helm chart (Kubernetes)"],
  ["kustomization.yaml", "Kustomize (Kubernetes)"],
  ["k8s/", "Kubernetes manifests"],
  ["kubernetes/", "Kubernetes manifests"],
  ["manifests/", "Kubernetes manifests (maybe)"],
  ["ansible/", "Ansible"],
  ["playbook.yml", "Ansible (maybe)"],
  ["inventory", "Ansible inventory (maybe)"],
  ["Capfile", "Capistrano"],
  ["config/deploy.rb", "Capistrano / Kamal"],
  ["config/deploy.yml", "Kamal"],
  ["deploy/", "a deploy folder"],
  [".deploy/", "a deploy folder"],
  ["nixops.nix", "NixOps"],
  ["*.service", "a systemd unit"],
  ["Caddyfile", "Caddy (a VPS web server)"],
  ["fastlane/Fastfile", "fastlane (App Store / Play Store)"],
  ["eas.json", "Expo EAS build/submit (stores)"],
  ["codemagic.yaml", "Codemagic (mobile CI/CD)"],
  ["electron-builder.yml", "electron-builder (desktop installers)"],
  ["electron-builder.json", "electron-builder (desktop installers)"],
  ["tauri.conf.json", "Tauri (desktop installers)"],
  [".goreleaser.yml", "GoReleaser (binaries, archives, registries)"],
  [".goreleaser.yaml", "GoReleaser (binaries, archives, registries)"],
  ["snapcraft.yaml", "Snap Store"],
  ["*.spec", "RPM spec (maybe)"],
  ["debian/control", "a Debian package"],
  ["mkdocs.yml", "a docs site (MkDocs)"],
  ["CNAME", "GitHub Pages (custom domain)"],
];
export const CI_FILES = [".gitlab-ci.yml", "Jenkinsfile", ".circleci/config.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", ".travis.yml", ".drone.yml", ".woodpecker.yml", "buildkite.yml", ".buildkite/pipeline.yml", "cloudbuild.yaml", "appveyor.yml", ".github/workflows/"];
/** Words that make a command a check candidate, and what kind it is. */
const CHECK_WORDS = [
  [/\b(test|tests|spec|pytest|jest|vitest|mocha|rspec|phpunit|kaocha|ctest|go test|cargo test|mix test|dotnet test|gradle\w* test|mvn\w* (verify|test)|xcodebuild test|flutter test)\b/i, "test"],
  [/\b(lint|eslint|biome|ruff|flake8|pylint|clippy|golangci|clj-kondo|rubocop|phpstan|psalm|credo|ktlint|detekt|swiftlint|stylelint|shellcheck|hadolint)\b/i, "lint"],
  [/\b(typecheck|type-check|tsc|mypy|pyright|dialyzer|sorbet|flow)\b/i, "types"],
  [/\b(fmt|format|prettier|black|gofmt|rustfmt|cljfmt|mix format|dotnet format)\b.*\b(check|--check|-l|--diff|verify)\b|\b(fmt:check|format:check|check-format)\b/i, "format"],
  [/\b(build|compile|bundle|assemble|package|uberjar|vite build|next build|cargo build|go build|mvn\w* package|gradle\w* (build|assemble)|dotnet build|mix compile)\b/i, "build"],
  [/\b(e2e|playwright|cypress|selenium|detox|maestro)\b/i, "e2e"],
  [/\b(audit|cargo deny|npm audit|pip-audit|bundler-audit|trivy|gitleaks|trufflehog)\b/i, "audit"],
];
const kindOf = (cmd) => CHECK_WORDS.filter(([re]) => re.test(cmd)).map(([, k]) => k);

/** Paths matching a marker among `files` (tracked paths), depth ≤ 3. */
function matches(files, marker) {
  const depthOk = (f) => f.split("/").length <= 4 && !/(^|\/)(node_modules|vendor|\.git|dist|build|target)\//.test(f);
  if (marker.endsWith("/")) return files.some((f) => f.startsWith(marker) || f.includes(`/${marker}`)) ? [marker] : [];
  if (marker.includes("*")) {
    const re = new RegExp(`(^|/)${marker.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return files.filter((f) => depthOk(f) && re.test(f)).slice(0, 5);
  }
  return files.filter((f) => depthOk(f) && (f === marker || f.endsWith(`/${marker}`))).slice(0, 5);
}

/** The `run:` / `script:` lines of CI files: the commands a project already gates on. Read, never run. */
export function ciCommands(text, file) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = /^\s*-?\s*run:\s*(.*)$/.exec(l) ?? (file.endsWith(".gitlab-ci.yml") || file.includes("bitbucket") || file.includes(".travis") ? /^\s*-\s+(?!name:|uses:|image:)(.+)$/.exec(l) : null);
    if (!m) continue;
    let cmd = m[1].trim();
    if (cmd === "|" || cmd === ">" || cmd === "|-" || cmd === ">-" || cmd === "") {
      const indent = /^\s*/.exec(lines[i + 1] ?? "")?.[0].length ?? 0;
      const block = [];
      for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || (/^\s*/.exec(lines[j])?.[0].length ?? 0) >= indent); j++) if (lines[j].trim()) block.push(lines[j].trim());
      cmd = block.join(" && ");
    }
    if (cmd && !/^\$\{\{|^echo\b|^cd\b\s*$/.test(cmd)) out.push({ file, line: i + 1, cmd: cmd.slice(0, 200), kinds: kindOf(cmd) });
  }
  return out;
}

/** Commands the repository names (package scripts, task runner targets, CI steps) that look like checks. */
function checkCandidates(root, files, insp) {
  const out = [];
  const at = (f) => git(root, "show", `HEAD:${f}`);
  const pkg = insp?.details?.["package.json"];
  if (pkg?.scripts) for (const [k, v] of Object.entries(pkg.scripts)) {
    const kinds = kindOf(`${k} ${v}`);
    if (kinds.length) out.push({ from: "package.json", name: k, cmd: String(v), kinds });
  }
  for (const t of insp?.details?.["bb.edn"]?.tasks ?? []) {
    const kinds = kindOf(`${t.name} ${t.doc ?? ""}`);
    if (kinds.length) out.push({ from: "bb.edn", name: t.name, cmd: `bb ${t.name}`, kinds });
  }
  for (const mf of ["Makefile", "justfile", "Justfile"]) {
    if (!files.includes(mf)) continue;
    for (const m of (at(mf) ?? "").matchAll(/^([A-Za-z][\w.:-]*)\s*:(?!=)/gm)) {
      const kinds = kindOf(m[1]);
      if (kinds.length) out.push({ from: mf, name: m[1], cmd: `${mf === "Makefile" ? "make" : "just"} ${m[1]}`, kinds });
    }
  }
  for (const tf of ["Taskfile.yml", "Taskfile.yaml"]) {
    if (!files.includes(tf)) continue;
    for (const m of (at(tf) ?? "").matchAll(/^ {2}([A-Za-z][\w.:-]*):\s*$/gm)) {
      const kinds = kindOf(m[1]);
      if (kinds.length) out.push({ from: tf, name: m[1], cmd: `task ${m[1]}`, kinds });
    }
  }
  const py = at("pyproject.toml");
  if (py) {
    if (/\[tool\.pytest/.test(py) || files.some((f) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f))) out.push({ from: "pyproject.toml", name: "pytest", cmd: "pytest", kinds: ["test"] });
    if (/\[tool\.ruff/.test(py)) out.push({ from: "pyproject.toml", name: "ruff", cmd: "ruff check .", kinds: ["lint"] });
    if (/\[tool\.mypy/.test(py)) out.push({ from: "pyproject.toml", name: "mypy", cmd: "mypy .", kinds: ["types"] });
  }
  if (files.includes("go.mod")) out.push({ from: "go.mod", name: "go test", cmd: "go test ./...", kinds: ["test"] }, { from: "go.mod", name: "go vet", cmd: "go vet ./...", kinds: ["lint"] });
  if (files.includes("Cargo.toml")) out.push({ from: "Cargo.toml", name: "cargo test", cmd: "cargo test --locked", kinds: ["test"] }, { from: "Cargo.toml", name: "cargo clippy", cmd: "cargo clippy --locked -- -D warnings", kinds: ["lint"] });
  if (files.includes("mix.exs")) out.push({ from: "mix.exs", name: "mix test", cmd: "mix test", kinds: ["test"] });
  if (files.includes("composer.json")) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(at("composer.json") ?? "{}").scripts ?? {})) {
        const kinds = kindOf(`${k} ${Array.isArray(v) ? v.join(" ") : v}`);
        if (kinds.length) out.push({ from: "composer.json", name: k, cmd: `composer run ${k}`, kinds });
      }
    } catch {}
  }
  if (files.includes("Gemfile")) {
    if (files.some((f) => f.startsWith("spec/"))) out.push({ from: "Gemfile", name: "rspec", cmd: "bundle exec rspec", kinds: ["test"] });
    else if (files.some((f) => f.startsWith("test/"))) out.push({ from: "Gemfile", name: "rails/minitest", cmd: "bin/rails test", kinds: ["test"] });
  }
  if (files.includes("gradlew")) out.push({ from: "gradlew", name: "gradle check", cmd: "./gradlew check", kinds: ["test", "lint"] });
  else if (files.includes("mvnw") || files.includes("pom.xml")) out.push({ from: "pom.xml", name: "maven verify", cmd: `${files.includes("mvnw") ? "./mvnw" : "mvn"} -B verify`, kinds: ["test", "build"] });
  if (files.some((f) => /\.(sln|csproj|fsproj)$/.test(f))) out.push({ from: ".NET", name: "dotnet test", cmd: "dotnet test", kinds: ["test"] });
  if (files.includes("pubspec.yaml")) out.push({ from: "pubspec.yaml", name: "flutter test", cmd: "flutter test", kinds: ["test"] });
  return out;
}

function originOf(root) {
  const url = git(root, "remote", "get-url", "origin")?.trim();
  if (!url) return { url: null, host: null, suggests: "local", why: "no origin remote: Merge locally, nothing pushed" };
  const host = (/^[\w.+-]+@([^:]+):/.exec(url) ?? /^\w+:\/\/(?:[^@/]+@)?([^/:]+)/.exec(url))?.[1] ?? null;
  // The URL itself never goes in a report: it may name a private host. Only its kind does.
  if (host === "github.com") return { host: "github.com", suggests: "github-pr", why: "origin is on github.com: Sova suggests Pull request; Merge locally is still the default until the user picks" };
  if (host && (host === "gitlab.com" || host.startsWith("gitlab."))) return { host: "gitlab", suggests: "gitlab-mr", why: "origin is on a GitLab host: Sova suggests Merge request" };
  return { host: "other", suggests: "local", why: "origin is on another host: Merge locally (or Push branch only)" };
}

export async function investigate(root) {
  const head = git(root, "rev-parse", "HEAD")?.trim();
  if (!head) return null;
  const files = (git(root, "ls-tree", "-r", "--name-only", "HEAD") ?? "").split("\n").filter(Boolean);
  const at = (f) => git(root, "show", `HEAD:${f}`);
  const insp = await inspect(root);
  const rel = releaseCandidates(root);

  const ecosystems = [];
  for (const [name, markers] of ECOSYSTEMS) {
    const found = markers.flatMap((m) => matches(files, m));
    if (found.length) ecosystems.push({ name, files: [...new Set(found)].slice(0, 6) });
  }
  const list = (markers) => [...new Set(markers.flatMap((m) => matches(files, m)))];
  const monorepo = [];
  for (const m of MONOREPO) {
    if (m === "Cargo.toml[workspace]") (at("Cargo.toml") ?? "").includes("[workspace]") && monorepo.push("Cargo.toml [workspace]");
    else if (m === "package.json[workspaces]") /"workspaces"\s*:/.test(at("package.json") ?? "") && monorepo.push("package.json workspaces");
    else if (files.includes(m)) monorepo.push(m);
  }
  const hosting = [];
  for (const [m, what] of HOSTING) for (const f of matches(files, m)) hosting.push({ file: f, what });
  const ci = list(CI_FILES).length ? [...new Set(files.filter((f) => CI_FILES.some((c) => (c.endsWith("/") ? f.startsWith(c) && /\.ya?ml$/.test(f) : f === c))))] : [];
  const ciCmds = ci.flatMap((f) => ciCommands(at(f) ?? "", f)).slice(0, 60);

  let def = null;
  const defText = at(CONTRACT_FILE);
  if (defText) {
    try {
      def = JSON.parse(defText);
    } catch {}
  }
  const extra = (p) => existsSync(join(root, p));
  return {
    root,
    head,
    branch: git(root, "rev-parse", "--abbrev-ref", "HEAD")?.trim() ?? null,
    ecosystems,
    taskRunners: list(TASK_RUNNERS),
    monorepo,
    toolchains: list(TOOLCHAINS),
    lockfiles: list(LOCKFILES).filter((f) => f.split("/").length <= 3),
    containers: list(CONTAINERS),
    ci,
    ciCommands: ciCmds,
    checks: checkCandidates(root, files, insp),
    services: insp ? { stack: insp.stack, details: insp.details, tests: insp.tests, prodData: insp.prodData, tools: insp.tools, mise: insp.mise, staticSite: insp.staticSite, docs: insp.docs } : null,
    deployEntrypoints: insp?.deploy ?? [],
    hosting,
    release: rel ? { tags: rel.tags, versions: rel.versions, changelogs: rel.changelogs, automation: rel.automation, ignored: rel.ignored } : null,
    remotes: rel?.remotes ?? [],
    origin: originOf(root),
    setup: {
      definition: defText ? (def ? "present" : "not JSON") : "none",
      sections: def ? Object.keys(def).filter((k) => ["services", "test", "merge", "release", "deploy", "share", "setup"].includes(k)) : [],
      mergePlaybook: extra(".sova/playbooks/merge-queue/PLAYBOOK.md"),
      reviewKit: typeof def?.merge?.review === "string" ? def.merge.review : null,
      requestKit: typeof def?.merge?.request === "string" ? def.merge.request : null,
      releasePlaybook: typeof def?.release?.playbook === "string" ? def.release.playbook : null,
      spec: extra(".sova/spec/manifest.json"),
    },
  };
}

function investigateDigest(x) {
  const o = [];
  const line = (label, v) => o.push(`${label}: ${Array.isArray(v) ? (v.length ? v.join(", ") : "none") : v}`);
  o.push(`project-setup investigate: ${x.root} at ${x.head.slice(0, 12)} on ${x.branch} (read at HEAD; offer what it finds, measure it in your own copy, never assume)`);
  o.push("");
  o.push("stack:");
  for (const e of x.ecosystems) o.push(`  ${e.name}: ${e.files.join(", ")}`);
  if (!x.ecosystems.length) o.push("  nothing recognised: read the tree and ask");
  line("task runners", x.taskRunners);
  line("monorepo markers", x.monorepo);
  line("toolchain / env managers", x.toolchains);
  line("lockfiles (merge.install inputs)", x.lockfiles);
  line("containers", x.containers);
  o.push("");
  o.push("check candidates (the repository's own commands; measure each in your copy before you offer it):");
  for (const c of x.checks) o.push(`  [${c.kinds.join("/")}] ${c.from} ${c.name}: ${c.cmd}`);
  if (!x.checks.length) o.push("  none found: ask how they check a change today");
  o.push(`CI files: ${x.ci.length ? x.ci.join(", ") : "none"}`);
  for (const c of x.ciCommands) o.push(`  ${c.file}:${c.line}${c.kinds.length ? ` [${c.kinds.join("/")}]` : ""}: ${c.cmd}`);
  o.push("");
  if (x.services) {
    o.push(`services material: stack files ${x.services.stack.join(", ") || "none"}${x.services.staticSite ? `; static site (${x.services.staticSite})` : ""}`);
    for (const t of x.services.tests) o.push(`  tests: ${t}`);
    for (const d of x.services.prodData) o.push(`  production data brought here: ${d}`);
    o.push(`  tools named: ${Object.entries(x.services.tools).map(([t, p]) => `${t}${p ? "" : " (missing here)"}`).join(", ") || "none"}`);
    o.push("  (project-verbs inspect has the full services digest: ports, datastores, gitignored files)");
  }
  o.push("");
  o.push("hosting / deploy material (read each; never run one):");
  for (const h of x.hosting) o.push(`  ${h.file}: ${h.what}`);
  for (const d of x.deployEntrypoints) o.push(`  entrypoint: ${d}`);
  if (!x.hosting.length && !x.deployEntrypoints.length) o.push("  none found: ask where it ships, if anywhere");
  o.push("");
  if (x.release) {
    o.push("release material:");
    o.push(`  tags: ${x.release.tags.patterns.length ? x.release.tags.patterns.map((p) => `${p.pattern} ×${p.count} (newest ${p.newest.join(", ")})`).join("; ") : "none: a first release"}${x.release.tags.moving.length ? `; moving: ${x.release.tags.moving.map((m) => m.tag).join(", ")}` : ""}`);
    o.push(`  version files: ${x.release.versions.map((v) => `${v.file} ${v.version}`).join(", ") || "none"}`);
    o.push(`  changelogs: ${x.release.changelogs.map((c) => c.file).join(", ") || "none"}`);
    o.push(`  release automation: ${x.release.automation.join("; ") || "none"}`);
    o.push(`  ignored build folders (artifacts may go there): ${x.release.ignored.join(", ") || "none"}`);
  }
  o.push(`remotes: ${x.remotes.join(", ") || "none"}; ${x.origin.why}`);
  o.push("");
  o.push(`setup at HEAD: .sova/project.json ${x.setup.definition}${x.setup.sections.length ? ` (${x.setup.sections.join(", ")})` : ""}; merge-thread playbook ${x.setup.mergePlaybook ? "yes" : "no"}; review kit ${x.setup.reviewKit ?? "none"}; request kit ${x.setup.requestKit ?? "none"}; release playbook ${x.setup.releasePlaybook ?? "none"}; spec ${x.setup.spec ? "yes (landings make drafts official)" : "no"}`);
  o.push("next: draw the current setup (draw), then the interview (references/questions.md).");
  return o.join("\n");
}

// ---- draw ----------------------------------------------------------------------------------------

const q = (s) => `"${String(s).replace(/["|]/g, "'").replace(/\s+/g, " ").trim().slice(0, 190)}"`;
const argvText = (a) => a.map((x) => (/\s/.test(x) ? `'${x}'` : x)).join(" ");
const mins = (s) => (s % 60 === 0 ? `${s / 60} min` : s < 60 ? `${s} s` : `${Math.round(s / 6) / 10} min`);
const short = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The pipeline rows a parsed definition declares, each {lane, label, tone, steps: [{text, tone?}], outcome}. Pure. */
export function pipelineRows(def, extras = {}) {
  const rows = [];
  const target = def.merge?.target ?? extras.target ?? "main";
  const land = def.merge?.land ?? "local";
  const checks = def.merge?.checks;
  const served = checks !== undefined || !!def.test;
  const lane = "Each approved branch";
  const s = [{ text: `Merge onto newest ${target} in the merge copy` }];
  if (def.setup?.length) s.push({ text: `Setup: ${def.setup.map((x) => x.id).join(", ")}` });
  if (def.merge?.install) s.push({ text: `Install when ${def.merge.install.inputs.join(", ")} change: ${short(argvText(def.merge.install.run), 50)}` });
  if (extras.spec) s.push({ text: "Spec drafts made official" });
  const checkText = (c) => `${c.label}: ${short(argvText(c.run))} (≤ ${mins(c.timeout)}${c.requires.length ? `, needs ${c.requires.join(", ")}` : ""})`;
  const required = Array.isArray(checks) ? checks.filter((x) => !x.optional) : [];
  if (required.length) s.push({ text: `The ${required.length} required check(s), in order (below)` });
  else if (checks === "none") s.push({ text: "No checks declared", tone: "warn" });
  else if (def.test) s.push({ text: `Tests (the test command, no merge checks): ${short(argvText(def.test.run))} (≤ ${mins(def.test.timeout)}${def.test.requires?.length ? `, needs ${def.test.requires.join(", ")}` : ""})` });
  else s.push({ text: "Not set up: no checks", tone: "error" });
  if (def.merge?.review) s.push({ text: `Review with ${def.merge.review}` });
  s.push({ text: land === "local" ? `${target} moves to the tested commit` : land === "github-pr" ? "Pull request opened on GitHub" : land === "gitlab-mr" ? "Merge request opened on GitLab" : "Branch pushed" });
  if (land === "local" && def.merge?.push !== false) s.push({ text: "Push (leak scan first)" });
  rows.push({ lane, label: "Landing", tone: served ? "ok" : "error", steps: s, outcome: served ? `${required.length || (checks === "none" ? 0 : 1)} required check(s)` : "not served" });
  if (required.length) rows.push(...chunk({ lane, label: "Required checks", tone: "ok", steps: required.map((c) => ({ text: checkText(c) })), outcome: "every branch" }));
  const optional = Array.isArray(checks) ? checks.filter((x) => x.optional) : [];
  if (optional.length) rows.push(...chunk({ lane, label: "Picked by the merge thread", tone: "info", steps: optional.map((c) => ({ text: checkText(c) })), outcome: "only when picked" }));
  if (def.release) {
    const r = def.release;
    const phase = { prepare: "Before publish", check: "Before publish", after: "After publish", withdraw: "After a withdraw" };
    const m = extras.manifest?.steps ?? [];
    const step = (x) => ({ text: `${x.label} · ${phase[x.phase]}${x.held ? " · Held for you" : ""}`, ...(x.held ? { tone: "warn" } : {}) });
    const before = m.filter((y) => y.phase === "prepare").map(step);
    before.push({ text: `Sova: checks (landing set${r.checkIds.length ? ` + ${r.checkIds.join(", ")}` : ""})`, tone: "muted" });
    before.push(...m.filter((y) => y.phase === "check").map(step));
    if (!m.length) before.unshift({ text: extras.manifestError ? `release.json: ${extras.manifestError}` : "no release.json read", tone: "error" });
    rows.push(...chunk({ lane: "A release", label: `Release ${r.tag}`, tone: "ok", steps: before, outcome: `${r.commit ? "release commit" : "tag-only"}, ${r.scheme}` }));
    const after = [{ text: `Sova: Publish ${r.tag}${r.channels.length ? `, moves ${r.channels.join(", ")}` : ""} (your click)`, tone: "accent" }, ...m.filter((y) => y.phase === "after").map(step)];
    rows.push(...chunk({ lane: "A release", label: "Publish and after", tone: "accent", steps: after, outcome: extras.pushes === false ? "on this machine only" : "one atomic push" }));
    const wd = m.filter((y) => y.phase === "withdraw");
    if (wd.length) rows.push({ lane: "A release", label: "After a withdraw", tone: "muted", steps: [{ text: `Sova: moves ${r.channels.join(", ") || "nothing"} back`, tone: "muted" }, ...wd.map((x) => ({ text: `${x.label} · ${phase.withdraw}` }))], outcome: "only on Withdraw" });
  }
  for (const t of def.deploy?.targets ?? []) {
    const st = [{ text: `Plan (your click): on ${t.branch ?? target}, pushed${t.releases ? ", a release" : ""}, tests ${t.requires.tests}${t.credentials.length ? `, ${t.credentials.map((c) => c.name).join(", ")} checked` : ""}`, tone: "accent" }];
    for (const x of t.plan) st.push({ text: `dry run ${x.id}: ${short(argvText(x.run), 50)}` });
    st.push({ text: "Run (your click, confirmed)", tone: "accent" });
    for (const x of t.build) st.push({ text: `build ${x.id}: ${short(argvText(x.run), 50)}` });
    for (const x of t.steps) st.push({ text: `${x.id}: ${short(argvText(x.run), 50)}` });
    if (t.verify) st.push({ text: `verify ${t.verify.http} → ${t.verify.expect}` });
    const rb = t.rollback === "redeploy-previous" ? "rollback: previous verified commit" : "none" in t.rollback ? `no rollback: ${t.rollback.none}` : `rollback: ${t.rollback.steps.map((x) => x.id).join(", ")}`;
    rows.push(...chunk({ lane: "Deploy (yours)", label: `Deploy ${t.name}`, tone: "info", steps: st, outcome: short(rb, 60) }));
  }
  return rows;
}

/** A vis steps row holds at most 10 steps: a longer one goes on in rows labelled "… (2)", "… (3)". Pure. */
export const ROW_MAX = 10;
export function chunk(row) {
  if (row.steps.length <= ROW_MAX) return [row];
  const out = [];
  for (let i = 0; i < row.steps.length; i += ROW_MAX) out.push({ ...row, label: i ? `${row.label} (${i / ROW_MAX + 1})` : row.label, steps: row.steps.slice(i, i + ROW_MAX), outcome: i + ROW_MAX >= row.steps.length ? row.outcome : "continues below" });
  return out;
}

/** The rows' `vis steps` block, with `mark` lines for rows that differ from `baseRows`. Pure. */
export function visSteps(rows, { title, caption, baseRows } = {}) {
  const o = ["```vis steps"];
  if (title) o.push(`title: ${title}`);
  if (caption) o.push(`caption: ${caption}`);
  const marks = [];
  if (baseRows) {
    const key = (r) => JSON.stringify(r.steps.map((s) => s.text));
    const before = new Map(baseRows.map((r) => [r.label, r]));
    for (const r of rows) {
      const b = before.get(r.label);
      if (!b) marks.push(`mark ${q(r.label)} accent "new"`);
      else if (key(b) !== key(r)) marks.push(`mark ${q(r.label)} accent "changed"`);
    }
    for (const b of baseRows) if (!rows.some((r) => r.label === b.label)) marks.push(`mark ${q(rows[0]?.label ?? b.label)} warn ${q(`removed: ${b.label}`)}`);
  }
  o.push(...marks.slice(0, 3));
  let lane = null;
  for (const r of rows) {
    if (r.lane !== lane) {
      o.push(`== ${r.lane} ==`);
      lane = r.lane;
    }
    o.push(`${q(r.label)} ${r.tone} | ${r.steps.map((s) => `${q(s.text)}${s.tone ? ` ${s.tone}` : ""}`).join(" -> ")}${r.outcome ? ` | ${q(r.outcome)}` : ""}`);
  }
  o.push("```");
  return o.join("\n");
}

export function plainList(rows) {
  const o = [];
  let lane = null;
  for (const r of rows) {
    if (r.lane !== lane) o.push(`${(lane = r.lane)}:`);
    o.push(`  ${r.label}${r.outcome ? ` (${r.outcome})` : ""}`);
    r.steps.forEach((s, i) => o.push(`    ${i + 1}. ${s.text}`));
  }
  return o.join("\n");
}

async function definitionAt(root, { ref, worktree }) {
  const c = await loadContract();
  if (!c) return { fatal: "Sova's parser (shared/project-contract.ts) could not be loaded: run this from Sova's playbooks/ folder" };
  const text = worktree ? readText(join(root, CONTRACT_FILE)) : git(root, "show", `${ref}:${CONTRACT_FILE}`);
  if (text === null) return { def: null, why: `no ${CONTRACT_FILE} ${worktree ? "on disk" : `at ${ref}`}` };
  let def;
  try {
    def = c.parseDefinition(text);
  } catch (err) {
    return { def: null, why: `${CONTRACT_FILE}${worktree ? "" : ` at ${ref}`} doesn't parse: ${err instanceof Error ? err.message : err}` };
  }
  let manifest = null;
  let manifestError = null;
  if (def.release) {
    const mPath = `${def.release.playbook}/${MANIFEST}`;
    const mText = worktree ? readText(join(root, mPath)) : git(root, "show", `${ref}:${mPath}`);
    if (mText === null) manifestError = `${mPath} is missing`;
    else {
      try {
        const rel = await import(new URL("../../../shared/release.ts", import.meta.url).href);
        manifest = rel.parseReleaseManifest(mText);
      } catch (err) {
        manifestError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const spec = worktree ? existsSync(join(root, ".sova/spec/manifest.json")) : git(root, "cat-file", "-e", `${ref}:.sova/spec/manifest.json`) !== null;
  return { def, manifest, manifestError, spec, text };
}

// ---- check ---------------------------------------------------------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "/bin/sh", "/bin/bash"]);
const IPV4 = /(^|[^\d.])((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/;
const SECRETISH = /(token|secret|password|passwd|apikey|api_key|bearer)\s*[=:]\s*\S{6,}|\b(ghp|gho|github_pat|sk|xox[bpa])[-_][A-Za-z0-9_]{12,}/i;
const HOME_PATH = /(^|[\s"'=])(\/home\/[^/\s]+|\/Users\/[^/\s]+|~\/)/;

function onPath(prog, root) {
  if (prog.includes("/")) return existsSync(resolve(root, prog));
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    try {
      if (d && statSync(join(d, prog)).isFile()) return true;
    } catch {}
  }
  return false;
}

/** Problems and notes about a merge section Sova's parser can't see. Pure but for file and PATH reads under `root`. */
export function mergeProblems(raw, def, root) {
  const problems = [];
  const notes = [];
  const m = def.merge;
  if (!m?.checks && !def.test) problems.push("merge: neither merge.checks nor test: the queue can't serve this project (declare checks, \"none\", or a test command)");
  const checks = Array.isArray(m?.checks) ? m.checks : [];
  const all = [...checks, ...(def.release?.checks ?? []).filter((c) => !checks.some((x) => x.id === c.id))];
  for (const c of all) {
    const where = checks.includes(c) ? `merge.checks.${c.id}` : `release.checks.${c.id}`;
    if (SHELLS.has(c.run[0]) && c.run.some((a) => a === "-c" || a === "-lc")) problems.push(`${where}: a shell string inside an argv; put the pipeline in a script under .sova/bin/ and run that`);
    for (const a of c.run) {
      if (IPV4.test(a.replace(/\$\{[^}]*\}/g, ""))) problems.push(`${where}: a literal IP address (${a})`);
      if (SECRETISH.test(a)) problems.push(`${where}: a value that looks like a secret; checks get no secrets`);
      if (HOME_PATH.test(a)) problems.push(`${where}: a home path (${a}); use \${checkout} or a path relative to the checkout`);
    }
    const prog = c.run[0];
    if (!/\$\{/.test(prog) && !onPath(prog, root)) notes.push(`${where}: ${prog} is not in this checkout or on this chat's PATH; the merge copy must have it (a trial proves it)`);
    const rawCheck = (Array.isArray(raw?.merge?.checks) ? raw.merge.checks : []).concat(Array.isArray(raw?.release?.checks) ? raw.release.checks.filter(isObj) : []).find((x) => isObj(x) && x.id === c.id);
    if (rawCheck && rawCheck.timeout === undefined) notes.push(`${where}: no timeout, so 600 s; set it to about twice the time you measured (at most 1800)`);
  }
  if (checks.some((c) => c.optional) && !existsSync(join(root, ".sova/playbooks/merge-queue/PLAYBOOK.md"))) notes.push("optional checks run only when the merge thread picks them; with no .sova/playbooks/merge-queue/PLAYBOOK.md (a blast-radius map) it picks by judgement alone");
  if (m?.review && !existsSync(join(root, m.review, "PLAYBOOK.md"))) problems.push(`merge.review: ${m.review}/PLAYBOOK.md is missing: the review step would have no kit`);
  if (m?.request && !existsSync(join(root, m.request))) problems.push(`merge.request: ${m.request} is missing`);
  for (const f of m?.install?.inputs ?? []) if (!existsSync(join(root, f))) problems.push(`merge.install.inputs: ${f} is not in the checkout`);
  if (def.release && m?.land && m.land !== "local") problems.push(`merge.land is "${m.land}": a release lands its commit on the target and pushes it itself, so Start Release is refused until it lands locally`);
  const remotes = (git(root, "remote") ?? "").split("\n").filter(Boolean);
  if (m?.push === true && !remotes.includes("origin")) notes.push("merge.push is true but there is no origin remote: nothing is pushed");
  if (m?.checks === "none") notes.push('merge.checks is "none": every landing reads "No checks declared"; a release still runs its own release.checks');
  return { problems, notes };
}

const SERVICE_KEYS = ["slots", "host", "setup", "data", "services", "open", "hooks", "test", "share"];
/** Top-level sections that differ between two raw definitions. */
export function changedSections(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
}

export async function check(root, { base } = {}) {
  const c = await loadContract();
  if (!c) return { ok: false, fatal: true, problems: ["Sova's parser (shared/project-contract.ts) could not be loaded: run this from Sova's playbooks/ folder"], notes: [] };
  const problems = [];
  const notes = [];
  const text = readText(join(root, CONTRACT_FILE));
  if (text === null) return { ok: false, fatal: false, problems: [`${CONTRACT_FILE} is missing`], notes };
  let def;
  try {
    def = c.parseDefinition(text);
  } catch (err) {
    return { ok: false, fatal: false, problems: [`${CONTRACT_FILE}: ${err instanceof Error ? err.message : String(err)}`], notes };
  }
  const raw = JSON.parse(text);
  try {
    if (formatText(text) !== text) problems.push(`${CONTRACT_FILE}: not in canonical form: run fmt`);
  } catch {}
  const mp = mergeProblems(raw, def, root);
  problems.push(...mp.problems);
  notes.push(...mp.notes);
  if (def.release) {
    const r = await releaseCheck(root);
    if (r.fatal) return { ok: false, fatal: true, problems: r.problems, notes };
    // release-maker's own canonical-form problem is the same as ours: keep one.
    problems.push(...r.problems.filter((p) => !p.startsWith(`${CONTRACT_FILE}: not in canonical form`)).map((p) => `release: ${p}`));
    notes.push(...r.notes.map((n) => `release: ${n}`));
  }
  if (def.deploy) {
    const d = deployProblems(raw);
    problems.push(...d.problems.map((p) => `deploy: ${p}`));
    notes.push(...d.notes.map((n) => `deploy: ${n}`));
    notes.push("deploy: prove it offline with project_verbs deploy.check {ref: <your branch>} (at most 3 runs); host values and env credentials are the operator's to set on this host");
  }
  let changed = null;
  if (base) {
    const bText = git(root, "show", `${base}:${CONTRACT_FILE}`);
    let b = null;
    try {
      b = bText ? JSON.parse(bText) : null;
    } catch {}
    changed = changedSections(b, raw);
    // The release playbook's folder is part of the release setup: a change there changes the section.
    if (def.release && !changed.includes("release") && (git(root, "diff", "--name-only", base, "--", def.release.playbook) ?? "").trim()) changed.push("release");
    if (def.release && !changed.includes("release") && (git(root, "status", "--porcelain", "--", def.release.playbook) ?? "").trim()) changed.push("release");
    // A problem already on the base, in a section this branch doesn't change, isn't this branch's:
    // it is told to the user as a note (fix it only when they agree).
    const section = (p) => (p.startsWith("release: ") ? "release" : p.startsWith("deploy: ") ? "deploy" : /^merge[.:]/.test(p) ? "merge" : null);
    if (b)
      for (const p of [...problems]) {
        const s = section(p);
        if (s && !changed.includes(s)) {
          problems.splice(problems.indexOf(p), 1);
          notes.push(`already on ${base}, in a section this branch doesn't change: ${p}`);
        }
      }
    if (changed.some((k) => SERVICE_KEYS.includes(k))) notes.push(`changes ${changed.filter((k) => SERVICE_KEYS.includes(k)).join(", ")}: the services definition's hash may move, so copies need a new conformance (project_verbs conform {ref: <your branch>}) before they run it`);
  }
  return { ok: problems.length === 0, fatal: false, problems, notes, changed, sections: { merge: !!def.merge, test: !!def.test, release: !!def.release, deploy: !!def.deploy } };
}

// ---- CLI -----------------------------------------------------------------------------------------

function args(list) {
  const o = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (["--json", "--check", "--worktree", "--plain"].includes(a)) o[a.slice(2)] = true;
    else if (["--root", "--ref", "--base"].includes(a)) o[a.slice(2)] = list[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let o;
  try {
    o = args(rest);
  } catch (err) {
    console.error(`project-setup: ${err.message}`);
    return 2;
  }
  const root = o.root ? resolve(o.root) : git(process.cwd(), "rev-parse", "--show-toplevel")?.trim();
  if (!root) return (console.error("project-setup: not inside a git checkout (pass --root)"), 2);
  const print = (v, digest) => console.log(o.json ? JSON.stringify(v, null, 2) : digest(v));

  if (cmd === "investigate") {
    const r = await investigate(root);
    if (!r) return (console.error("project-setup: can't read the repository's HEAD"), 2);
    print(r, investigateDigest);
    return 0;
  }
  if (cmd === "draw") {
    const at = await definitionAt(root, { ref: o.ref ?? "HEAD", worktree: !!o.worktree });
    if (at.fatal) return (console.error(`project-setup: ${at.fatal}`), 2);
    if (!at.def) return (console.log(`project-setup draw: ${at.why}: nothing is set up to draw`), 1);
    const target = git(root, "rev-parse", "--abbrev-ref", "HEAD")?.trim();
    const pushes = at.def.merge?.push !== false && (git(root, "remote") ?? "").split("\n").includes("origin");
    const rows = pipelineRows(at.def, { manifest: at.manifest, manifestError: at.manifestError, spec: at.spec, pushes, target: at.def.merge?.target ?? (target && target !== "HEAD" ? target : undefined) });
    let baseRows;
    if (o.base) {
      const b = await definitionAt(root, { ref: o.base });
      baseRows = b.def ? pipelineRows(b.def, { manifest: b.manifest, manifestError: b.manifestError, spec: b.spec }) : [];
    }
    if (o.json) console.log(JSON.stringify({ rows, baseRows }, null, 2));
    else if (o.plain) console.log(plainList(rows));
    else console.log(visSteps(rows, { title: o.base ? `The setup on this branch, against ${o.base}` : `The setup ${o.worktree ? "on disk" : `at ${o.ref ?? "HEAD"}`}`, caption: "Landing and release steps run by Sova; Publish, deploys and held steps wait for you.", baseRows }));
    return 0;
  }
  if (cmd === "fmt") {
    let code = 0;
    const defFile = join(root, CONTRACT_FILE);
    const files = [[defFile, formatText]];
    try {
      const pb = JSON.parse(readText(defFile) ?? "null")?.release?.playbook;
      if (typeof pb === "string") files.push([join(root, pb, MANIFEST), formatManifest]);
    } catch {}
    for (const [file, fmt] of files) {
      const text = readText(file);
      if (text === null) continue;
      let out;
      try {
        out = fmt(text);
      } catch (err) {
        console.log(`project-setup fmt: ${relative(root, file)} is not JSON: ${err.message}`);
        code = 1;
        continue;
      }
      if (out === text) console.log(`project-setup fmt: ${relative(root, file)} is canonical`);
      else if (o.check) (console.log(`project-setup fmt: ${relative(root, file)} is not canonical (run fmt without --check)`), (code = 1));
      else (writeFileSync(file, out), console.log(`project-setup fmt: rewrote ${relative(root, file)}`));
    }
    return code;
  }
  if (cmd === "check") {
    const r = await check(root, { base: o.base });
    print(r, (x) =>
      [
        `project-setup check: ${root}: ${x.ok ? "ok" : `${x.problems.length} problem(s)`}${x.sections ? ` — declares ${Object.entries(x.sections).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing of the pipeline"}` : ""}${x.changed ? `; changed since ${o.base}: ${x.changed.join(", ") || "nothing"}` : ""}`,
        ...x.problems.map((p) => `  problem: ${p}`),
        ...x.notes.map((n) => `  note: ${n}`),
      ].join("\n"),
    );
    return r.fatal ? 2 : r.ok ? 0 : 1;
  }
  console.error("usage: project-setup <investigate|draw|fmt|check> … (see the header of scripts/project-setup.mjs)");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`project-setup: ${err instanceof Error ? err.stack : err}`);
      process.exit(2);
    },
  );
}
