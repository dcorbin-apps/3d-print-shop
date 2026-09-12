# 3D Print Shop Development Plan

What is still to do. Finished work is not recorded here - the reasoning behind each decision lives
in `AIDEV-NOTE`s beside the code it explains, and the rest is in git.

See [design/3d-print-shop.md](design/3d-print-shop.md) for the design this is working towards, and
[design/octoprint-sim.md](design/octoprint-sim.md) for the stand-in printer the tests run against.

## Remaining Work

### Security

Found by auditing a running shop on 2026-09-12; each was reproduced against a real process rather
than read out of the code. These come before the rest of the list.

- [ ] A printer's name is checked in three places, because it arrives three ways: a path segment
  (the `/printers/:name` mount), a body (`printerIn`) and a query string (`onePrinterName`). The
  query string is the one that list forgot, and it read a `printer.json` outside the data directory
  until it did not. Three checks is two more than the note above the mount claims, and a fourth way
  in is a fourth thing to remember - so the check belongs where a name BECOMES a path, which is
  `printerDir()` in `JobStore.ts`, and every method that touches a printer's directory goes through
  it. What stops that being a one-line move is the error: the store's vocabulary is `NoSuchPrinter`,
  `WrongState` and `DataUnavailable`, none of which this is, and a new one needs a case in
  `statusFor` or it is a 500. Worth doing, not worth doing carelessly

- [ ] A client can write the shop's own fields into its job record. `submit` builds the record as
  `{ ...details, id, owner, ... }` and nothing validates the shape of `details`, so `heldBy` and
  `lastPrinterOutcome` land on disk and come back out again - `asJob`'s queued branch overrides
  `state` and not those two. `JobRecord = Omit<Job, 'state' | 'heldBy' | 'lastPrinterOutcome'>` is a
  compile-time claim that does not hold at runtime. The state machine is not subvertible, because
  `state` is always read from the printers; what is wrong is that `JobStore.ts` says "there is
  nowhere for a second answer to be written" and there is one. Copy the fields a job HAS rather than
  spreading, and leave `metadata` as the place a client puts its own. `packages/server/src/JobStore.ts`

- [ ] `validateDetails` reads `details.filaments.length` without checking it is an array, so `{}` and
  `{"filaments":"PLA"}` are 500s where 400 was intended. The two halves of this that an UNNAMED caller
  could reach - a cookie that will not decode, and `Origin: null` - are fixed; this is the
  authenticated one, and the last of the three. `packages/server/src/Job.ts`

- [ ] A description of exactly `fieldSize` is refused for being longer than it. Busboy flags a value
  truncated on REACHING the limit rather than passing it, so a 1048576-byte `job` part arrives whole,
  with nothing cut and JSON that would have parsed, and `PUT /jobs` answers `the job part is longer
  than 1048576 bytes`. api.ts:36 names this exact trait - "busboy raises 'limit' on REACHING fileSize
  rather than passing it - exactly that mistake waiting to happen" - as the reason there is no
  fileSize, and then uses fieldSize, where it happens. One byte on a megabyte, so small; recorded
  because the codebase reasoned about it and still met it. Pinned by
  `tests/assumptions/multipartParts.test.ts`, which records what busboy does rather than what is
  wanted. `packages/server/src/api.ts`

- [ ] `see PLAN` in `OctoPrint.ts` at `send`, `cancel` and `filedAt` names nothing that is in this
  file. Either the work is still wanted and belongs here, or the reference goes

**What an unauthenticated caller can make the shop spend is bounded in the shop, and the reasoning
was wrong the first time it was written here.** `POST /sessions` is the one route reachable without a
credential that does real work - scrypt, by design, at 50ms and 32MB a go. That was recorded as the
service's capacity and somebody else's problem, and then measured: scrypt runs on the libuv
threadpool and so does every file read the job store makes, so four concurrent logins took a
`GET /jobs` from 1.4ms to 60ms and sixteen took it to 3.4 seconds - which is prints not starting.
Nothing outside the process can see that coupling, and no proxy can know the right number for it,
because the right number is the threadpool's size. So `HASHES_AT_ONCE` in `secrets.ts` bounds how
many passwords are hashed at once, at half the pool, and everything past that queues. Raising
`UV_THREADPOOL_SIZE` instead was measured and is worse: it turned a 112MB shop into a 2.1GB one.

What is genuinely NOT answered here, and is the deployment's: a login flood still makes LOGGING IN
slow, because there is no way to check a password without hashing one - the shop keeps printing
through it, which is the whole of what it can do about it. So is a flood of connections. Loopback is
the default for both reasons.

**Where a printer's address may point is decided, and recorded here because `addressIn` says it is.**
An admin may point a printer at any http or https address, and the shop will POST a plate's gcode
there with that printer's `X-Api-Key` on it. A hostname resolves at connect time, so a range check
when the printer is added does not hold against rebinding, a printer reached over a VPN is
legitimate, and only an admin may add one at all - which is close to what admin means. Accepted, not
work to do.

### Tests

A test that CAN be a unit test IS one. An acceptance test is for what a unit test cannot say at all,
and one thing makes it so: the fake a unit test would need is the very thing the test claims. A fake
request object proves a rule, and proves what order the guard is mounted in, because neither of those
is about the request object; it cannot say what express makes of a raw request line, because that is
where the author writes down the answer they assumed. The same reason a hand-built multipart body
proves only that the test can build one, and a fake WebSocket proves only that the client behaves as
its author imagined the protocol works.

"A route being wired to what it claims" stood here and was wrong. An express app is a function of a
request, so the real router and the real mount order can be driven in-process with no socket at all -
and everything kept out of the unit suite on that ground goes back on the table. An AT also reports a
status code where a UT reports which rule refused and why, which is the lesser half of the argument
and was doing all the work here.

Both of the items that were here are done. What is left of that sweep, deliberately:

**Twelve exported things no unit test names, and none of them should.** Seven are empty `extends
Error` subclasses (`NotAKnownCaller`, `NotTheirs`, `TooManyGuesses`, `TooMuchToTake`,
`NoPrinterCanTakeIt`, `DataInUse`, `NotAuthenticated`), where a test would assert that a class
extending Error extends Error - what is worth testing about them is the status each maps to, which is
`statusFor` - which is tabled now, every row of it, because the row that was missing is what told a
client its own mistake was the shop's fault. The other five are the running things an AT is for:
`createApi`, `claimData`, `pushSocket`, `OctoPrintMachines`, `startOctoPrintServer` - and of those,
`OctoPrintMachines` and `startOctoPrintServer` have since been given seams and are unit tested.

**There is a third kind, and it does not run with the others.** An assumption test pins what
THIRD-PARTY code we depend on actually does, where the shop's correctness rests on the answer: `ws`
raising libuv's error where node's own WebSocket collapses every failure into one sentence, busboy
truncating at the cap and ending the stream as though the file were whole, express routing
non-strictly and case-insensitively and serving HEAD from a GET route, and what node's HTTP parser
leaves in `req.url`. None of that can change because somebody edited this repository, so none of it
belongs on a commit - and a red one says the world moved rather than that you broke something, which
is a different thing to be told and wants a different answer. Run it when a dependency or the node
version goes up. The OS is deliberately out of scope: a kernel does not move under you the way a
minor version does, so the data lock stays an acceptance test.

Nothing runs it for you - there is no CI here - and a suite that runs only on upgrade is one that can
sit red for a year and then be indistinguishable from the upgrade that found it. It is cheap, so run
it oftener than the rule asks.

**Ask whether ANY unit test can say it, not whether a unit test of this class can.** The rule above
was applied to `octoPrintMachines` and got the wrong answer: a unit test of `OctoPrintMachines` must
hand over a machine, so it cannot say that reaching a printer opens a connection - which looked like
the fake being the claim. It was not. That claim is `OctoPrint`'s, whose socket factory is injected
one level further down, and `OctoPrint.test.ts` already made it. The evidence was seven mutations run
against both suites: the acceptance file caught five, a unit test caught every one of those five, and
the two it missed were caught by unit tests as well. Zero unique coverage. Look down the chain for an
injected collaborator before concluding that only a running thing can answer.

**`theRunningShop.test.ts` keeps 35 of 39.** Restarts, signals, the data lock, the listen address
and `init` - a spawned process is the only thing that can answer any of them. The `--help` cases are
not among them; see Fix Tests.

### Fix Tests

A second pass over every acceptance test, 2026-09-12. All seven items are done. The acceptance suite
went 243 to 205 and `acceptance/api.test.ts` 142 to 107; unit tests went 1028 to 1148, and a third
suite of 16 holds what third-party code does. It found three things that were not about tests at
all: two 500s an unnamed caller could provoke, a missing row in `statusFor` that meant the one rule
about a password was never said to anybody, and that nobody but an admin could log out.

What is left of it is below: the files the corrected rule re-opened, which have not been argued yet.

#### Re-opened by the rule above, and not yet decided

These were off the list because an acceptance test was thought to be for "a route being wired to what
it claims". That ground is gone, so each is here until it has been argued rather than assumed. The
question for every one of them is the same: is the fake a unit test would need the thing the test
claims?

- [ ] `theRunningShop` - the `--help` cases. The check runs before commander is given argv, and the
  note says nothing calling `createCLI()` would notice if it did not - but a function over argv
  would. The other 35 are a spawned process and stay
- [ ] `jobLifetime` - no socket and no process: it is `JobStore` over a real temporary directory at
  8MB, which is what `JobStore.test.ts` already does at a few bytes. The size is the point of it, and
  the size is not what makes a test an acceptance one. It may simply belong in `tests/`
- [ ] `api.test.ts` - the cookie's three attributes, the two 503s and the page-serving guard are all
  express and the store, both of which run in-process. The multipart ordering and the drain are not:
  a body built by hand is the thing being claimed

Not re-opened, and now for a stated reason rather than by category:

- `dataLock`, `reconnectRecovery` - the fake would be the kernel and a socket that really dies. Each
  is the claim itself, and the kernel is out of the third suite's scope on purpose
- `theShopAndItsClient` - a fetch handed in would let the client drive the app in-process, but the
  request bridge written to do it is exactly where the assumption about how a URL becomes a path
  would be written down. That bridge is the claim

### The service

- [ ] The shop can say when IT is in trouble, rather than only what each printer is doing. A store
  or data-directory fault is nobody's printer's fault and now stops nothing, so a log line is all there is -
  and nothing a client or an operator asks answers "the shop is not well". The contract has no
  shop-level status at all: `printers()` is the closest thing, and a fault that touches every
  printer at once has nowhere to be seen
- [ ] Positional filaments, when there is a printer with more than one extruder. Scheduling uses
  only a job's FIRST filament today, which is right for one extruder and wrong for several: the
  index is the extruder the slicer assigned, so `[red, blue]` and `[blue, red]` are different
  requirements. `startsWith()` in `packages/server/src/selection.ts` is the one place to revisit

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
