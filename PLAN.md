# 3D Print Shop Development Plan

What is still to do. Finished work is not recorded here - the reasoning behind each decision lives
in `AIDEV-NOTE`s beside the code it explains, and the rest is in git.

See [design/3d-print-shop.md](design/3d-print-shop.md) for the design this is working towards, and
[design/octoprint-sim.md](design/octoprint-sim.md) for the stand-in printer the tests run against.

## Remaining Work

### Security

Found by auditing a running shop on 2026-09-12; each was reproduced against a real process rather
than read out of the code. These come before the rest of the list.

- [ ] `metadata` is typed `Record<string, unknown>` and anything JSON can hold is accepted under it -
  `"hi"` is stored as a string. Nothing is wrong with that behaviour: metadata is carried and never
  interpreted, so any value is as good as any other. What is wrong is the type claiming otherwise,
  and widening it is a change to the wire contract rather than to the shop. Noticed while the fields
  beside it were being checked `packages/client/src/Job.ts`

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

#### The acceptance suite is one test, and it is the right one

It went 243 to 0 and then to 1. Every one of the 243 was argued one at a time rather than by
category, and every single argument for keeping one was wrong - including the last, and including
three that had just been written down as measured fact.

The question that settled all of them is not "could a unit test do this" but **"are we testing
somebody else's code, or ours in response to it?"** The first is not ours to test and belongs in the
assumption suite if it belongs anywhere. The second never needs a process, a socket or a kernel: it
needs a seam, and where there was no seam the answer was to make one.

The last to go was a spawned shop asked to stop, kept because only a process can be asked whether it
ended. That was true and beside the point. That node ends a process once nothing holds its event loop
open is node's, and is an assumption; what is OURS is that the shop lets go of everything it holds,
and `process.getActiveResourcesInfo()` answers that in the same process - a shop that is serving has
gained a listener and a clock, and a shop that has stopped has gained nothing. It catches every
mutation the spawned one did and says WHICH handle was left behind, where an exit code said only that
something, somewhere, did not work.

What would justify one was written down as none of the 243 turned out to be it: a claim about a
running thing that is OURS and that no seam can reach. `theHappyPath` is that claim, and it is the
only one. A machine is set up by `init`, a shop is started as its own process, a client from the
published package reaches it over a socket, a printer answers on another, and work goes round the
loop - printed, rejected, printed again, approved, and the next one started, then a shutdown the
process actually obeys.

Everything it touches is tested apart and precisely, and none of that is asked again in it. What it
asks is the one thing none of those can: that the pieces, wired the way an installed machine wires
them, carry a job from a submission to a verdict. It is one test on purpose - a second would be the
same wiring again - and it runs in under two seconds, because it polls the shop rather than sleeping.

One residue, named rather than left: `main.ts` is four lines - a shebang and
`process.exitCode = await run(process.argv)` - and nothing now runs it as a binary. `run` is unit
tested and the shebang is not. If that is wanted it is a smoke test of its own and should say so,
rather than a suite of behaviour tests carrying it.

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
