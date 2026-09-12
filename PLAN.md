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

- [ ] The password rule is enforced and never said. `setPassword` refuses one shorter than twelve
  characters, `statusFor` has no case for `UnusableCredentials`, so `PUT /me/password` answers 500
  and "why is in its log". `ChangePassword.tsx` keeps no copy of the rule on purpose - "that rule is
  the shop's, it says so in its own words" - so nobody is ever told what it is. A case in
  `statusFor` in `packages/server/src/api.ts`

- [ ] A request naming nobody can make the shop throw. `cookieIn` calls `decodeURIComponent` on the
  raw header inside the guard, before any credential is looked at, so a cookie carrying a truncated
  escape is a 500 and a stack trace in the log written for a caller the shop cannot name; `Origin:
  null` from a sandboxed iframe does the same through `new URL(origin)`. Both still refuse, which is
  the safe direction, but neither meant 500. `validateDetails` is the authenticated half of the same
  thing: it reads `details.filaments.length` without checking it is an array, so `{}` and
  `{"filaments":"PLA"}` are 500s where 400 was intended

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
`statusFor` and is tested. The other five are the running things an AT is for: `createApi`,
`claimData`, `pushSocket`, `OctoPrintMachines`, `startOctoPrintServer`.

**`theRunningShop.test.ts` keeps 35 of 39.** Restarts, signals, the data lock, the listen address
and `init` - a spawned process is the only thing that can answer any of them. The `--help` cases are
not among them; see Fix Tests.

### Fix Tests

A second pass over every acceptance test, 2026-09-12. Each item is an acceptance test making a claim
a unit test already makes, or could make better and faster. Every one has a sibling that IS unit
tested, which is what makes these oversights rather than decisions - the same test that found the
last batch. `api.test.ts` is 142 cases in 10.8s and about 40 of them are below; the timings are from
a run of that file on its own.

- [ ] **The role table is a pure function asked over a socket.** `needsAdmin(method, path)` in
  `api.ts` is a function of two strings, and the middleware hands it `request.path` verbatim - so
  all of the normalising (HEAD as GET, a trailing slash, a shouted path) is inside it. Five blocks of
  `who is asking` are its truth table: `lets a user %s %s` (4), `will not let a user %s %s` (5),
  `needs an admin for a route it has never heard of` (1), `lets a user %s %s, which express routes to
  one they may have` (5) and `still needs an admin for %s %s` (3). Export it and those 18 become a
  table. The guard itself comes out beside it as a function over something request-shaped, so that
  refusing a user by role and letting one through are unit tests too, and so is the order it is
  mounted in - `createApi` answers a request without a listener, and neither the rule nor the
  ordering is a thing about the request object. One acceptance test is left, and it is the raw
  request line: see below. The same move as `onePrinterName`

- [ ] **Four acceptance tests that repeat a unit test by name.** `forgets what was counted against
  somebody who then gets it right` is `attempts.test.ts`'s own sentence, run twice here - on the
  login route (469ms) and on the password route (724ms). `is a different session every time, so an
  old cookie is not the one in use` (201ms) is `sessions.test.ts`. `refuses a build volume with %s`
  (2) is seven cases in `printerIn`'s. What each was meant to prove about wiring is proved by the
  neighbour that stays: the two `makes somebody wait...` 429s already say Attempts is consulted on
  both routes

- [ ] **Three body rules a route still keeps inline.** `loadedIn`, `stoppedIn`, `printerIn` and
  `keyIn` were pulled out for exactly this reason; what was left behind is the verdict word (inline
  in `PUT /jobs/:id/verdict`), the login body and the password-change body. `refuses %j as a login`
  (3, 190-250ms each), `refuses %j as a change` (3, 190-256ms each) and `refuses a verdict it does
  not know` are what they cost through a socket. `refuses %p as a key, and adds nothing` runs
  `keyIn`'s four unit cases again, and one of the four carries the half a unit test cannot say

- [ ] **The three functions that decide who is asking have no unit test at all.** `cookieIn`,
  `tokenIn` and `requireItCameFromHere` are pure or two headers wide, and all anybody knows about
  them is read back off a status code. The three `a write carrying a session` cases are a table plus
  a login apiece. The Security item above - a truncated escape in a cookie making `decodeURIComponent`
  throw, and a 500 for a caller the shop cannot even name - cannot be written as a unit test today
  because the function is not exported, which is the argument in one line

- [ ] **`statusFor` is said to be tested and is not.** The Tests section above leaves seven empty
  `Error` subclasses untested on the grounds that what matters about them is the status each maps to,
  "which is `statusFor` and is tested". It is reached only by whichever acceptance test happens to
  trip each branch, and the missing `UnusableCredentials` case in the Security list - 500 where 400
  was meant - is what an absent row looks like. This one adds cover rather than taking a test away

- [ ] **`what to load next` re-asserts what `selection.test.ts` proves.** Busiest-first, and counting
  only what a named machine could take, are both unit tested over `waitingOn`. Both acceptance tests
  stay, but for the wiring: that the route reaches `waitingOn` with the printer the query named,
  rather than checking again what order it puts them in

- [ ] **The client repeats one refusal rule four times.** `repeats what the shop said` is in the
  client's unit test, again in its acceptance test, and a third time under `changeMyPassword` there.
  One of them is the rule; the rest are the rule over a socket

#### Re-opened by the rule above, and not yet decided

These were off the list because an acceptance test was thought to be for "a route being wired to what
it claims". That ground is gone, so each is here until it has been argued rather than assumed. The
question for every one of them is the same: is the fake a unit test would need the thing the test
claims?

- [ ] `octoPrintMachines` - `refuses a printer whose key was left blank` and `refuses a printer
  nobody has given a key, saying where one goes` involve no server in the claim at all. The client
  keying - same printer, same client; a moved address or a corrected key, a new one - is a decision
  over a record and could be a unit test with a client factory handed in. What needs the socket is
  that reaching a printer OPENS one before anything is sent, and that `closeAll` really lets go
- [ ] `octoPrintStrictness` - whether an auth frame is acceptable (an api key in place of a session,
  a session never issued, a frame that is not an auth frame) is a predicate inside the sim. What
  needs the socket is that the server acts on it, and answers an unauthenticated socket with silence
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

- `dataLock`, `pushSocket`, `reconnectRecovery` - the fake would be the kernel, libuv's own error
  text, and a socket that really dies. Each is the claim itself
- `theShopAndItsClient` - a fetch handed in would let the client drive the app in-process, but the
  request bridge written to do it is exactly where the assumption about how a URL becomes a path
  would be written down. That bridge is the claim
- In `api.test.ts`, the raw request line reaching the guard: `/jobs/`, `/JOBS`, `HEAD /jobs`,
  `/jobs?x=1`, `/printers/..%2F..%2Fetc`

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
