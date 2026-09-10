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

- [ ] `callers.json` is shaped for machine callers and nothing else, which is what a web UI exposes.
  The token is the map's KEY, so the credential is the identity: a caller holds exactly one token,
  and a person who wants a second for another machine or a browser has to become a second person.
  A caller now has a stable id, which is what ownership needed and what a job records. Three faults
  left, none of which blocks a web UI:
  - a credential wants to be a LIST on an identity, so one can be added or revoked without changing
    who the person is
  - the file mixes what an OPERATOR writes with what the SHOP would write. Sessions are what a
    login produces, they are the shop's, they expire, and they cannot live in a file a person
    hand-edits and the shop re-reads on SIGHUP
  - tokens are stored in the clear. Tolerable for 32 random bytes in a 0600 file, wrong the moment
    a human chooses one - and hashing breaks lookup-by-token, which is the first fault again

- [ ] Confirm the `remotePath` rule against a real OctoPrint - the printer here is offline, so the
  rule in `validateDetails` was written from the API docs and pathvalidate's, not from a machine.
  The one known gap: the docs show `20mm-ümläut-böx.gcode` stored as `20mm-umlaut-box.gcode`
  without saying what transliterates it, so a non-ASCII name may be accepted here and renamed there

### The page in a browser

- [ ] The shop serves the built UI itself, so there is one origin and one thing to install. Today
  `yarn ui` is a Vite dev server proxying the shop's routes; a built `@3d-print-shop/ui` has nowhere
  to be served from, and anything else serving it would need the API to grow CORS - which is a way
  in that nothing has asked for. What is undecided is whether the server depends on the ui package
  to find its files, or is pointed at a directory
- [ ] The UI can only READ. Every route it needs is a GET, and the verdict a person gives - the one
  thing that frees a bed - is still `job approve` at a terminal. That is the first thing to add once
  the page is in front of somebody

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
