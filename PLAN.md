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

- [ ] The borrowed protocol is built and is untried against anything that actually speaks it. Three
  things are left, and the first is the only one that could make the rest wrong.

  * PROVE THE JOIN. Whether a tool's host field, given `http://shop:7373/octoprint`, puts
    `api/files/local` on the end of it correctly is the one assumption the whole prefix rests on, and
    it has been reasoned about rather than measured. If some tool cannot do a subpath at all, the
    fallback is a listener of its own on another port - which is a second socket to secure and
    another thing in the data lock, so it is worth knowing before anybody pays for it
  * PIN A REAL PLATE. `slicedPlate.ts` reads a TABLE of spellings - `filament_type`, `bed_shape`,
    `estimated printing time (normal mode)` and the rest - and that table was written from memory of
    somebody else's file format. One real plate in tests/assumptions would turn it from recall into
    something pinned, and adding a spelling is then a string in a list. Until that exists, a plate
    refused for naming no filament may be the parser's fault and not the plate's
  * DECIDE WHAT AN UPLOAD-AND-PRINT SHOULD SEE. The flag means start now; the shop takes the plate
    and queues it, and the answer says `queued` rather than claiming it started. That is honest and
    it is not visible - the button says it printed. Nothing is wrong yet, and the first person to
    press it will find out whether that matters

  What is DONE and needs no revisiting: it is a face over the same `submit`, under `/octoprint`,
  out of the page fallback; the token is read from the other protocol's header under that prefix and
  nowhere else; commanding a queue is refused with a reason; and what a job needs is read from the
  plate's own comments, in the face and never in the store.

- [ ] FUTURE, and deliberately held. The borrowed protocol writes a plate TWICE - once into the spool
  while it reads what the plate says about itself, and again into the job directory when it submits.
  Nothing has measured this and it is very unlikely to be what is slow: it is one sequential write of
  a file that has just arrived over the network and is still in page cache. Same judgment as the
  streaming entry above, and for the same reason.

  When somebody does measure it, the shape to reach for is a RENAME and not a handle. Let the spool
  be a directory the STORE owns on the same filesystem as the jobs - `jobs/.incoming/` - have the
  face stream into it while parsing, and finish by renaming the file into the job directory the store
  made. One write, atomic, and the store is still the only thing writing into its own tree.

  What must NOT be reached for is `submit` handing an open file out to be written into. It is safe -
  the record is written last already, so a job directory without a record is a state `all()` skips
  and the store tolerates - but it turns one method's failure window into a two-call protocol whose
  second call a crashed caller never makes. That leaves gcode in the jobs directory with no record:
  invisible to everything that reads, permanent, and an id spent. Cleaning it up means a sweep that
  deletes directories under `jobs/`, which is a far more frightening loop to write than one over
  scratch. The rename gets the same single write without any of that.

  The reason it cannot simply be done today: the spool is under the runtime directory, which is where
  it belongs while a plate is not yet work the shop has accepted - and on Linux that is usually tmpfs
  while the jobs are not. A rename across them fails `EXDEV` and falls back to a copy, which is the
  second write again with extra steps. Moving the spool under the jobs root is the part that has to
  be decided, because it puts scratch inside the directory that holds real work.

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
