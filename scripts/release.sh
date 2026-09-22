#!/usr/bin/env bash
set -euo pipefail

# AIDEV-NOTE: the whole of a release, in the order the things that cannot be undone come last. What
# actually publishes is `publish.yml`, which fires on the pushed tag - so this bumps, commits, tags
# and pushes, and the registry is reached by the runner rather than from here. Publishing from a
# machine is what `scripts/publish.sh` does and it is the exception, not this: a laptop has no OIDC
# token, so a package published from one carries no provenance.
#
# Every refusal below is before the commit. Once the tag is pushed the version is spent, and npm will
# not let a number be reused - so the checks are worth the seconds they cost.

usage() {
  echo "usage: ./scripts/release.sh <version> [--yes]" >&2
  echo "   eg: ./scripts/release.sh 1.1.0" >&2
  exit 2
}

version=${1:-}
[ -n "$version" ] || usage
version=${version#v}
shift

assume_yes=
for argument in "$@"; do
  case "$argument" in
    --yes) assume_yes=yes ;;
    *) usage ;;
  esac
done

# The shape npm will accept, checked here so a typo is caught before anything is written.
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "\"$version\" is not a version - it looks like 1.1.0, or 1.1.0-rc.1" >&2
  exit 1
fi

tag="v$version"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "releases go from main, and this is $branch" >&2
  exit 1
fi

# AIDEV-NOTE: a dirty tree is refused rather than stashed, and the reason matters below - every
# revert in here is `git checkout --` over the manifests, which is only safe because nothing
# uncommitted was in them when this started.
if [ -n "$(git status --porcelain)" ]; then
  echo "the tree has uncommitted changes - commit or stash them, so the release commit is only the bump" >&2
  git status --short >&2
  exit 1
fi

git fetch --quiet origin

if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "main and origin/main are not the same commit - push or pull first, so the tag lands on what everybody has" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists here - delete it with 'git tag -d $tag' if it is a leftover" >&2
  exit 1
fi

if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  echo "$tag is already on origin - that release has been made" >&2
  exit 1
fi

# AIDEV-NOTE: the one check about the outside world, and the only one whose failure is permanent. A
# tag can be deleted and a commit can be amended; a version that has reached npm is spent for good,
# so it is asked about by name before anything local is touched.
for package in $(yarn workspaces list --no-private --json | node -pe 'require("fs").readFileSync(0,"utf8").trim().split("\n").map((l)=>JSON.parse(l).name).join(" ")'); do
  if curl -sf "https://registry.npmjs.org/${package/\//%2F}/$version" >/dev/null 2>&1; then
    echo "$package $version is already on npm - that number is spent, pick the next one" >&2
    exit 1
  fi
done

node scripts/set-version.mjs "$version"

# What was just written, checked by the same gate the workflow runs - so a disagreement is found here
# rather than by a runner three minutes after the tag went up.
if ! node scripts/tag-matches-manifests.mjs "$tag"; then
  git checkout -- .
  echo "the bump did not take, and nothing has been changed" >&2
  exit 1
fi

echo
git --no-pager diff --stat
echo

if [ "$assume_yes" != "yes" ]; then
  # AIDEV-NOTE: read from the terminal and not from stdin, so this still asks when the script is
  # reached through a pipe - and so a `yes` meant for something else cannot answer it.
  #
  # AIDEV-NOTE: `|| answer=` is not tidiness. `read` reports EOF by failing, and under `set -e` a
  # bare failure here ENDS the script - past the revert below, leaving six manifests bumped and
  # nothing said about it. Ctrl-D at this prompt is exactly that, and it is the answer `no` besides.
  printf 'release %s, pushing main and the tag? [y/N] ' "$tag"
  answer=
  read -r answer </dev/tty || answer=
  if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    git checkout -- .
    echo "nothing released, and the manifests are back as they were"
    exit 1
  fi
fi

git commit --quiet --all --message "Release $tag"
git tag "$tag"

# The commit first. A tag pushed alone points at something origin has never seen, and the workflow
# checks out a commit that is not on any branch.
git push --quiet origin main
git push --quiet origin "$tag"

echo
echo "released $tag"
echo "  https://github.com/dcorbin-apps/3d-print-shop/actions/workflows/publish.yml"
