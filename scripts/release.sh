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
  echo "usage: ./scripts/release.sh <version> [--yes] [--wait]" >&2
  echo "   eg: ./scripts/release.sh 1.1.0 --wait" >&2
  echo >&2
  echo "  --yes   do not ask before pushing" >&2
  echo "  --wait  follow the publish run, then wait until every package resolves at the version" >&2
  exit 2
}

# AIDEV-NOTE: the slug is ASKED FOR rather than written down, because it is already written down
# in the remote - and a second copy is a second thing to be wrong when this repository moves or
# somebody works from a fork.
repoSlug() {
  git remote get-url origin | sed -E 's#^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)##; s#\.git$##'
}

# AIDEV-NOTE: a token is USED IF THERE IS ONE and never required. This repository is public, so the
# unauthenticated limit of 60 an hour is enough for one release - but it is shared with everything
# else on the machine, and a release that cannot see its own run because something else spent the
# budget is worth one environment variable to avoid.
apiGet() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -sf -H "Authorization: Bearer $GITHUB_TOKEN" "$1"
  else
    curl -sf "$1"
  fi
}

# `id status conclusion url` for the newest publish run of this tag, or nothing if it is not there
# yet. A tag push takes a moment to become a run, so absent is a state to wait through rather than
# to fail on.
publishRunFor() {
  # shellcheck disable=SC2016  # the ${} in the node script below are JavaScript, not shell
  apiGet "https://api.github.com/repos/$(repoSlug)/actions/workflows/publish.yml/runs?per_page=20" 2>/dev/null |
    node -e '
      let said = "";
      process.stdin.on("data", (piece) => (said += piece)).on("end", () => {
        let listed;
        try { listed = JSON.parse(said); } catch { return; }
        const wanted = process.argv[1];
        const runs = (listed.workflow_runs ?? []).filter((run) => run.head_branch === wanted);
        const newest = runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
        if (newest !== undefined) console.log(`${newest.id} ${newest.status} ${newest.conclusion ?? "-"} ${newest.html_url}`);
      });
    ' "$1" 2>/dev/null || true
}

# How long to wait before giving up and saying so. The publish job's own timeout is 20 minutes, so
# anything past that is a runner that never started rather than a job still going.
PUBLISH_DEADLINE=1500
REGISTRY_DEADLINE=900
POLL=15

followThePublish() {
  local tag=$1 said id status conclusion url='' started=$SECONDS

  say "waiting for the publish run of $tag"
  while true; do
    said=$(publishRunFor "$tag")

    if [ -n "$said" ]; then
      # shellcheck disable=SC2086
      set -- $said
      id=$1 status=$2 conclusion=$3 url=$4

      if [ "$status" = completed ]; then
        if [ "$conclusion" = success ]; then
          say "  the publish run succeeded  ($url)"
          return 0
        fi

        # AIDEV-NOTE: the URL and not the reason. What failed is in the run's own log and this has no
        # business guessing at it - what it owes somebody is the fastest way to the page that says.
        say "  THE PUBLISH RUN $conclusion  ($url)"
        # AIDEV-NOTE: it does NOT say the registry is untouched, because publish.sh publishes one
        # package at a time and a run can die between two of them. Which of the two happened decides
        # whether this version can be tried again or is spent, and only the registry knows - so
        # somebody is pointed at both rather than told the comfortable one.
        say "  $tag is pushed. Some packages may already be up - publish.sh sends them one at a time - so check"
        say "  before reusing ${tag#v}, because a version that reached npm cannot go up again:"
        say "    npm view <package> versions"
        return 1
      fi

      say "  run $id is $status"
    fi

    if [ $((SECONDS - started)) -gt "$PUBLISH_DEADLINE" ]; then
      say "  gave up after ${PUBLISH_DEADLINE}s. ${url:-https://github.com/$(repoSlug)/actions/workflows/publish.yml}"
      return 1
    fi

    sleep "$POLL"
  done
}

# AIDEV-NOTE: the PACKUMENT, which is what an install resolves from, and not the version endpoint.
# The two disagree for a while after a publish - the version endpoint answered 200 for a package npm
# itself still said did not have that version - and the one worth waiting on is the one that decides
# whether somebody's install works.
resolvesAt() {
  npm view "$1" versions --json 2>/dev/null | tr -d ' \n' | grep -q "\"$2\""
}

waitForTheRegistry() {
  local version=$1 package left='' started=$SECONDS

  local packages
  packages=$(yarn workspaces list --no-private --json |
    node -pe 'require("fs").readFileSync(0,"utf8").trim().split("\n").map((line) => JSON.parse(line).name).join(" ")')

  say "waiting for $version to resolve on npm"
  while true; do
    left=''
    for package in $packages; do
      if resolvesAt "$package" "$version"; then continue; fi
      left="$left $package"
    done

    if [ -z "$left" ]; then
      say "  every package resolves at $version - an install will get them"
      return 0
    fi

    if [ $((SECONDS - started)) -gt "$REGISTRY_DEADLINE" ]; then
      say "  gave up after ${REGISTRY_DEADLINE}s. Still not resolving:$left"
      say "  the publish succeeded, so this is the registry catching up rather than a release to redo."
      return 1
    fi

    say "  still waiting on:$left"
    sleep "$POLL"
  done
}

say() { printf '%s\n' "$*"; }

# AIDEV-NOTE: wrapped and guarded for the reason install.sh is - sourcing this file defines its
# decisions and performs none of them, which is the only way `followThePublish` and
# `waitForTheRegistry` can be exercised against a run and a registry without cutting a release to
# do it. Executed, `$0` is this file and nothing about a release has changed.
main() {
  version=${1:-}
  [ -n "$version" ] || usage
  version=${version#v}
  shift

  assume_yes=
  wait_for_it=
  for argument in "$@"; do
    case "$argument" in
      --yes) assume_yes=yes ;;
      --wait) wait_for_it=yes ;;
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
  echo "  https://github.com/$(repoSlug)/actions/workflows/publish.yml"

  if [ "$wait_for_it" = yes ]; then
    echo
    followThePublish "$tag" || exit 1
    echo
    waitForTheRegistry "$version" || exit 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
