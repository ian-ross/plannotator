# Pi distribution branch

The `ian-ross/plannotator` fork publishes a ready-to-install Pi package on `plannotator-pi`. Source changes stay on `main`. The distribution branch contains the extension at its root, with its generated modules, skills, browser HTML, licenses, and npm lockfile. It does not publish anything to npm.

## Enable publication

1. Enable GitHub Actions in the fork's Actions tab if fork workflows are disabled.
2. Merge the distribution workflow into `main` and push it to `origin`.
3. Wait for **Publish Pi distribution branch** to succeed. Its first run creates `plannotator-pi`.

The workflow runs on every push to `main`. You can also run it manually from the Actions tab, with `main` selected. Other repositories and branches skip the build. Pull requests never publish.

The workflow uses GitHub's automatic `GITHUB_TOKEN`, with `contents: write` only in the publishing job. No npm token or personal access token is needed. Repository or organization policies must allow that permission and allow the bot to push to `plannotator-pi`.

## Install and update

Remove any existing npm or local-source Plannotator installation first so Pi does not load two copies. For an npm installation:

```bash
pi remove npm:@plannotator/pi-extension
```

Then install the fork:

```bash
pi install git:github.com/ian-ross/plannotator@plannotator-pi
```

Add `-l` for project-local settings. Match that scope when removing a previous installation. Restart Pi after changing packages.

To fetch the latest distribution again:

```bash
pi install git:github.com/ian-ross/plannotator@plannotator-pi
```

For a fixed version, replace `plannotator-pi` with a commit SHA from the distribution branch, not a source commit from `main`. The generated README and `package.json` record the source commit for each build.

## What the workflow checks

The build job installs locked Bun dependencies, tests the packaging and Git publication scripts, and runs `bun run build:pi`. It uses `npm pack --ignore-scripts` to select the extension's published files, then removes build scripts and development dependencies. The generated manifest keeps runtime and peer dependencies and sets `private: true` to prevent accidental npm publication.

The job generates an npm lockfile and runs `npm ci --omit=dev` in a temporary consumer outside the monorepo. A Pi smoke test loads that package and checks that selecting a plan filename enters planning without an agent turn or an empty plan file.

The publishing job downloads the tested package. It does not install dependencies or run package code. It creates an independent branch on first publication and adds ordinary commits after that, without force-pushing. It refuses to replace an existing branch without the distribution marker. A queued build whose source commit is no longer the tip of `main` skips publication.

Do not edit `plannotator-pi` by hand. The next build replaces its files. Publication does not change `main` or invoke the npm release workflow.

## Test locally

Requires Bun 1.3.14, Node.js 24, npm, Git, and tar:

```bash
bun install --frozen-lockfile
bun test scripts/pi-distribution.test.ts
bun run build:pi
build_root=$(mktemp -d)
node scripts/prepare-pi-distribution.mjs "$build_root/package"
npm install --prefix "$build_root/package" --package-lock-only --omit=dev --ignore-scripts --no-audit --no-fund
node scripts/smoke-pi-distribution.mjs "$build_root/package"
```

These checks do not push to GitHub or alter your Pi settings. The unit tests publish only to temporary local Git repositories. The smoke test uses a temporary home without provider credentials.
