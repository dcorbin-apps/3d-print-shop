# 3D Print Shop Development Plan

What is still to do. Finished work is not recorded here - the reasoning behind each decision lives
in `AIDEV-NOTE`s beside the code it explains, and the rest is in git.

See [design/3d-print-shop.md](design/3d-print-shop.md) for the design this is working towards, and
[design/octoprint-sim.md](design/octoprint-sim.md) for the stand-in printer the tests run against.

## Remaining Work

### The service

- [ ] Start a printer again by itself once it can be REACHED. The catch is narrowed - a `CouldNotReach`
  stops the printer and anything else is logged and left - so what is left is the retry itself:
  - what retries is both halves of "I could not get to this machine": unreachable (the whole
    `UNREACHABLE` table - nothing listening, a name that does not resolve, no route, a timeout) AND
    misconfigured (no key for this printer, a key the machine refuses, a login that hands back no
    session). Both are ended by something outside the shop, and a retry costs one login
  - it needs a clock. The foreman looks only after a change the shop made, and a stopped printer
    makes none. Backoff, and it stays stopped between tries
  - it needs `paused` to record WHO stopped it. An operator's reason is a fact about the room, and
    no machine can contradict it
  - preference on the retry itself: attempt the upload and only clear `paused` when a print actually
    STARTS, rather than unpausing on a reachability check and letting the ordinary look try. Two
    consequences to settle - `startNextPrint` refuses outright when `onto.paused` and that guard is
    what keeps the ordinary look off a stopped printer, and with nothing printable there is nothing
    to attempt, so a healthy machine keeps showing STOPPED until there is work it can take. That
    same preference collapses this item and the failed-upload one into a single mechanism, which is
    still open
- [ ] Try a failed upload again by itself, for a printer the shop stopped because `send` was refused.
  There is no status to read here - the retry is the test, and it is an ordinary start: the job went
  back to the queue and nothing about it was written. Needs the same origin mark on `paused` and the
  same clock as reaching a printer again. What it also needs is a way to tell an unreachable machine
  from a refusal that will never stop being one - a bad path, a full disk - because retrying the
  second re-sends a whole plate per attempt, for ever. Either back off to a ceiling and stay stopped,
  or split what `send` throws so only the unreachable half is retried
- [ ] A lost watch leaves the printer UNKNOWN rather than stopped, and picking the print back up is
  what clears it. Decided; the states are written down under `What state a printer is in` in the
  design. Two halves:
  - `watchToTheEnd` records `outOfContact` - the time and what was last seen - instead of pausing.
    A new optional on `PrinterStatus`, so the wire contract, `HttpShop`'s date revival and
    `printer list` all carry it. Nothing needs to be idled: a printer holding a job takes no work
  - the recovery is what `resumeWatching` does, for one printer, away from startup - rebuild the
    client and watch again - and the adapter's own reconciliation then settles it: still running
    that path and the watch simply resumes, not running it and the last print's result says how it
    ended. Success erases `outOfContact`, and nobody is asked to confirm anything. It needs the same
    clock as retrying a reach, and nothing else. Note what produces this, because it is rarer than
    it looks: the adapter reconnects for ever on its own, so the foreman sees it only after ten
    minutes out of contact. Known cost: a print CANCELLED during the outage reconciles as `failed`,
    because the history records cancelled as unsuccessful and only a live event says otherwise - a
    wrong word the shop would be choosing by itself rather than being told
- [ ] SIGHUP re-reads EVERYTHING in `/etc/3d-print-shop`, not only `callers.json`. Today a printer's
  key is read once at startup, so a wrong or missing one is fixed by editing a file and RESTARTING -
  and a stop outlives a restart, so the operator pays twice. Two things it touches: the keys reach
  `OctoPrintMachines` and the log's redactor as a map handed over once, which wants to become a
  supplier the way `callers` already is; and a client is cached per printer and replaced only when
  the ADDRESS changes, so a new key would not take until the cache compares it too. Replacing a
  cached client DISCONNECTS it, which would kill a watch on a running print - so a new key waits
  until the printer is idle or already unreachable. Decided: SIGHUP touches no client at all, and
  `reach()` compares the key beside the address. It is called when a print is STARTED and when one
  is picked up to watch, and a printer that is holding anything is never started on - so the swap
  defers itself, with nothing in the cache needing to know what is being watched
- [ ] The shop can say when IT is in trouble, rather than only what each printer is doing. A store
  or spool fault is nobody's printer's fault and now stops nothing, so a log line is all there is -
  and nothing a client or an operator asks answers "the shop is not well". The contract has no
  shop-level status at all: `printers()` is the closest thing, and a fault that touches every
  printer at once has nowhere to be seen
- [ ] Positional filaments, when there is a printer with more than one extruder. Scheduling uses
  only a job's FIRST filament today, which is right for one extruder and wrong for several: the
  index is the extruder the slicer assigned, so `[red, blue]` and `[blue, red]` are different
  requirements. `startsWith()` in `packages/server/src/selection.ts` is the one place to revisit
- [ ] Optional duration on a job, so `waitingOn` can rank demand by how much WORK is waiting rather
  than by how many jobs are. It has to be a field of its own — putting it in `metadata` would make
  the shop interpret a bag it promises never to read
- [ ] Guard: refuse a job whose printer does not match the machine it would print on. A client can
  say what the SLICER called the machine (`MK4IS`) in `metadata`, and whether OctoPrint names it the
  same way is unknown — that answer is needed before this can be anything but a guess

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
- [ ] `add` doubles as `change`, and a printer's key is keyed by its NAME - so re-pointing an
  existing printer's address sends that printer's key, and a plate's gcode, wherever it was pointed.
  Decided: an admin may point the shop anywhere, because that is close to what admin means, and a
  range check here would be defeated by a hostname resolving at connect time. What is left is
  whether a leaked admin token should be able to redirect a key without also holding the key

### Installation

- [ ] The spool root is created by the installer and owned by the service's user, the way
  `/var/spool/cups` is. The store refuses a missing one, and one its group or anybody else can
  write, rather than creating or fixing either - so the packaging is what has to exist: a `launchd`
  plist, a `systemd` unit, and whatever makes the directory 0700 (or 0750) and owns it
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
