# 3D Print Shop Development Plan

What is still to do. Finished work is not recorded here - the reasoning behind each decision lives
in `AIDEV-NOTE`s beside the code it explains, and the rest is in git.

See [design/3d-print-shop.md](design/3d-print-shop.md) for the design this is working towards, and
[design/octoprint-sim.md](design/octoprint-sim.md) for the stand-in printer the tests run against.

## Remaining Work

### The service

- [ ] Resume a stopped printer from its own status rather than only on an operator's word
- [ ] Positional filaments, when there is a printer with more than one extruder. Scheduling uses
  only a job's FIRST filament today, which is right for one extruder and wrong for several: the
  index is the extruder the slicer assigned, so `[red, blue]` and `[blue, red]` are different
  requirements. `startsWith()` in `packages/server/src/selection.ts` is the one place to revisit
- [ ] A third verdict, "abandon" — do not reprint, but it was not a success. The API is already
  shaped for it: a verdict is a resource, so this is another value rather than another route
- [ ] Nothing says how many times a job has run. The count was the one thing about a job that
  changed and nothing scheduled on it, so it went when job records became immutable. Saying "this is
  the third attempt" needs a history of finished prints, which the shop does not keep
- [ ] Optional duration on a job, so `waitingOn` can rank demand by how much WORK is waiting rather
  than by how many jobs are. It has to be a field of its own — putting it in `metadata` would make
  the shop interpret a bag it promises never to read
- [ ] Guard: refuse a job whose printer does not match the machine it would print on. A client can
  say what the SLICER called the machine (`MK4IS`) in `metadata`, and whether OctoPrint names it the
  same way is unknown — that answer is needed before this can be anything but a guess

### What an operator can see

- [ ] `waitingOn()` is written, exported and tested, and nothing calls it. "What should I load next"
  never reaches an operator: `3d-print-shop job list` shows what is held, not what each filament is
  holding up

### Installation

- [ ] The spool root is created by the installer and owned by the service's user, the way
  `/var/spool/cups` is. The store refuses a missing one rather than creating it, so the packaging is
  what has to exist: a `launchd` plist, a `systemd` unit, and whatever makes the directory
- [ ] Publish `@3d-print-shop/*` to a registry. Until then a client depends on a checkout of this
  repository sitting beside it — gamebox_v3 reaches it as `portal:../3d-print-shop/packages/client`,
  which cannot survive a fresh clone that has no shop next door

### Beyond one printer

- [ ] Multi-printer routing — the store and the foreman already carry several, and `printableNow`
  answers per printer; what is untested is a shop actually running two at once
- [ ] Report a printer's own state — bed, temperature, filament — rather than only what an operator
  said was loaded. Do NOT design around SpoolManager: it existed once on this machine's printer and
  is gone, so assume the machine cannot answer and the operator does
