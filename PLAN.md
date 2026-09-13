# 3D Print Shop Development Plan

What is still to do. Finished work is not recorded here - the reasoning behind each decision lives
in `AIDEV-NOTE`s beside the code it explains, and the rest is in git.

See [design/3d-print-shop.md](design/3d-print-shop.md) for the design this is working towards,
[design/testing.md](design/testing.md) for how it is tested and why,
[design/security.md](design/security.md) for what stops a request that is not really somebody's, and
[design/octoprint-sim.md](design/octoprint-sim.md) for the stand-in printer the tests run against.

## Remaining Work

### The service

- [ ] Stream a plate to the printer rather than reading it whole. `send` in `OctoPrint.ts` builds the
  upload with `FormData`, which wants a Blob, and a Blob wants its bytes - so a gcode the shop was
  careful never to hold while STORING it is held whole while sending it, up to `maxGcodeBytes` and
  128MB by default. Streaming it means writing the multipart body by hand. Worth doing when a plate
  is big enough to notice, and nothing has measured that yet

- [ ] The shop can say when IT is in trouble, rather than only what each printer is doing. A store
  or data-directory fault is nobody's printer's fault and now stops nothing, so a log line is all there is -
  and nothing a client or an operator asks answers "the shop is not well". The contract has no
  shop-level status at all: `printers()` is the closest thing, and a fault that touches every
  printer at once has nowhere to be seen
- [ ] Positional filaments, when there is a printer with more than one extruder. Scheduling uses
  only a job's FIRST filament today, which is right for one extruder and wrong for several: the
  index is the extruder the slicer assigned, so `[red, blue]` and `[blue, red]` are different
  requirements. `startsWith()` in `packages/server/src/selection.ts` is the one place to revisit

- [ ] Revisit caching what the printers directory holds, but only if something measures slow - the
  case for it is thin and was thinner than it first looked. Nothing is cached: `printerNamed` is a
  readdir and two file reads, `printers()` a readdir and two per printer. This was written up when a
  request looked up a printer three times over; counting them found two of those three were the same
  lookup repeated, and removing them is done. What is left, measured, is two per request on the
  printer routes - the name resolved once, and the printer read back after the write - and the second
  is the point of the write, so no cache may answer it. The genuine new cost is the readdir every
  lookup now pays to resolve by matching rather than by joining. If it ever matters, memoise the
  LISTING for the life of a single request: it cannot go stale, because nothing the shop does
  mid-request changes which printers there are. A cache that outlives a request is a second answer to
  that, which is what this store is built not to have. `packages/server/src/JobStore.ts`

### Security

Found by reading the whole of `packages/server/src`, the client and the installer, rather than by
anything going wrong. The shop listens on loopback unless told otherwise and the auth model holds,
so none of these is urgent - they are the places that read as gaps beside the rules the rest of the
code keeps.

- [ ] Decide what a lockout is worth, because right now anybody who can reach the port can hold a
  caller out. `attempts.ts` counts against the id and nothing else, and `mustWait` is asked before
  the password is - so four wrong guesses against a name put that caller behind a doubling wait, and
  one more every quarter of an hour keeps them there indefinitely. Knowing the right password does
  not help: `wasRight` is never reached. `PUT /me/password` shares the count, so they cannot change
  their password out from under it either. Counting against the ADDRESS was worse and was removed for
  the reasons written down there; what replaced it left nothing standing between an attacker and a
  named caller. On one workshop's network that may be the right trade - but it should be a decision
  rather than what fell out of fixing the other one

- [ ] Serialise what writes the credential files. `changeCallers` and `writePrinterKey` in
  `credentials.ts` each read the whole file, change it, write `<file>.new` and rename over - with no
  lock and the same scratch name every time. Two password changes at once lose one of them, and the
  caller who lost was answered 204 and had every other session of theirs ended, so they are holding a
  password the file does not have. Two writes interleaving in one scratch file is the worse half: the
  rename publishes something that will not parse, and a shop that is restarted after that refuses to
  start. `JobStore` serialises exactly this shape with `this.serialised`; this file does not

- [ ] The page is served with no security headers at all - no CSP, no `nosniff`, nothing about who
  may frame it, and express's `x-powered-by` left on. The session cookie is HttpOnly, so a script
  that got into the page cannot read it, but it can act through it, and a CSP is the layer that stops
  such a script running in the first place. Nothing here is a live hole; it is the layer under the
  one that is holding. `servePageFrom` in `packages/server/src/api.ts`

- [ ] `defaultToken()` reads the token file without looking at its mode. The server refuses its OWN
  credential files at anything looser than 0600 - `readOnlyByItsOwner` in `credentials.ts`, for the
  reason ssh does it - and the installer tells an operator to `chmod 600` this very file. So the rule
  is written down twice and enforced in neither of the places that would catch somebody getting it
  wrong. `packages/client/src/token.ts`

- [ ] One unreadable file in the data directory stops the whole shop, where everywhere else a file
  that cannot be read leaves things as they were and says why. `readRecord`, `readPrinter` and
  `readStatus` in `JobStore.ts` catch the `readFile` and not the `JSON.parse` - and everything goes
  through `printers()`, so a single unparseable `printer.json` or `status.json` takes down the job
  list, the printer list, submission and the printing loop at once, and a restart does not clear it.
  Not an attack: these are the shop's own files and they are written atomically. It is the one place
  the rule the rest of the shop keeps is not kept

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
