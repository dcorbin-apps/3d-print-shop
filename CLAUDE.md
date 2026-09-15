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
* A job record is written at submission and only ever changed by a person renaming the job. Nothing
  in it is derived from, scheduled on, or copied anywhere, so there is no second version of any of it
  to disagree with. Everything that MOVES belongs to a printer.
* A job's state is derived by finding the printer whose `holding` names it, and is stored nowhere. A
  person pausing a job is kept in `statusOverride.json` beside the record - that file holds the
  intervention and never the state.

# Behavior

* Do not put comments at the top of a source file. Instead, name the file well.
* A FLAKY TEST IS NEVER TOLERATED. Not noted, not worked around, not re-run until it passes - a
  suite that sometimes fails teaches everybody to stop reading it, and the next real failure is
  read as the usual noise. Find it and fix it. If it genuinely cannot be fixed now, it is written
  into PLAN.md as work and said out loud to whoever is being handed it - never left as a comment
  explaining how often it happens.
* `yarn test` passing once says little about a race. A suspected flake is run repeatedly - ten
  full runs or more - and the repeat is what says it is fixed.
