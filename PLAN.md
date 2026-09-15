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
- [ ] A printer OctoPrint calls offline is shown by the shop as idle, which is the shop stating
  something false rather than merely saying nothing. `stateOf` in `packages/ui/src/shopSummary.ts`
  ends `return { condition: 'idle' }`, and every condition above it - unreadable, stopped, refused,
  awaiting-approval, unreachable, out-of-contact, printing - is something the SHOP knows from its own
  bookkeeping. None of them is what the machine says about itself. So when the serial link between
  OctoPrint and the printer is down, OctoPrint answers over http perfectly well, nothing above fires,
  and the fallback prints the word `idle` on a machine that cannot take a job.

  `idle` means "the shop knows of nothing wrong" and is READ as "ready to print". Those are not the
  same claim and the gap between them is the whole bug.

  It is not only cosmetic. The foreman will pick that machine, the upload will succeed - OctoPrint
  takes files whether or not the printer is connected - and only the command to start will fail, as
  `could-not-start` followed by a backoff. The shop recovers, so nothing is lost but an upload and an
  operator's confidence.

  DECIDED: a printer the machine says is not operational is UNAVAILABLE, and unavailable means not
  scheduled on - not merely shown differently. So this is a change to `canTake`/`printableNow` in
  `selection.ts` first and to `stateOf` second, and the new condition belongs beside `unreachable` and
  `outOfContact` rather than as a word on a screen.

  DECIDED: it is kept current from OctoPrint's push stream rather than asked for once. The shop
  already parses exactly this payload - `printIsInFlight` reads `state.flags` off the `current`
  messages - so the fact is arriving on a socket that is already open and is being thrown away.
  `/api/printer` is still worth asking on the way in, for the first answer before any message
  arrives.

  The tension to settle before any of it: reaching a machine is LAZY on purpose. `OctoPrintMachines.reach()`
  opens the socket and reconnects indefinitely, but `printing.ts` says a machine is reached "only once
  there is something for it to print", so an idle printer with an empty queue has no socket and the
  shop hears nothing about it. Live availability wants the opposite - a socket per printer, always,
  so that a machine going offline is known before there is work for it. That is a deliberate decision
  being reversed, and the note in `printing.ts` says why it was made, so it is to be argued with
  rather than stepped over. The middle answer, if the cost of always-on turns out to matter: reach
  eagerly only for machines that could take something currently queued.

  Related to "Report a printer's own state" under **Beyond one printer**, and sharper: that one is
  about what would be nice to know, this one is about the shop being wrong and acting on it.

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

- [ ] The borrowed protocol has been driven by a real slicer end to end, and one thing is left.

  What was proved, on 2026-09-15, against PrusaSlicer 2.9.6 on macOS: a physical printer of host type
  OctoPrint, pointed at `http://localhost:7373/octoprint/`, tests green and sends. It probes
  `GET /octoprint/api/version` and posts to `/octoprint/api/files/local` 27ms later, so the subpath
  join - the assumption the whole prefix rested on - holds, and the token it was given in the
  borrowed protocol's own header resolved to a caller. The plate it sent was read for its filament,
  its estimate and its bed exactly as the fixture is. No second listener on a port of its own is
  needed, and that idea can be dropped rather than kept warm.

  One snag, and it was not the shop's: a URL pasted with a stray character fails as libcurl's
  `CURLE_URL_MALFORMAT` before a socket is opened, so NOTHING reaches the shop and its log is empty.
  Anybody debugging this should look at the log first - an empty one means the slicer never sent, and
  no amount of reading this code will explain it.

  * A SECOND DIALECT, when there is a second tool to support. One real plate is kept as
    `packages/server/tests/assumptions/aRealPlate.gcode` - named past the `*.gcode` rule in
    .gitignore, because a fixture is not print work - and pinned by whatAPlateSays.test.ts, so every
    spelling `slicedPlate.ts` looks for is measured rather than remembered. The unmeasured ones
    belonging to other tools came out when the dialect gate went in. Adding a tool is three things
    together: the dialect in `slicedPlate.ts`, its spellings beside the ones already there, and a
    real plate from it in tests/assumptions. None of this is guesswork now, and none of it should be
    allowed to become guesswork again

  What is DONE and needs no revisiting: it is a face over the same `submit`, under `/octoprint`,
  out of the page fallback; the token is read from the other protocol's header under that prefix and
  nowhere else; commanding a queue is refused with a reason; and what a job needs is read from the
  plate's own comments, in the face and never in the store. A real plate keeps its settings within
  17K of its last byte against a 64K window, and names the settings profile it was sliced with beside
  the material - which is deliberately not read, because it is a name in somebody else's namespace
  and a job waiting for it would wait for ever. And only ONE dialect is read: a plate says what wrote
  it on its first line, and anything the shop has not measured against a real file is refused by
  quoting that line rather than by guessing at its spellings.

  And upload-and-print is SETTLED, by pressing it: the shop queues the plate rather than starting it,
  the answer says `queued`, and what the slicer showed for that was reported as a positive result
  with no complaint. Exactly what it displayed was not written down, so if somebody later finds it
  misleading this is where to start rather than a contradiction of it - but nothing is to be built
  for it on a guess, which is what the open item here would have been.

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

### The page

- [ ] Each job wants a menu of its own: **pause/resume**, **delete**, and **rename** to change the
  display name. Delete is straightforward and the other two are not, because two of the three ask for
  something the store is built not to do.

  DELETE does not exist anywhere yet, in any form. `Shop` has `removePrinter` and nothing for a job;
  a job leaves only by a verdict, and a verdict can only be given on one awaiting approval. So a
  QUEUED job cannot be got rid of at all today - it waits for a filament nobody intends to load,
  for ever. That alone is worth fixing. It needs a route, a method on the contract, the gcode going
  with it, and the same ownership rule the verdicts use: the owner, or any admin.

  PAUSE/RESUME and RENAME both collide with "a job record is written once and never rewritten".
  `asJob` derives a job's state ENTIRELY from which printer is holding it - no holder means queued,
  and nothing is written to say so - so a job held back by a person is a fact about a job that no
  printer holds, which is exactly the kind of thing this store has nowhere to put. Rename is the same
  collision in plainer clothes: `displayName` is on the record.

  Three ways out, and the third is the one that fits:

  * relax the rule to "written once, except what a person may change". Honest about what is being
    asked, and it is the rule the whole store is built on - everything that moves belongs to a
    printer, and this would be the first exception
  * do neither, and let a job be deleted and re-submitted instead. Cheap, and it loses the queue
    position and the id
  * keep the record immutable and put what a person later says about a job in a SECOND file beside it
    in the job directory. The record stays the submission, exactly as written, and the file next to
    it holds the name somebody changed it to and whether they have held it back. There is already a
    precedent to copy rather than invent: a printer's directory is its record and its status as two
    files, for this same reason

  Whichever is chosen, the menu is the easy half. The store's answer is the design.

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
