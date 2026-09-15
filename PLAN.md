# 3D Print Shop Development Plan

What is still to do. Finished work is not recorded here - the reasoning behind each decision lives
in `AIDEV-NOTE`s beside the code it explains, and the rest is in git.

See [design/3d-print-shop.md](design/3d-print-shop.md) for the design this is working towards,
[design/testing.md](design/testing.md) for how it is tested and why,
[design/security.md](design/security.md) for what stops a request that is not really somebody's, and
[design/octoprint-sim.md](design/octoprint-sim.md) for the stand-in printer the tests run against.

## Remaining Work

### The service

- [ ] FUTURE - not a near-term task. Stream a plate to the printer rather than reading it whole.
  `send` in `OctoPrint.ts` builds the upload with `FormData`, which wants a Blob, and a Blob wants its
  bytes - so a gcode the shop was careful never to hold while STORING it is held whole while sending
  it, up to `maxGcodeBytes` and 128MB by default. No plate here has been big enough to notice, and
  nothing has measured one.

  Two things are settled already, so whoever picks it up need not find them out again: node's `fetch`
  takes a streamed body (`duplex: 'half'`), so the work is the multipart framing rather than a fight
  with the HTTP client; and the body's length is arithmetic rather than chunked, because `gcodeBytes`
  is on the job record and `startNextPrint` is holding the job when it calls `send` - which avoids
  having to find out what OctoPrint makes of a chunked upload

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

- [ ] Present an OctoPrint-shaped API for job submission, so anything that already knows how to send
  to an OctoPrint can send to the shop instead without being written against the shop at all.

  It is a FACE, not a second contract. `POST /jobs` stays the one way in; this translates into the
  same `submit` and reaches the store through it. A route of its own into the store would be the
  second copy that drifts.

  The hard part is not the multipart - `packages/octoprint-sim/src/octoPrintServer.ts` has served
  that protocol from the other side all along. It is that `POST /api/files/local` carries a file, a
  path and two flags, and NOTHING the shop schedules on: no filament, no build volume, no estimate.
  So the item is really "where do a job's requirements come from when the protocol has no room for
  them", and there are three answers worth weighing before any of them is built:

  * read them out of the gcode's own header comments. This is the shop reading what it prints, which
    is a real change to what it is - but it is NOT a departure. The best-built system in this space
    does exactly this: it parses the header itself and serves `filament_type`, `estimated_time` and
    the rest as a file's metadata, and its whole client population relies on it. Whoever weighs this
    should weigh it as the normal answer rather than the daring one.

    What the header gives, field by field, because two of these are not obvious. `filaments` and
    `estimatedPrintSeconds` come out of it cleanly. `requiredBuildVolume` comes from the BED IT WAS
    SLICED FOR, which reads like an over-estimate and is in fact the right number: a plate's absolute
    coordinates include the prime line, the skirt and the wipe tower, all placed against that bed, so
    a small object sliced on a big machine really does need the big machine. The object's own
    bounding box is the UNSAFE number here, and the one not to reach for. The cost of using the bed
    is only that a small plate is not offered to a small printer that would have taken it - which is
    nothing until there are two printers of different sizes. And `printer` must NOT be filled from
    the header: what is in there is a profile name in the slicer's namespace, not a machine an
    operator registered here, and that field means PIN IT TO THAT ONE - absent is what lets the shop
    schedule at all
  * carry them in the upload's `path`. The path is the uploader's to choose and is TEMPLATED at their
    end, so somebody can put the material in it themselves and the shop learns what a job needs
    without reading a byte of what it prints. Ugly, and the only option that keeps the shop ignorant
  * take none, and let a person say at the shop what the job needs before it can be scheduled. The
    boring one, and probably the honest first version

  Three more things whoever picks this up will meet:

  * it is not one route. A caller asks `GET /api/version`, and often `/api/server` or `/api/settings`,
    to satisfy itself it is talking to an OctoPrint before it uploads anything
  * the credential is spelled differently. That protocol puts it in `X-Api-Key`; the shop reads
    `Authorization: Bearer` (`packages/client/src/HttpShop.ts:162`). The same token in the other
    protocol's spelling is the whole of it - not a new kind of credential - but security.md has to
    say so
  * the shop is not an OctoPrint and should not pretend past the point it can hold. `print=true` means
    START NOW, and the shop's answer is "when the filament is on"; `POST /api/job` has no meaning
    against a queue at all. What to say back to those, honestly, is the design work

### Installation

- [ ] Publish `@3d-print-shop/*` to a registry. Until then a client depends on a checkout of this
  repository sitting beside it — the client it was written for reaches it as
  `portal:../3d-print-shop/packages/client`, which cannot survive a fresh clone that has no shop
  next door

  What is left is the FIRST publish, which cannot be done by the workflow that does all the others.
  npm will not attach a trusted publisher to a package that does not exist yet, so version one of each
  goes up from a machine - `yarn build && ./scripts/publish.sh`, with somebody's own 2FA - and only
  then can `dcorbin-apps/3d-print-shop` + `publish.yml` be named as the publisher on npmjs. Every
  release after that is a pushed tag and nothing else. Checked against npm's documentation rather
  than assumed; `scripts/publish.sh` asks for no provenance precisely so that first one can work.

  And a release habit: every version is `1.0.0` with nothing bumping them, which is a decision about
  how this is released rather than a line of code.

  How the page ships is settled - `ui` is a package of its own, and the installer depends on it. See
  design/3d-print-shop.md, "How the page reaches a machine", for why it is that rather than built
  into the server.

  One scrap to tidy when somebody is next in there: `octoprint-sim` emits
  `dist/octoprint-sim/tests/tsconfig.tsbuildinfo`, so its tests' tsconfig is writing into `dist`.
  Harmless, and it would be shipped.

### Beyond one printer

- [ ] Multi-printer routing — the store and the foreman already carry several, and `printableNow`
  answers per printer; what is untested is a shop actually running two at once
- [ ] Report a printer's own state — bed, temperature, filament — rather than only what an operator
  said was loaded. Do NOT design around SpoolManager: it existed once on this machine's printer and
  is gone, so assume the machine cannot answer and the operator does

### The icon in the menu bar

- [ ] A macOS menubar app that CONTROLS the shop rather than owning it. The shop stays the daemon it
  is: the app starts nothing, holds nothing, and can be closed without anything stopping. That is the
  whole of the boundary, and the reason the app has no tests worth writing.

  Availability decided nothing here and should not be re-argued. A print the shop is absent for is
  still printing - OctoPrint has the file, and `recordOutcome` picks the watch back up from the
  printer's own status on the next start. What waits while the shop is down is the NEXT job, and it
  would have waited anyway: the printer holds the job and the bed until a person gives a verdict, and
  that person is the one who is not there.

  The menu: what the shop is doing, read from the same routes the page uses; open the shop; and an
  item that closes the ICON, named so it cannot be read as stopping the shop. Stopping the shop is
  `launchctl` and root, which is the most expensive thing that could go on a menu of three - leave it
  off until somebody wants it.

  Open the shop is `shell.openExternal` at the shop's URL, and a `BrowserWindow` on that SAME URL
  when the page should live in the app instead. Same URL is the point: the page is a client like any
  other and reaches the shop over HTTP, so a window pointed at the shop is a browser pointed at the
  shop and the session cookie behaves. Do NOT ship `ui/dist` inside the app and load it from
  `file://` - that is cross-origin against an API with no CORS handling, which it should not grow.

  What would actually earn the runtime: telling somebody a print is off the bed and waiting on a
  verdict. It is the one moment the shop has no way to reach anybody, and the only reason this is
  more than a bookmark.

  POTENTIAL, and not decided: starting and stopping the shop from the same menu. It is worth writing
  down that this is not a third menu item - the daemon is root's, so it is an authorization prompt or
  a privileged helper tool, and that is the day it costs. Whether it earns that depends on the shop
  needing to be stopped often, which nothing has shown yet; `launchctl` in a terminal is what does it
  today. Revisit when somebody has actually wanted it twice.

  Two costs to know going in. CI is Linux only, so none of this is covered there - keep it thin
  enough that there is nothing to cover, and put anything worth testing in a package that is not the
  app. And it needs signing and notarization or Gatekeeper refuses it, which is the first thing that
  will cost a day.
