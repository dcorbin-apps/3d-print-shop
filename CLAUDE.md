A service that takes print jobs and gets them onto a printer. See README.md for what it is and
design/3d-print-shop.md for why it is shaped this way, design/testing.md for how it is tested, and
design/security.md for what stops a request that is not really somebody's.
PLAN.md is what is still to do.

* All packages use ES Modules, not CommonJS

# The one invariant

The shop knows nothing about its clients. Nothing here may depend on any client - not in code, not
in tests, not in a design document, and not in a comment reasoning from what one of them does. A
client hands the shop gcode and says what it needs; that is the whole of the relationship, and it
runs one way. Naming one is how the dependency starts, so nothing here names one.

# Where things live

* The wire contract - the types, the `Shop` interface, `HttpShop` - is `@3d-print-shop/client`, and
  the server depends on it. There is one contract, written once. A second copy drifts.
* The printing loop is deliberately absent from the API. `startPrinting`, `couldNotStart`,
  `finishedPrinting` and the gcode are the loop's own bookkeeping, and publishing them would invite
  a second writer into a store built for one.
* A job record is written once and never rewritten. Everything that moves belongs to a printer.

# Behavior

* Do not put comments at the top of a source file. Instead, name the file well.
