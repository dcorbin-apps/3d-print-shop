#!/bin/bash
# AIDEV-NOTE: `yarn ut` and `yarn test` are the same thing while there are no acceptance tests, and
# both are said as an exclusion rather than as a list of directories to include. A list of paths can
# silently stop matching - a directory is renamed, and the suite reports green having run nothing.
# An exclusion cannot.
#
# There is no `yarn at`, because there is nothing for it to run: see the Tests section of PLAN.md.
# A script pointed at a directory that does not exist is the silently-green failure above, so it goes
# rather than sitting there passing. If an acceptance test is ever justified again it comes back with
# it - and what would justify one is written down there.
#
# AIDEV-NOTE: `yarn assumptions` is what third-party code actually does, and is deliberately NOT in
# `yarn test`. It cannot change because somebody edited this repository, so it runs when a dependency
# or the node version goes up - see the Tests section of PLAN.md.
exec yarn jest "$@"
