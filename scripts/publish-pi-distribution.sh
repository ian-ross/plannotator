#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
  echo "Usage: bash scripts/publish-pi-distribution.sh <package-directory> <git-remote>" >&2
  exit 1
fi
package=$(cd "$1" && pwd)
remote=$2
branch=plannotator-pi
[[ ! -e "$package/.git" ]] || { echo "Package must not contain .git" >&2; exit 1; }

source_commit=$(node - "$package/package.json" <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (manifest.piDistribution?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.piDistribution.sourceCommit)
    || manifest.private !== true || manifest.scripts || manifest.devDependencies) {
  throw new Error("Not a prepared Pi distribution package");
}
console.log(manifest.piDistribution.sourceCommit);
NODE
)

# An older queued build must not replace a distribution built from newer main.
main_commit=$(git ls-remote --exit-code "$remote" refs/heads/main | cut -f1)
if [[ "$source_commit" != "$main_commit" ]]; then
  echo "Skipping stale build: source $source_commit is not current main $main_commit"
  exit 0
fi

checkout=$(mktemp -d)
trap 'rm -rf "$checkout"' EXIT
git init --quiet --initial-branch="$branch" "$checkout"
cd "$checkout"
git remote add origin "$remote"
if git ls-remote --exit-code origin "refs/heads/$branch" > /dev/null; then
  git fetch --quiet --no-tags --depth=1 origin "refs/heads/$branch"
  git checkout --quiet -B "$branch" FETCH_HEAD
  node - <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.piDistribution?.schemaVersion !== 1) {
  throw new Error("Refusing to replace an unmanaged plannotator-pi branch");
}
NODE
  git rm --quiet -r --ignore-unmatch .
else
  status=$?
  # ls-remote returns 2 for an absent branch. Network/auth failures must stop publication.
  [[ "$status" == 2 ]] || exit "$status"
fi
cp -a "$package/." .
git add --all
if git diff --cached --quiet; then
  echo "Distribution is already current"
  exit 0
fi
git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit --quiet -m "Build Pi distribution from $source_commit"
# Keep history and reject concurrent updates rather than force-pushing over them.
git push origin "HEAD:refs/heads/$branch"
