A service that takes print jobs and gets them onto a printer. See README.md for what it is and
design/3d-print-shop.md for why it is shaped this way. PLAN.md is what is still to do.

* All packages use ES Modules, not CommonJS

# The one invariant

The shop knows nothing about its clients. Nothing here may depend on gamebox, or on any other
client, in code, in tests, or in a design document. A client hands the shop gcode and says what it
needs; that is the whole of the relationship, and it runs one way.

# Where things live

* The wire contract - the types, the `Shop` interface, `HttpShop` - is `@3d-print-shop/client`, and
  the server depends on it. There is one contract, written once. A second copy drifts.
* The printing loop is deliberately absent from the API. `startPrinting`, `couldNotStart`,
  `finishedPrinting` and the gcode are the loop's own bookkeeping, and publishing them would invite
  a second writer into a store built for one.
* A job record is written once and never rewritten. Everything that moves belongs to a printer.

# Behavior

* Do not put comments at the top of a source file. Instead, name the file well.
