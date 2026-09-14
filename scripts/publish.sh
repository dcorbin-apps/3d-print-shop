#!/usr/bin/env bash
set -euo pipefail

# AIDEV-NOTE: packed by YARN and published by NPM, and each half is here for a reason the other
# cannot supply.
#
# Yarn packs, because these are workspaces and their dependencies on each other are written
# `workspace:*`. Yarn rewrites that into the version it resolved - `"@3d-print-shop/client": "1.0.0"`
# - where npm would ship the literal string, which nothing on earth can install. Verified by reading
# a packed tarball's manifest, not assumed.
#
# Npm publishes, because it is what turns this runner's OIDC token into a short-lived publish token.
# Yarn has no trusted publishing: it authenticates from `npmAuthToken` and nothing else, and a token
# sitting in a repository secret is the thing OIDC exists to do without. Yarn's OIDC is sigstore's,
# for signing provenance, which is a different job.
#
# Order is not arranged, because npm does not check that a dependency exists before accepting a
# package that names one. What that costs at a first release is seconds in which a package is
# installable and its sibling is not.

dry=${1:-}

# The build is what is published: every package is `files: ["dist"]`, and `dist` is gitignored. Pack
# without building and the tarball holds a manifest and nothing else - a published package that
# installs cleanly and contains no code.
for package in packages/*/package.json; do
  location=$(dirname "$package")
  private=$(node -p "JSON.parse(require('fs').readFileSync('$package','utf8')).private === true")
  built=$(node -p "(JSON.parse(require('fs').readFileSync('$package','utf8')).files ?? []).includes('dist')")

  if [ "$private" = "true" ] || [ "$built" != "true" ]; then continue; fi
  [ -d "$location/dist" ] || { echo "$location has no dist - run 'yarn build' first" >&2; exit 1; }
done

into=$(mktemp -d)
trap 'rm -rf "$into"' EXIT

while read -r name location; do
  tarball="$into/${name//\//-}.tgz"

  ( cd "$location" && yarn pack -o "$tarball" >/dev/null )
  echo "packed $name from $location"

  if [ "$dry" = "--dry-run" ]; then
    npm publish "$tarball" --access public --dry-run
  else
    # AIDEV-NOTE: no `--provenance`. Publishing this way generates it anyway - npm attests every
    # trusted publish from Actions without being asked - and asking for it explicitly is what breaks
    # the ONE publish that cannot happen here: the first. A package has to exist before npm will let
    # a trusted publisher be attached to it, so version one goes up by hand, from a machine, where
    # there is no OIDC token to sign anything with and the flag is an error rather than a wish.
    npm publish "$tarball" --access public
  fi
done < <(yarn workspaces list --no-private --json | node -e '
  let said = "";
  process.stdin.on("data", (piece) => (said += piece)).on("end", () => {
    for (const line of said.trim().split("\n")) {
      const { name, location } = JSON.parse(line);
      console.log(`${name} ${location}`);
    }
  });
')
