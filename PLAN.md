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

### Security

Nothing here is authenticated, and `serve` binds every interface where `octoprint-sim` binds
loopback. Whoever can reach the port can submit work, delete a printer, or stop the shop mid-print.

- [ ] Bind loopback by default, with `--listen <address>` to say otherwise. One line, and it removes
  most of the exposure on its own
- [ ] A token on the API — `PRINT_SHOP_TOKEN` beside `PRINT_SHOP_KEY_*`, checked in one middleware.
  Cheap because every caller goes through `HttpShop`: one place to send it, one to check it. Two
  audiences eventually — a client submits and reads; only an operator touches printers or shuts down
- [ ] `POST /shutdown` first, if only one route gets a token. It needs no state and stops a shop that
  is watching prints
- [ ] Limits on the upload. `busboy` is given none, so a submission writes into the spool until the
  disk is full — and the spool is the whole recovery model. A file count, a size, and a check that
  there is room before accepting
- [ ] Validate `remotePath`, or drop it. It is a client's string handed straight to OctoPrint, so a
  `../` or an absolute path is a path on the PRINTER, and two jobs can be made to collide on one
  name. Always naming it `job-<id>.gcode` is the boring answer
- [ ] Decide what `printer add` may be pointed at. The shop uploads megabytes to that address with
  the printer's API key attached, so whoever can add a printer can point the shop anywhere
- [ ] A 500 answers with the raw error message, which for a filesystem failure carries the spool
  path. Generic message out, real one to the log
- [ ] Modes on what the spool holds. Nothing sets one, so gcode and printer records land at whatever
  the umask gives
- [ ] One name guard shared by the four `/printers/:name` routes. Only `add` checks for a separator;
  the others are safe because a record must be found first, which is true today by accident

### Logging

Three `console` calls in the whole service. It runs unattended for hours and leaves no trace of what
it did — the only durable evidence of a fault is the sentence in `printer.paused.reason`.

- [ ] A `Log` port the CLI supplies, injected the way `Machines` is, rather than `console` scattered
  through the store and the foreman. Tests stay silent and the sink stays the operator's choice
- [ ] One line per event to stdout, structured. `launchd` and `systemd` capture stdout, so this
  lands with the packaging above; a file the shop has to rotate is the thing to avoid
- [ ] Worth a line each: submitted, started on X, sent N bytes, the printer's outcome, the verdict,
  stopped, resumed, loaded, every reason the foreman pauses for, and on restart what was picked up
  and what was started — that last is invisible today
- [ ] The API edge: method, path, status, ms. The `response.on('finish')` hook that already tells the
  foreman about a change is the seam
- [ ] This is where history is allowed to live. The store keeps none by design, and a log is not a
  second writer — so it is the cheapest form of the run count above, and the only way to answer
  "what happened to job 7" once the job is gone
- [ ] Two levels, not five: what an operator needs, and why something failed
- [ ] Never log a printer's key. An OctoPrint failure carrying request headers would put
  `PRINT_SHOP_KEY_MK4` in the journal, so the redaction rule comes with the first line of logging

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
