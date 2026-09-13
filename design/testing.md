# How this repository is tested

Three kinds, run three ways, and the difference between them is not how much they touch.

| kind | where | run by |
|---|---|---|
| unit | everywhere else under `tests/` | `yarn ut`, and on every commit |
| acceptance | `tests/acceptance/` | `yarn at`, and on every commit |
| assumption | `tests/assumptions/` | `yarn assumptions`, when a dependency or node goes up |

`yarn test` is the first two. Say which kind you mean when you discuss one: an unlabelled "the tests
pass" hides which of them actually ran.

## A test that CAN be a unit test IS one

An acceptance test is for what a unit test cannot say at all, and one thing makes it so: **the fake a
unit test would need is the very thing the test claims.** A fake request object proves a rule, and
proves what order a guard is mounted in, because neither of those is about the request object. It
cannot say what express makes of a raw request line, because that is where the author writes down the
answer they assumed. For the same reason a hand-built multipart body proves only that the test can
build one, and a fake WebSocket proves only that the client behaves as its author imagined the
protocol works.

"A route being wired to what it claims" was once the reason for an acceptance suite here, and it was
wrong. An express app is a function of a request, so the real router and the real mount order can be
driven in-process with no socket at all. An AT also reports a status code where a UT reports which
rule refused and why, which is the lesser half of that argument and was doing all its work.

### Ask whether ANY unit test can say it, not whether a unit test of this class can

The rule above was once applied to `octoPrintMachines` and got the wrong answer. A unit test of
`OctoPrintMachines` must hand over a machine, so it cannot say that reaching a printer opens a
connection - which looked like the fake being the claim. It was not. That claim is `OctoPrint`'s,
whose socket factory is injected one level further down, and `OctoPrint.test.ts` already made it.
Seven mutations run against both suites settled it: the acceptance file caught five, a unit test
caught every one of those five, and the two it missed were caught by unit tests as well. Zero unique
coverage.

Look down the chain for an injected collaborator before concluding that only a running thing can
answer. Where there is no seam, the answer is usually to make one.

### The question that settles it

Not "could a unit test do this" but **"are we testing somebody else's code, or ours in response to
it?"** The first is not ours to test, and belongs in the assumption suite if it belongs anywhere. The
second never needs a process, a socket or a kernel.

A spawned shop asked to stop looked like the exception - only a process can be asked whether it
ended. That was true and beside the point. That node ends a process once nothing holds its event loop
open is node's, and is an assumption; what is OURS is that the shop lets go of everything it holds,
and `process.getActiveResourcesInfo()` answers that in the same process. A shop that is serving has
gained a listener and a clock; a shop that has stopped has gained nothing. It catches every mutation
a spawned one did and says WHICH handle was left behind, where an exit code said only that something,
somewhere, did not work.

## The acceptance suite is one test, and it is the right one

`theHappyPath` is the only claim found that is about a running thing, is OURS, and that no seam can
reach. A machine is set up by `init`, a shop is started as its own process, a client from the
published package reaches it over a socket, a printer answers on another, and work goes round the
loop - printed, rejected, printed again, approved, and the next one started, then a shutdown the
process actually obeys.

Everything it touches is tested apart and precisely, and none of that is asked again in it. What it
asks is the one thing none of those can: that the pieces, wired the way an installed machine wires
them, carry a job from a submission to a verdict. It is one test on purpose - a second would be the
same wiring again - and it runs in under two seconds, because it polls the shop rather than sleeping.

Before adding a second, write down the claim it makes and check that no seam reaches it. Every
argument for keeping one of the 243 that used to be here turned out to be wrong, including three that
had just been written down as measured fact.

## Assumption tests, and why they do not run with the others

An assumption test pins what THIRD-PARTY code we depend on actually does, where the shop's
correctness rests on the answer: `ws` raising libuv's error where node's own WebSocket collapses
every failure into one sentence, busboy truncating at the cap and ending the stream as though the
file were whole, express routing non-strictly and case-insensitively and serving HEAD from a GET
route, what node's HTTP parser leaves in `req.url`, and what `fetch` does at the edges.

None of that can change because somebody edited this repository, so none of it belongs on a commit -
and a red one says the world moved rather than that you broke something, which is a different thing
to be told and wants a different answer. Run it when a dependency or the node version goes up.

Nothing runs it for you; there is no CI here. A suite that runs only on upgrade is one that can sit
red for a year and then be indistinguishable from the upgrade that found it. It is cheap, so run it
oftener than the rule asks.

The OS is deliberately out of scope: a kernel does not move under you the way a minor version does.

## What is deliberately not tested

The empty `extends Error` subclasses - `NotAKnownCaller`, `NotTheirs`, `TooManyGuesses`,
`TooMuchToTake`, `NoPrinterCanTakeIt`, `DataInUse` - where a test would assert that a class extending
Error extends Error. What is worth testing about them is the status each maps to, which is
`statusFor`, and that is tabled: every row of it, because the row that was once missing is what told
a client its own mistake was the shop's fault.

`main.ts` is a shebang and `process.exitCode = await run(process.argv)`, and nothing runs it as a
binary. `run` is unit tested; the shebang is not. If that is wanted it is a smoke test of its own and
should say so, rather than a suite of behaviour tests carrying it.
