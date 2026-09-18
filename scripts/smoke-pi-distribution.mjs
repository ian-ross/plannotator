#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.argv.length !== 3) throw new Error("Usage: node scripts/smoke-pi-distribution.mjs <package-directory>");
const temp = mkdtempSync(join(tmpdir(), "pi-distribution-smoke-"));
try {
  const packageDir = join(temp, "package");
  cpSync(resolve(process.argv[2]), packageDir, { recursive: true });
  execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: packageDir, stdio: "inherit", timeout: 180_000 });
  const cwd = join(temp, "project");
  const home = join(temp, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  const resultPath = join(temp, "result.json");
  const observerPath = join(temp, "observer.ts");
  writeFileSync(observerPath, `
import { writeFileSync } from "node:fs";
export default function (pi) {
  let turns = 0;
  pi.on("before_agent_start", () => { turns++; });
  pi.on("session_shutdown", (_event, ctx) => {
    const state = ctx.sessionManager.getEntries().findLast(
      entry => entry.type === "custom" && entry.customType === "plannotator"
    )?.data;
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ state, turns }));
  });
}
`);
  execFileSync(process.execPath, [
    join(packageDir, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session",
    "-e", packageDir, "-e", observerPath, "-p", "/plannotator-plan-mode plans/package-smoke.md",
  ], {
    cwd,
    // Do not load real Pi settings or pass provider credentials to the smoke test.
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1", PLANNOTATOR_DATA_DIR: join(home, ".plannotator") },
    stdio: "inherit",
    timeout: 60_000,
  });
  const { state, turns } = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(state?.phase, "planning");
  assert.equal(state?.selectedPlanPath, "plans/package-smoke.md");
  assert.equal(turns, 0, "Selecting a plan must not start an agent turn");
  assert.equal(existsSync(join(cwd, "plans/package-smoke.md")), false);
  console.log("Packaged Pi extension entered planning with the selected filename and no agent turn.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
