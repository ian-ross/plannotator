import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareDistribution } from "./prepare-pi-distribution.mjs";

const publishScript = resolve(import.meta.dir, "publish-pi-distribution.sh");
const roots: string[] = [];
const repository = "ian-ross/plannotator";
const sha = "a".repeat(40);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-distribution-test-"));
  roots.push(root);
  const source = join(root, "source");
  const extension = join(source, "apps/pi-extension");
  const output = join(root, "distribution");
  const manifest = {
    name: "@plannotator/pi-extension", version: "0.0.0", type: "module",
    pi: { extensions: ["./"], skills: ["skills/plannotator/SKILL.md"] },
    files: ["index.ts", "plannotator-events.ts", "plannotator.json", "generated/", "skills/", "*.html", "README.md"],
    scripts: { prepack: "exit 55", prepare: "exit 55", prepublishOnly: "exit 55", build: "exit 55" },
    dependencies: { diff: "^8.0.4" },
    peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.79.1" },
    devDependencies: { glimpseui: "^0.8.0" },
  };
  write(join(extension, "package.json"), JSON.stringify(manifest));
  for (const file of ["index.ts", "plannotator-events.ts", "plannotator.json", "generated/config.ts", "generated/checklist.ts", "skills/plannotator/SKILL.md", "README.md", "plannotator.html", "review-editor.html"]) {
    write(join(extension, file), `fixture ${file}\n`);
  }
  write(join(extension, "not-shipped.test.ts"), "not shipped");
  write(join(source, "LICENSE-MIT"), "MIT fixture");
  write(join(source, "LICENSE-APACHE"), "Apache fixture");
  return { root, source, extension, output, manifest };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(source: string) {
  git(source, "add", ".");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  return git(source, "rev-parse", "HEAD");
}

function remoteFixture() {
  const f = fixture();
  git(f.source, "init", "--initial-branch=main");
  const sourceCommit = commit(f.source);
  const remote = join(f.root, "remote.git");
  git(f.root, "clone", "--bare", f.source, remote);
  prepareDistribution(f.source, f.output, repository, sourceCommit);
  return { ...f, remote, sourceCommit };
}

function publish(output: string, remote: string) {
  return spawnSync("bash", [publishScript, output, remote], { encoding: "utf8", timeout: 10_000 });
}

function expectPublished(result: ReturnType<typeof publish>) {
  expect(result.stderr + result.stdout).not.toContain("fatal:");
  expect(result.status).toBe(0);
}

test("packs runtime files at the root without invoking hooks or retaining build dependencies", () => {
  const f = fixture();
  prepareDistribution(f.source, f.output, repository, sha);
  const manifest = JSON.parse(readFileSync(join(f.output, "package.json"), "utf8"));
  expect(manifest.private).toBe(true);
  expect(manifest.scripts).toBeUndefined();
  expect(manifest.devDependencies).toBeUndefined();
  expect(manifest.pi).toEqual(f.manifest.pi);
  expect(manifest.dependencies).toEqual(f.manifest.dependencies);
  expect(manifest.peerDependencies).toEqual(f.manifest.peerDependencies);
  expect(manifest.piDistribution).toEqual({ schemaVersion: 1, sourceRepository: repository, sourceCommit: sha });
  expect(existsSync(join(f.output, "apps"))).toBe(false);
  expect(existsSync(join(f.output, "not-shipped.test.ts"))).toBe(false);
  for (const file of ["index.ts", "generated/config.ts", "skills/plannotator/SKILL.md", "plannotator.html", "review-editor.html", "LICENSE-MIT", "LICENSE-APACHE", ".gitignore"]) {
    expect(existsSync(join(f.output, file))).toBe(true);
  }
  expect(readFileSync(join(f.output, "README.md"), "utf8")).toContain(`https://github.com/${repository}/commit/${sha}`);
});

test("refuses to replace an existing output directory", () => {
  const f = fixture();
  write(join(f.output, "keep"), "keep");
  expect(() => prepareDistribution(f.source, f.output, repository, sha)).toThrow("Output already exists");
  expect(readFileSync(join(f.output, "keep"), "utf8")).toBe("keep");
});

test("rejects missing build output before packing", () => {
  const f = fixture();
  rmSync(join(f.extension, "plannotator.html"));
  expect(() => prepareDistribution(f.source, f.output, repository, sha)).toThrow("Run bun run build:pi first");
  expect(existsSync(f.output)).toBe(false);
});

test("rejects a manifest that excludes required generated files", () => {
  const f = fixture();
  f.manifest.files = f.manifest.files.filter(file => file !== "generated/");
  write(join(f.extension, "package.json"), JSON.stringify(f.manifest));
  expect(() => prepareDistribution(f.source, f.output, repository, sha)).toThrow("Package manifest excluded required file");
});

test("rejects malformed source metadata", () => {
  const f = fixture();
  expect(() => prepareDistribution(f.source, f.output, repository, "main")).toThrow("full source commit SHA");
});

test("creates an independent branch, keeps history, removes stale files, and skips identical or stale builds", () => {
  const f = remoteFixture();
  write(join(f.output, "obsolete.txt"), "old build");
  expectPublished(publish(f.output, f.remote));
  const first = git(f.remote, "rev-parse", "plannotator-pi");
  expect(git(f.remote, "rev-list", "--count", "plannotator-pi")).toBe("1");
  expect(git(f.remote, "show", "plannotator-pi:generated/config.ts")).toBe("fixture generated/config.ts");
  expect(git(f.remote, "rev-parse", "main")).toBe(f.sourceCommit);
  expect(publish(f.output, f.remote).stdout).toContain("already current");
  expect(git(f.remote, "rev-parse", "plannotator-pi")).toBe(first);

  write(join(f.extension, "index.ts"), "new runtime");
  const updatedCommit = commit(f.source);
  git(f.source, "push", f.remote, "main");
  const updated = join(f.root, "updated");
  prepareDistribution(f.source, updated, repository, updatedCommit);
  expectPublished(publish(updated, f.remote));
  const second = git(f.remote, "rev-parse", "plannotator-pi");
  expect(git(f.remote, "rev-parse", "plannotator-pi^")).toBe(first);
  expect(git(f.remote, "ls-tree", "--name-only", "plannotator-pi")).not.toContain("obsolete.txt");
  expect(git(f.remote, "show", "plannotator-pi:index.ts")).toBe("new runtime");
  expect(publish(f.output, f.remote).stdout).toContain("Skipping stale build");
  expect(git(f.remote, "rev-parse", "plannotator-pi")).toBe(second);
});

test("refuses to overwrite an unmanaged distribution branch", () => {
  const f = remoteFixture();
  git(f.remote, "branch", "plannotator-pi", "main");
  expect(publish(f.output, f.remote).status).not.toBe(0);
  expect(git(f.remote, "rev-parse", "plannotator-pi")).toBe(f.sourceCommit);
});

test("does not mistake an inaccessible remote for an absent distribution branch", () => {
  const f = remoteFixture();
  expect(publish(f.output, join(f.root, "missing.git")).status).not.toBe(0);
});

test("rejects an unprepared package before contacting the remote", () => {
  const f = fixture();
  write(join(f.output, "package.json"), JSON.stringify(f.manifest));
  const result = publish(f.output, join(f.root, "missing.git"));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Not a prepared Pi distribution package");
  expect(result.stderr).not.toContain("does not appear to be a git repository");
});
