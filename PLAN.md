# 3D Print Shop Development Plan

What is still to do. Finished work is not recorded here - the reasoning behind each decision lives
in `AIDEV-NOTE`s beside the code it explains, and the rest is in git.

See [design/3d-print-shop.md](design/3d-print-shop.md) for the design this is working towards, and
[design/octoprint-sim.md](design/octoprint-sim.md) for the stand-in printer the tests run against.

## Remaining Work

### The service

- [ ] Five orphaned shops from an OLD checkout ignored SIGTERM and needed killing, and why is still
  unknown. It does not reproduce here: a shop with no client, one with a client connected, and one
  whose printer refuses every connection all exit in under 10ms. The pending-backoff timer was the
  first guess and it was wrong - that path is now cancelled, and it could only ever have delayed an
  exit by the 60s cap anyway. Worth another look if a shop is ever seen to hang again, with what was
  holding the event loop open captured at the time
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

- [ ] Ownership, decided and unbuilt. A job carries the STABLE ID of the caller who submitted it,
  written with the record at submission and never rewritten - a role says what a caller MAY DO, and this is what is
  THEIRS. The owner or an admin reads a job's details; the OWNER ALONE renders its verdict; every
  other caller learns only how many jobs the shop holds, as a bare total. Today any token reads
  every job, including another client's `displayName` and `metadata`, which is honest with one
  client and wrong with two. Two things to settle while building it:
  - `jobs()` answers `Job[]` and has no shape for "a total instead of a list"
  - a job whose owner is revoked can never be judged, so it holds its printer for good. An admin
    override is the obvious escape and was deliberately not taken; something has to be

- [ ] `callers.json` is shaped for machine callers and nothing else, which is what a web UI exposes.
  The token is the map's KEY, so the credential is the identity: a caller holds exactly one token,
  and a person who wants a second for another machine or a browser has to become a second person.
  A caller now has a stable id, which is what unblocked the ownership work above. Three faults left,
  none of which blocks it:
  - a credential wants to be a LIST on an identity, so one can be added or revoked without changing
    who the person is
  - the file mixes what an OPERATOR writes with what the SHOP would write. Sessions are what a
    login produces, they are the shop's, they expire, and they cannot live in a file a person
    hand-edits and the shop re-reads on SIGHUP
  - tokens are stored in the clear. Tolerable for 32 random bytes in a 0600 file, wrong the moment
    a human chooses one - and hashing breaks lookup-by-token, which is the first fault again

- [ ] Rotating a token means editing `callers.json` and restarting; there is no way to add or revoke
  one while the shop runs. Re-reading the file on SIGHUP is the boring answer
- [ ] A name is checked and then dropped. `request.caller` is set and read by nobody, waiting for
  the logging below - which is the whole point of a name rather than a shared secret
- [ ] Take the stored path from OctoPrint's answer instead of guessing it. `send()` throws the
  upload response away and everything downstream recomputes `remotePathFor(job)`, which is only
  right for as long as the shop's idea of what the printer stored matches the printer's. The
  response carries the name it actually used, and a print's completion event is matched on that
  string - so reading it back removes the guess. It cannot live on the job, which is written once;
  it belongs on the printer's `holding`, beside everything else that moves
- [ ] Confirm the `remotePath` rule against a real OctoPrint - the printer here is offline, so the
  rule in `validateDetails` was written from the API docs and pathvalidate's, not from a machine.
  The one known gap: the docs show `20mm-ümläut-böx.gcode` stored as `20mm-umlaut-box.gcode`
  without saying what transliterates it, so a non-ASCII name may be accepted here and renamed there
- [ ] `add` doubles as `change`, and a printer's key is keyed by its NAME - so re-pointing an
  existing printer's address sends that printer's key, and a plate's gcode, wherever it was pointed.
  Decided: an admin may point the shop anywhere, because that is close to what admin means, and a
  range check here would be defeated by a hostname resolving at connect time. What is left is
  whether a leaked admin token should be able to redirect a key without also holding the key
- [ ] The 503s still name the spool - "<path> is not there", "<path> has N bytes free". Deliberate
  and tested, and arguably fine for a caller the shop has named, but the same path a 500 no longer
  gives away. Decide whether an authenticated caller may know where the spool is
- [ ] The spool ROOT's own mode is nobody's job. The shop sets 0700/0600 on what it creates, but a
  root anybody can write is one where a whole job directory can be renamed away regardless. The
  installer makes the root, so either it sets the mode or `ready()` refuses a wide one
- [ ] Anything already in a spool keeps the mode it was written with - a record is written once and
  never rewritten, so an existing install stays as it was until every job has left

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
