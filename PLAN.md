# 3D Print Shop Development Plan

What is still to do. Finished work is not recorded here - the reasoning behind each decision lives
in `AIDEV-NOTE`s beside the code it explains, and the rest is in git.

See [design/3d-print-shop.md](design/3d-print-shop.md) for the design this is working towards, and
[design/octoprint-sim.md](design/octoprint-sim.md) for the stand-in printer the tests run against.

## Remaining Work

### The service

- [ ] The shop can say when IT is in trouble, rather than only what each printer is doing. A store
  or spool fault is nobody's printer's fault and now stops nothing, so a log line is all there is -
  and nothing a client or an operator asks answers "the shop is not well". The contract has no
  shop-level status at all: `printers()` is the closest thing, and a fault that touches every
  printer at once has nowhere to be seen
- [ ] Positional filaments, when there is a printer with more than one extruder. Scheduling uses
  only a job's FIRST filament today, which is right for one extruder and wrong for several: the
  index is the extruder the slicer assigned, so `[red, blue]` and `[blue, red]` are different
  requirements. `startsWith()` in `packages/server/src/selection.ts` is the one place to revisit

### Security

- [ ] Sessions do not survive a restart, so restarting the shop logs everybody out. In memory is
  the honest first answer - they are the shop's rather than the file's, and a file of them is a
  second thing to get the mode of right - but a shop restarted by an update at 2am is a wall display
  asking to be logged in to in the morning
- [ ] Nobody can change their own password. `caller password` is an operator at a terminal, which is
  right for setting one and wrong for the person who wants to change theirs

- [ ] Confirm the `remotePath` rule against a real OctoPrint - the printer here is offline, so the
  rule in `validateDetails` was written from the API docs and pathvalidate's, not from a machine.
  The one known gap: the docs show `20mm-ümläut-böx.gcode` stored as `20mm-umlaut-box.gcode`
  without saying what transliterates it, so a non-ASCII name may be accepted here and renamed there

### The page in a browser

- [ ] The camera is fetched by the BROWSER, from the printer, so whether it appears is a question
  about that browser rather than about the shop. Firefox's HTTPS-Only Mode upgrades the request and
  the printer serves no TLS, so it fails - and an exception has to be added per browser, per machine,
  against the page's own origin. A route on the shop that piped the stream would end the whole class:
  the browser would only ever fetch from the origin it loaded the page from. What it costs is the
  shop holding an open connection per viewer per printer, and knowing that a camera exists

- [ ] The verdict a person gives - the one thing that frees a bed - is still `job approve` at a
  terminal. Adding a printer is the only thing the page can change today, and judging a print is the
  one worth having next: a bed is held until somebody says, and a page somebody is already watching
  the print on is where they would say it

### Installation

- [ ] Publish `@3d-print-shop/*` to a registry. Until then a client depends on a checkout of this
  repository sitting beside it — the client it was written for reaches it as
  `portal:../3d-print-shop/packages/client`, which cannot survive a fresh clone that has no shop
  next door

### Beyond one printer

- [ ] Multi-printer routing — the store and the foreman already carry several, and `printableNow`
  answers per printer; what is untested is a shop actually running two at once
- [ ] Report a printer's own state — bed, temperature, filament — rather than only what an operator
  said was loaded. Do NOT design around SpoolManager: it existed once on this machine's printer and
  is gone, so assume the machine cannot answer and the operator does
