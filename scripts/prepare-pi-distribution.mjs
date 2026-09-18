#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "index.ts", "plannotator.json", "plannotator-events.ts",
  "generated/config.ts", "generated/checklist.ts",
  "skills/plannotator/SKILL.md", "plannotator.html", "review-editor.html",
];

export function prepareDistribution(root, output, sourceRepository, sourceCommit) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(sourceRepository) || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("Supply a GitHub owner/repository and a full source commit SHA.");
  }
  if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
  const extension = join(root, "apps/pi-extension");
  for (const file of requiredFiles) {
    if (!existsSync(join(extension, file)) || !statSync(join(extension, file)).isFile() || statSync(join(extension, file)).size === 0) {
      throw new Error(`Missing built Pi extension file: ${file}. Run bun run build:pi first.`);
    }
  }

  const temp = mkdtempSync(join(tmpdir(), "pi-distribution-pack-"));
  try {
    // Use the same file selection as the npm release, without running its build hooks.
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], {
      cwd: extension, encoding: "utf8",
    }));
    mkdirSync(output);
    execFileSync("tar", ["-xzf", join(temp, packed.filename), "--strip-components=1", "-C", output]);
    for (const file of requiredFiles) {
      if (!existsSync(join(output, file))) throw new Error(`Package manifest excluded required file: ${file}`);
    }
    const manifestPath = join(output, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.scripts;
    delete manifest.devDependencies;
    delete manifest.workspaces;
    manifest.private = true;
    manifest.repository = { type: "git", url: `git+https://github.com/${sourceRepository}.git` };
    manifest.piDistribution = { schemaVersion: 1, sourceRepository, sourceCommit };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const license of ["LICENSE-MIT", "LICENSE-APACHE"]) copyFileSync(join(root, license), join(output, license));
    writeFileSync(join(output, ".gitignore"), "node_modules/\n");
    const readme = readFileSync(join(output, "README.md"), "utf8");
    writeFileSync(join(output, "README.md"), [
      "# Plannotator Pi distribution",
      "",
      "This branch is generated. Make changes on the source branch, not here.",
      `Source: https://github.com/${sourceRepository}/commit/${sourceCommit}`,
      "",
      "```bash",
      `pi install git:github.com/${sourceRepository}@plannotator-pi`,
      "```",
      "",
      "The package includes generated modules and browser HTML. No Bun build or npm publication is needed to install it.",
      "",
      "---",
      "",
      readme,
    ].join("\n"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/prepare-pi-distribution.mjs <new-output-directory>");
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    prepareDistribution(repositoryRoot, resolve(process.argv[2]), process.env.GITHUB_REPOSITORY ?? "ian-ross/plannotator", sourceCommit);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
