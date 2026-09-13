#!/bin/bash
# AIDEV-NOTE: `yarn ut` is every jest project MINUS the acceptance and assumption suites, and
# `yarn test` is everything minus the assumptions - both said as an exclusion rather than as a list
# of directories to include. A list of paths can silently stop matching - a directory is renamed, and
# the suite reports green having run nothing. An exclusion cannot.
#
# AIDEV-NOTE: `yarn assumptions` is what third-party code actually does, and is deliberately NOT in
# `yarn test`. It cannot change because somebody edited this repository, so it runs when a dependency
# or the node version goes up - see the Tests section of PLAN.md.
#
# AIDEV-NOTE: `yarn assumptions` is what third-party code actually does, and is deliberately NOT in
# `yarn test`. It cannot change because somebody edited this repository, so it runs when a dependency
# or the node version goes up - see the Tests section of PLAN.md.
exec yarn jest "$@"
