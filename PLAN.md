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

**`theRunningShop.test.ts` keeps 35.** Restarts, signals, the data lock, the listen address and
`init` - a spawned process is the only thing that can answer any of them. The four `--help` cases are
gone: `main.ts` is one line now and what it used to hold is `run()` in `cli.ts`, asked directly.

### Fix Tests

A second pass over every acceptance test, 2026-09-12. All seven items are done. The acceptance suite
went 243 to 205 and `acceptance/api.test.ts` 142 to 107; unit tests went 1028 to 1148, and a third
suite of 16 holds what third-party code does. It found three things that were not about tests at
all: two 500s an unnamed caller could provoke, a missing row in `statusFor` that meant the one rule
about a password was never said to anybody, and that nobody but an admin could log out.

What is left of it is below: the files the corrected rule re-opened, which have not been argued yet.

#### What the acceptance suite is now

It went 243 to 48 across this sweep, and every file left is there for something a unit test cannot
say - argued one at a time rather than by category, and twice the argument was wrong and the file
went.

- `aShopThatActuallyStops` (1) - that the process ENDS when asked, rather than answering and staying
  up, which would look identical to a client. Everything it used to also cover has gone to where it
  can be asked directly: what stopping lets go of and in what order is `running`, what a signal does
  is `signals`, which address is taken is `serve`, what a command does is `operatorCommands`, and what
  node does with a signal or an empty event loop is the assumption suite
- `httpShop` (15) - what the client puts on the wire, against a stand-in

Five went after that, and how they went is the most useful thing in this section. `drainingARefusedUpload`
kept a socket because a refused upload has to be READ to the end or the request never completes, and
that was thought to need a real connection. It does not: the mechanism is node's stream backpressure,
and a request that hands its body over only when asked reproduces it exactly. The harness had been
pushing whole bodies in at once, so it had no flow control to observe and a stalled reader looked
identical to a finished one - three separate "only a socket can show this" arguments rested on that,
and all three were wrong. `tests/inProcess.ts` hands over 16KB at a time now, like a socket, and the
claim is a unit test that says `wasDrained` rather than an acceptance test that said `400`.

`dataLock` went for a reason worth keeping in front of you, because it is the cleanest statement of
the rule this section is about. Are you testing the kernel, or what we do in response to the kernel?
The first is not ours and should not be in our tests; the second never needs a socket. `claimData`
takes a `Claiming` now - listen, answers, clear - and eleven unit tests say what the shop does when
each answers: refuse and name the directory, clear a leftover and take it, and report a failure that
is not "somebody has this" as what it actually was. That last branch was in the code untested for as
long as the file existed, and no acceptance test could reach it: the read-only directory that makes
`listen` fail makes the tidy-up fail too, so the two never come apart through a real socket. Splitting
the question is what made it reachable. What the kernel does is `aListeningClaim` in the assumption
suite, where a red line means the world moved rather than that somebody broke something.

`theShopAndItsClient` went for the same reason, one question later. It was kept because both halves
of the contract have to be live at once - which is true - and defended on the grounds that a bridge
between them would be where the URL-to-path assumption got written down. That was the wrong half to
look at: the transport is node and undici, and testing it is not ours. `HttpShop` takes a `fetch` now
and the shop's suite hands it one that reaches a real `createApi`. Undici serialises the request, so
a multipart body still gets its boundary from the code that would write it to a wire; express routes
and answers it; only the wire is skipped, and what node's parser makes of one is already pinned. The
contract still catches a 201 that stops being sent, a status that stops being read, a time that stops
becoming a Date, and a camera that stops being answered.

`theRunningShop` went from 39 to 1 over the sweep, and the last five went on the same question. Where
a shop listens is its own decision and node's binding - the decision is `serve.test.ts`, and the
binding is node's. A signal arriving is node's; which ones are answered and what each does is ours
and needs no process. A token travelling from an environment through the client to a guard is ours
all the way, and once `reachTheShop` and `HttpShop` would each take a way to reach, it composes
in-process - carrying the token is ours, carrying the bytes is node's. What is left is the sum:
everything the shop holds is let go, so node ends it. Each part of that is tested; only the sum is
not, and only a process can be asked whether it ended.

`reconnectRecovery` was the last, and the measurement is worth keeping. Against the same mutations it
caught strictly LESS of the reconnect logic than `OctoPrint.test.ts` does through an injected socket -
it missed the frame spent on an empty map, which is the lost-outcome race found and fixed the same
day. The frame shapes it appeared to pin are pinned by the sim's own tests on one side and
`OctoPrint.test.ts` on the other. What it alone caught was `pushSocket`: a text frame arrives from
`ws` as a Buffer where the DOM gives a string, and handing it on undecoded makes every frame the
printer sends unreadable, which no injected socket would notice.

That went the same way one question later. What `ws` emits and what the shop turns it into are two
claims, and only the second is the shop's. `adapting` is a function over a socket-shaped thing now,
asked with a stand-in and no socket at all - the stand-in is not the claim, because the claim is the
MAPPING rather than what is being mapped - and it catches six mutations where the real-socket version
caught four, because being open and a reason being passed on are easy to ask of a stand-in and
awkward to ask of a server. What `ws` hands over is `whatWsEmits` in the assumption suite: a Buffer
for a text frame, `isBinary` to tell one from the other, and a close that arrives unasked.

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
