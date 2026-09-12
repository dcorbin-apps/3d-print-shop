# 3D Print Shop Development Plan

What is still to do. Finished work is not recorded here - the reasoning behind each decision lives
in `AIDEV-NOTE`s beside the code it explains, and the rest is in git.

See [design/3d-print-shop.md](design/3d-print-shop.md) for the design this is working towards, and
[design/octoprint-sim.md](design/octoprint-sim.md) for the stand-in printer the tests run against.

## Remaining Work

### Security

Found by auditing a running shop on 2026-09-12; each was reproduced against a real process rather
than read out of the code. These come before the rest of the list.

- [ ] `GET /filaments?printer=` does not check the name. Every other route naming a printer goes
  through `requireUsablePrinterName` at the `api.use('/printers/:name', ...)` mount; this one takes
  the name from a query string and never reaches it, so `?printer=../../../outside` reads a
  `printer.json` outside the data directory. The three answers can be told apart - 200 for a file
  that parses, 404 for one that is not there, 500 for one that is not JSON - which is an oracle for
  any path the service user can read, and the build volume it read back then filters the queue.
  Admin only. `onePrinterName` in `packages/server/src/api.ts` is the one place to fix

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
