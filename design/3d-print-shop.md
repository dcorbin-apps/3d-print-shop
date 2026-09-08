# 3D Print Shop Design

## Purpose

A service that accepts print jobs and is responsible for getting them onto a printer: holding them
until the filament they need is loaded, submitting them, and tracking what has been printed.

**It knows nothing about gamebox.** It does not know what a kit is, what a piece is, or that a DSL
exists. Its clients hand it gcode and say what it needs; gamebox is one such client and has no
special standing. This is deliberate - the queue is useful for printing that has nothing to do with
board game inserts, and that is the reason it is separate rather than a part of the print pipeline.

It was written inside gamebox, where getting the interface right was easier with its first client in
reach, and moved here once that was done. The boundary it was built to is now the repository
boundary: nothing here may depend on anything a client owns, and the dependency runs one way and
only one way - a client may depend on the shop.

There are three packages under the scope. `@3d-print-shop/server` is the service.
`@3d-print-shop/octoprint-sim` is a stand-in OctoPrint, which the shop needs in order to prove it
talks to a real one, and which a client may drive a window around - gamebox does. `@3d-print-shop/client`
is the contract: the wire types, an interface covering everything the API can be asked, and the HTTP
implementation of it.

**The client is where the contract lives, and the server depends on it** rather than the other way
about. There were two clients before - one inside gamebox for submitting, one inside the server for
the operator's commands - which covered different halves of the same API, duplicated the same
fetch-and-explain plumbing, and between them covered the job side not at all. Two hand-maintained
clients drift, and a copy inside a client is written against an API it can no longer see - which is
exactly what this repository being separate would have made of it.

The name is what a print shop does: it takes jobs from several customers, schedules them against the
materials it has loaded, inspects each result and reruns the ones that came out badly. Note what it
is NOT called - in 3D printing a "spool" is a reel of filament, which is what OctoPrint's
SpoolManager tracks, so nothing here is a spooler however right `/var/spool` is as a location.

## Constraints

**Runs on macOS and Linux.** Nothing platform-specific in the service, and nothing that assumes how
it is started: `launchd` and `systemd` supervise a plain long-running process differently, so it
must be one, and must not require either.

**A GUI is expected, on macOS, eventually.** That settles two things now, before either is expensive
to change. The service stays HEADLESS and the GUI is a client of it, rather than the service living
inside a desktop app - gamebox's octo-sim is the cautionary example, an Electron app with a protocol
server buried in it, reachable by tests only through a relative path into its `src`. Pulling that
server out is how `@3d-print-shop/octoprint-sim` came to exist. And
the API has to be usable from another process, which means an out-of-process interface from the
start, not in-process calls that a UI is later expected to reach around.

A UI also decides what the API must expose beyond submission: what is queued, what each job is
waiting for, what is loaded now, and the ability to cancel or defer one. `displayName` and
`metadata` exist for exactly this - they are what lets a GUI show "Player Box x4" without the queue
knowing what a piece is.

Nothing here calls for pushing updates to a client. Polling is enough to start and is far less to
get right; a live channel can be added when a GUI exists to want one.

## Where it keeps its work

`/var/spool/3d-print-shop`, on macOS and Linux alike. macOS is BSD-derived and has `/var/spool` with
the same occupants Linux does - `cups`, `postfix`, `mqueue`, `uucp` - so this is one path, not a
platform branch. `PRINT_SHOP_SPOOL` overrides it, for installs that would rather not involve root
(Homebrew keeps service state under its own prefix). The variable cannot be named for the service:
`3D_` is not a legal start for an environment variable.

Not a per-user directory. A running service's work does not belong in somebody's home, and the
service does not run as whoever submitted the job.

**The installer creates the root; the service never does.** `/var/spool/cups` is
`drwx--x--- root:_lp` - made at install time, owned by the service's user. A missing root is a
machine that was never set up, so the store refuses rather than creating one, which would put the
shop's work somewhere nobody is looking.

```
/var/spool/3d-print-shop/
  next-id                     the id counter
  running.sock                the claim on this spool, held by the shop serving it
  jobs/
    7/
      job.json                what was submitted, and nothing else
      print.gcode
  printers/
    mk4/
      printer.json            what the machine IS
      status.json             what it is DOING
```

One directory per job and one per printer. Reading the shop back is a scan, which is what makes
surviving a restart cost nothing - there is no index to keep in step with the files.

**One shop to a spool, and the kernel enforces it.** The store's numbers are only unique while one
process is handing them out: allocating an id is a read of `next-id`, an add and a write back, so
two shops would both read 7, both write 8, and both hand out 7 - the second overwriting the first
job's gcode and record with no error anywhere. `serve` claims the spool by LISTENING on a socket in
it, and a second one is refused.

A socket rather than a lock file, because the claim then belongs to the process rather than to the
filesystem: the kernel drops it when the process ends, however it ends, so a crash leaves nothing to
reason about. The path does outlive the process, and that is the one thing to tidy - but nobody
answering on it is what makes a leftover safe to clear away, which is a question a lock file cannot
answer about itself.

Scoped to the SPOOL rather than to the port. A second `serve` on the same port already fails to
listen; one on a different port over the same spool is the case only this catches.

## What changes, and what does not

**A job record is written once and never written again.** It says what was submitted; a job leaves
the shop when it is approved rather than being updated on the way. There is nothing in it that
moves, so there is nothing to keep in step with anything else.

**Everything that moves belongs to a printer**, because a printer is the only thing here whose state
actually changes. That is why the two halves of a printer are two files: `printer.json` is what the
operator says a machine is - its build volume, what protocol it speaks, where it answers - and
changes when the shop's machines change, which is to say almost never. `status.json` is what it is
doing, and changes constantly.

**A job's state is derived from the printers**, not stored. Held by one, it is `printing` or
`awaiting-approval` - whichever phase that printer says. Held by none, it is `queued`. Starting a
print is therefore ONE write, to the printer, and there is no second record of the same fact for it
to disagree with. Rejecting a print is the printer letting go: the job is queued again by no longer
being held, with nothing written about the job at all.

**The count of how many times a job has run is gone.** It was the one thing about a job that
changed, and nothing scheduled on it. Something that wants to say "this is the third attempt" needs
a history of finished prints, which is a different feature from a queue of outstanding work.

**The API key is not in either file.** A key an operator types when adding a printer is a key in
shell history and in `ps`, and the spool is a working directory rather than a credential store - so
it is named after the printer and read from the environment: `PRINT_SHOP_KEY_MK4`, the way
`PRINT_SHOP_SPOOL` names the spool. A printer whose key is missing stops, with that as its reason.

**Ids are a persisted counter, never reused.** `7` is what an operator types and what a GUI shows,
and the same counter supplies the `Job N` display name for a client that offered none. An id is
spent even when the submission it was issued for fails: a number that once named a job must never
come to name a different one.

## The life of a job

```
submitted --> queued --> printing --> awaiting-approval --approved--> (gone)
                ^          (a printer holds it)      |  --abandoned-> (gone)
                +--------- rejected ------------------+   (the printer lets go)
```

**A finished print is not a finished job.** 3D printing fails often enough that the printer saying
`PrintDone` means only that it ran to the end, not that what came off the bed is usable. So every
ending - finished, failed or cancelled - waits for a person, and the printer's own outcome is
recorded but is not a verdict.

**The gcode survives until the verdict**, because a rejected print is run again from the same file.
Approval is what discards it, and the whole job goes with it: this holds outstanding work, not a
history of work done. Nothing accumulates and there is nothing to prune.

**A verdict is also what frees the printer.** The machine stops being busy when the print ends, but
the part is still on the bed until a person has looked at it - and somebody looking at it is exactly
what approving or rejecting means. So a printer goes on holding a job, and its bed, until the
verdict arrives. It is the only evidence the shop gets that the bed was cleared.

**Abandoning is the third verdict**, meaning "do not reprint, but it was not a success". What it
does to the shop is what approving does - the printer lets go, and the job and its gcode are gone -
and the difference is only in what the operator meant by it. The shop cannot tell them apart
afterwards, because telling them apart afterwards is a history of work done, which this does not
keep.

**Nothing incomplete is ever visible.** The gcode is streamed to a scratch name and renamed; the
record is written last and atomically. A submission that fails or delivers nothing takes its whole
directory with it, so there is no half-finished state for anything to reap later.

## What a job is

```ts
submit(details, gcode: Readable)

{
  filaments: string[],                  // what must be loaded before it can print
  displayName?: string,                 // what a human should see
  remotePath?: string,                  // where to push it on the printer
  printer?: string,                     // which printer, when there is more than one
  metadata?: Record<string, unknown>,   // carried, never interpreted
}
```

**The gcode arrives as a stream, beside the description rather than inside it.** A kit's gcode runs
to tens of megabytes; holding one in memory in order to describe it is backwards, and an HTTP
request body is already a stream. Describing a job and delivering it are different things.

The stream goes INTO the store rather than the store handing back somewhere to write. Handing out a
path would leak the layout and, worse, create a half-written job that nobody owns - needing a reaper
and a policy for how long to wait. Taking the stream means a failed delivery is a rejected promise
and a directory that deletes itself.

That it is really streamed rather than buffered is checked at SIZE, in
`tests/acceptance/jobLifetime.test.ts` - every unit test here uses a few bytes, and none of them
would notice a stream being held whole or truncated. That test takes one job all the way through
instead: submitted, printed, rejected, restarted, reprinted, approved, gone.

**A job may say how much room it needs**, and the shop matches it against each printer's build
volume - axis for axis, with no rotation. Gcode carries absolute coordinates, so a job needing
210x250 does not fit a 250x210 bed by being turned; turning it would mean slicing it again, and the
shop has no slicer. A job that states no volume fits anything.

**A job no printer could take is refused on the way in**, not left to sit. Too big for every
machine, or naming a printer that is not here, will never print - and a client told at submission
can do something about it where one whose job silently starves cannot. The refusal says which of
those it was and what the shop actually has:

```
no printer called ender - this shop has mk4, mini
nothing here has room for 100x100x400mm - mk4 250x210x220mm, mini 180x180x180mm
this shop has no printers - the operator adds one before anything can be printed
```

A shop with no printers accepts nothing. That reads harshly and is honest: nothing can print.

**`filaments` are the printer's names for materials, not a client's.** The first is what has to be
loaded; see "One extruder, for now". gamebox resolves `gray` to
`PLA-SpaceGray` before submitting, because that mapping is an input to its slicing. The queue never
sees a client's own vocabulary.

**`displayName` is optional, and the queue names what it is not given** - `Job 1`, `Job 2`, in
submission order. This is a label for a human, not an identity: the queue issues its own id, and two
jobs may legitimately share a display name.

**`remotePath` is where the job should be pushed on the printer.** Absent, the queue chooses. It is
here because a client often has a better idea of how prints should be organised on the far side than
the queue does.

**`metadata` is carried and never read.** It is how a client keeps its own meaning attached to a job
- gamebox puts the pieces and copy counts here, so a queue UI can show "Player Box x4" rather than a
filename - without the queue growing a concept of pieces.

## The API

REST over HTTP, and no alternative is interesting here: the service is out-of-process by constraint,
polling is the update model, an HTTP request body is already the stream a gcode wants, and a GUI,
gamebox and curl all speak it without acquiring anything to do so.

```
POST   /jobs                    submit
GET    /jobs                    what is queued, and what each is waiting for
GET    /jobs/{id}
PUT    /jobs/{id}/verdict       approved | rejected | abandoned
GET    /printers
POST   /printers                add one, or change what the shop knows about one already here
DELETE /printers/{name}
PUT    /printers/{name}/status  stopped, with a reason, or running
PUT    /printers/{name}/filament  what is loaded on it now, in extruder order
POST   /shutdown                asks the shop to stop
```

Every one of these is on `Shop` in `@3d-print-shop/client`, and `HttpShop` is what speaks them. A
caller that reaches for `fetch` is a caller working around the contract.

`shutdown` is the one ACTION here, where a verdict is a resource. A verdict is a property of a job
that outlives the request and can be read back; this ends the process and leaves nothing to ask
about. It is answered 202 and acted on once the answer has gone, because a shop that has stopped
cannot report that it stopped - and it is deliberately not treated as a change worth looking for
work over, since starting a print on the way out is the one thing it must not do.

`filament` is the operator's word for what is on the machine, because no printer here reports its
own - see "Not designed around a printer that answers". It is also the moment what the shop can
print changes, which is why it is a route rather than a file somebody edits.

**What that list leaves out is the whole printing loop.** `startPrinting`, `couldNotStart`,
`finishedPrinting`, `nextToPrint` and the gcode itself have one caller each, all of them
`startNextPrint` inside the service, and they are the loop's own bookkeeping rather than anything a client decides.
Publishing them would invite a second writer into a store built for one, and would hand out states
no client is in a position to set honestly - only the loop knows whether a printer took a job.

**A verdict is a resource, not an action.** `PUT /jobs/7/verdict` carrying `approved`, `rejected` or
`abandoned`, rather than `POST /jobs/7/approve`. The third of them arrived as another value on the
same route rather than a third endpoint, and a verdict on a job that has not finished printing
is a 409 on the one thing being set rather than an unexplained failure of a verb. A printer's
`stop` and `start` are the same shape, which is why they are a status to be set and not two routes.

**Submission is multipart, description first.** A description and a gcode in one request, because
the alternative - create the job, then upload to it - leaves a half-written job nobody owns, which
is the thing "Nothing incomplete is ever visible" exists to prevent. The order is part of the
contract: `submit()` validates the description, and refuses a job no printer could take, before it
reads a byte of gcode, so description-first is what lets a bad submission be answered without
first receiving tens of megabytes in order to answer it. The other order is a 400, not a tolerance -
tolerating it means buffering.

**Express, with busboy on the one route that carries a body it must not hold.** Eight routes is
little enough to hand-roll, but hand-rolling means owning routing, path parameters, JSON parsing and
405s, all of which then need tests of their own. busboy rather than multer for the multipart route:
multer lands the file in memory or a temp file first, where busboy hands over the part as a stream
that can go straight into `JobStore.submit`, which is the reason the store takes a `Readable` at
all.

**A client meets the same trap from the other side.** `OctoPrint`'s upload reads the gcode whole
because `FormData` wants a `Blob` and a `Blob` wants its bytes. A client submitting a plate has a
way out that the shop does not: its gcode is a file, and `openAsBlob` answers with a `Blob` backed
by that file, which `fetch` streams.

## Who may ask, and what is theirs

**Every route names its caller.** There is no anonymous mode, not even on loopback. A shop that
answers an unnamed request is one where a job has no submitter to belong to, and ownership below
would need a case for it - so the case is removed rather than handled. A shop with no callers
configured refuses to start, and a fresh machine gets its first admin from a bootstrap command
rather than from a gap in the checking.

A token buys a name and a role, and the role is AUTHORITY rather than occupation: a script can be an
admin and a person a user. Authority alone was never enough, though, because it says what a caller
may DO and never what is THEIRS.

**A job belongs to the caller who submitted it.** The owner is written with the record, at
submission, and like the rest of the record is never rewritten - so what is written is the caller's
STABLE ID, never their name. A name is what an operator typed and may one day retype, and a record
that cannot be rewritten cannot follow it: every job that person owned would quietly stop being
theirs. An identity therefore has an id that is neither its display name nor any credential it
holds. From it:

- the owner, or any admin, reads a job's details
- the OWNER ALONE renders its verdict. Judging a plate is saying whether the thing you asked for
  came out the way you wanted, which is a question only the person who asked it can answer - an
  admin can see the job and still have no idea whether that warp matters
- every other caller learns only how many jobs the shop holds, as a bare total. Enough to see that
  the queue is busy, and nothing about whose work it is

The cost is deliberate and worth writing down: a job whose owner is gone has nobody who may judge
it, and it holds its printer until something is done about that.

## The operator's commands

```
3d-print-shop serve --spool /var/spool/3d-print-shop     run the shop, so clients can reach it
3d-print-shop serve --listen 0.0.0.0                     ... from off this machine, which is a decision
3d-print-shop printer add mk4 250x210x220 http://octopi.local
3d-print-shop printer list                              what it has, and what each is doing
3d-print-shop printer load mk4 PLA-Red                  what is on the machine now
3d-print-shop printer remove mini
3d-print-shop printer stop mk4 "door is open"
3d-print-shop printer start mk4
3d-print-shop job list                                  what it holds, and where each has got to
3d-print-shop job approve 7                             the print is good - the job leaves the shop
3d-print-shop job reject 7                              not usable - print it again from the same gcode
3d-print-shop shutdown                                  ask it to stop
```

**The verdict commands are not a convenience.** A printer holds its bed until a person has judged
what came off it, so a shop with no way to give a verdict prints one thing per machine and then
stops.

**Loopback is the default because nothing is authenticated.** Every route the shop answers is open
to whoever reaches the port, so until there is a token the interface it binds IS the access control -
and the one that costs nothing is the one where there is no network to reach it over. `--listen` is
how an operator takes that off, in one place, having been told what it is for.

`add` takes an address and no key, deliberately: see "What changes, and what does not".

Only `serve` names a spool, because only `serve` holds one. Every `printer` command is a client of a
running shop and takes `--shop-url` instead (or `PRINT_SHOP_URL`, defaulting to this machine).

`start` matters as much as `add`: the shop stops a printer by itself when an upload fails, and
nothing else starts one again. Without it a shop that lost its printer for a moment would stay
stopped for good.

Each printer command is a function answering with LINES rather than printing, so the operator's half of the
shop can be tested without a process and is not stuck behind stdout when an API or a GUI wants it.
The command line only turns argv into a call.

**They go through the API**, like every other client. They used to write the spool directly, which
made the command line a second writer over files the service was writing at the same instant - a
`stop` landing at the same time as an `add` could lose one. Going through the one door also means an
operator can mind a shop running on another machine, which reaching into a directory could never do.

What they answer with is the shop's own words. This end knows only that something was refused; the
far end is what knows a printer is not here, or is holding work it cannot be taken away from.

## What to print next

Derived on every ask, never stored. What can print depends on what is loaded RIGHT NOW, which
changes while the shop is running, so an order decided when a job arrived would be stale before it
was used.

A job is printable when **every** filament it needs is loaded - not one of them. Among those, the
one submitted first: ids are submission order, and nothing here knows enough to be cleverer.

A job that names a printer goes on that one only; a job that names none will go on any. Asking
without naming a printer therefore gets only the unclaimed jobs, because handing over work earmarked
for another machine on the strength of the caller not saying who it was would be worse than
answering with nothing.

**What should I load next** is the other half, and the more useful one: everything queued, grouped
by what it needs, busiest first. Ranking by job COUNT is admittedly the wrong measure - four quick
jobs outrank one long one, where "load red, it is six hours of work" is the answer an operator
actually wants. A job carries no duration yet. When one is added it has to be a field of its own and
not the `metadata` bag, because ranking by something inside metadata would break the promise never
to interpret it.

## Sending a job to a printer

**Every printer has a name, and the operator adds it.** There is no anonymous printer: a shop that
cannot name a machine cannot stop it, report on it, or send work to it on purpose. A printer is
registered with a name and a build volume, and whether it is stopped is a property of that
registration rather than of the shop.

A printer is also a port - the thing that actually talks to a machine - keyed on the path a job is
pushed to rather than on a job, so it knows nothing of the shop's model. OctoPrint already
identifies a job by its path, so there is no separate handle to invent. A job that names no path is
given one built from its id: ids are unique and safe in a path, display names are neither.

`startNextPrint` is given a printer's NAME and looks it up, rather than being handed a registration. A
registration is a snapshot, and whether a printer is stopped changes while the shop runs - including
inside that call, which stops one when an upload fails.

```ts
send(remotePath, gcode: Readable)     // answers once the printer has taken it
awaitOutcome(remotePath)              // answers when the print stops, however it stops
```

**Starting a print and hearing how it ended are two things.** `startNextPrint` answers as soon as
the machine has taken the file. A print runs for hours, and waiting for it would make its outcome
something only a live stack frame knows - lost to a restart, and impossible to ask about. What the
printer is holding is written down instead, and `recordOutcome` watches it from there: after a
restart, a printer whose status says it is printing is a print still worth watching.

**One job at a time, not a loop.** Between prints somebody has to clear a bed - and the verdict is
how the shop finds out that happened, which is why a printer holds its job until then.

**What decides that now is the moment to start something is every change.** The foreman is told
after each one - a job submitted, a verdict given, filament loaded, a printer resumed or added, and
starting up - rather than from the handful of places that obviously matter. A curated list of
triggers is a list somebody forgets to add to, and a missed wake-up is a job that sits queued for
ever; the cost of a wasted look is one directory scan. In the API that is one middleware over every
request that changed something, not a call in each route that happens to change something.

Looks are serialised, because two at once would both find the same printer free and the file would
go to the machine twice before the store refused the second start. And a printer holding anything is
skipped before a client is built for it: there is no point connecting to a machine with nothing to
do.

**One client per printer, kept and connected on creation.** `awaitOutcome` resolves on the socket
its own client holds open, so a watcher handed a fresh client would wait on a machine nobody was
listening to. Connecting lazily on first send fails for the same reason in reverse: after a restart
the first thing that happens to a printer already printing is being watched, and nothing sends it
anything.

**A failed upload puts the job straight back.** The printer never took it, so nothing was printed:
the printer lets go, and the job is queued again by no longer being held. Nothing about the job is
written, because nothing about the job changed.

**And the printer stops.** Whatever prevented one upload will prevent the next, so working down the
queue would turn one fault into one failure per job held, and the operator would have to read the
whole run to learn what the first line already said. It stays stopped until somebody says the
trouble is over - a restart is not evidence of that, so the stop outlives one.

**Closing the shop lets go of its machines, in that order:** take no more requests, start nothing
more, then disconnect - which is what settles the watchers, since a client left connected reconnects
for as long as the process lives. A watcher losing its print on the way out is expected rather than
a fault, and must not stop the printer: a shop that came back up with every machine stopped, for a
fault nobody caused, would be worse than one that simply picks the print up again. `SIGTERM` and
`SIGINT` do the same thing, because that is what a supervisor sends.

A print already running is not interrupted. It is on the bed, the printer's status still says so,
and the next run picks it up - which is what `resumeWatching` is for.

**Stopped per printer, not per shop.** A machine that is unreachable has no business idling a
machine that is working. The reason and the time are recorded so an operator can see what happened
without watching it happen.

## One extruder, for now

Every printer here has one extruder, so what a job waits for is **the filament it starts with**. A
job may name more - a single head sliced for several virtual extruders swaps the rest in as it runs
- and those are carried without being scheduled on. `startsWith()` in `selection.ts` is the one
place that decides which filament matters.

This replaced a subset test: a job used to be printable only when EVERY filament it named was
loaded, and demand was grouped by the whole sorted set. That was machinery for printers this shop
does not have, and it carried a latent fault - sorting `[red, blue]` to match `[blue, red]` treats
two different arrangements as one.

Which is the thing to remember when a second extruder appears: filaments are **positional**, the
index being the extruder the slicer assigned them to. `[red, blue]` and `[blue, red]` are different
requirements, and neither the scheduling rule nor the grouping should pretend otherwise. Until then,
one rule is worth more than an anticipated one.

## Not designed around a printer that answers

The current printer reports no filament: SpoolManager existed once and is gone. So the queue asks
the operator what is loaded and believes the answer. A printer that can report is an optimisation it
may or may not ever get, and nothing may be designed on the assumption that one exists.
