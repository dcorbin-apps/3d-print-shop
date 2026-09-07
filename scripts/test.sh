#!/bin/bash
# AIDEV-NOTE: `yarn ut` is every jest project MINUS the acceptance suites, said as an exclusion
# rather than as a list of directories to include. A list of paths can silently stop matching -
# a directory is renamed, and the suite reports green having run nothing. An exclusion cannot.
exec yarn jest "$@"
