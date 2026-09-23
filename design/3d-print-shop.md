# 3D Print Shop Design

## Purpose

A service that accepts print jobs and is responsible for getting them onto a printer: holding them
until the filament they need is loaded, submitting them, and tracking what has been printed.

**It knows nothing about its clients.** It does not know what a kit is, what a piece is, or that a
DSL exists. A client hands it gcode and says what it needs; the one it was written for is no
exception and has no special standing. This is deliberate - the queue is useful for printing that has nothing to do with
board game inserts, and that is the reason it is separate rather than a part of the print pipeline.

It was written inside its first client, where getting the interface right was easier with a caller
in reach, and moved here once that was done. The boundary it was built to is now the repository
boundary: nothing here may depend on anything a client owns, and the dependency runs one way and
only one way - a client may depend on the shop.

There are three packages under the scope. `@3d-print-shop/server` is the service.
`@3d-print-shop/octoprint-sim` is a stand-in OctoPrint, which the shop needs in order to prove it
talks to a real one, and which a client may drive a window around. `@3d-print-shop/client`
is the contract: the wire types, an interface covering everything the API can be asked, and the HTTP
implementation of it.

**The client is where the contract lives, and the server depends on it** rather than the other way
about. There were two clients before - one inside the calling application for submitting, one in the
server for the operator's commands - which covered different halves of the same API, duplicated the
same fetch-and-explain plumbing, and between them covered the job side not at all. Two hand-kept
clients drift, and a copy inside a client is written against an API it can no longer see - which is
exactly what this repository being separate would have made of it.

The name is what a print shop does: it takes jobs from several customers, schedules them against the
materials it has loaded, inspects each result and reruns the ones that came out badly. Note what it
is NOT called - in 3D printing a "spool" is a reel of filament, which is what OctoPrint's
SpoolManager tracks, so nothing here is a spooler however right `/var/spool` is as a location. The
directory it keeps everything in is its DATA, for that reason: `--data`, `PRINT_SHOP_DATA`, and a
word that means one thing in a workshop where the other kind of spool is something you load.

## Constraints

**Runs on macOS and Linux.** Nothing platform-specific in the service, and nothing that assumes how
it is started: `launchd` and `systemd` supervise a plain long-running process differently, so it
must be one, and must not require either.

**A GUI is expected, on macOS, eventually.** That settles two things now, before either is expensive
to change. The service stays HEADLESS and the GUI is a client of it, rather than the service living
inside a desktop app - the cautionary example is an octo-sim that WAS a desktop app, an Electron
app with a protocol server buried in it, reachable by tests only through a relative path into its
`src`. Pulling that
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

**Three kinds of thing, and a system has somewhere for each.** Work waiting to be done, state that
has to outlive a restart, and a claim that must not. On Linux that is three directories and the
filesystem standard says which: `/var/spool/3d-print-shop/jobs`, `/var/lib/3d-print-shop`,
`/var/run/3d-print-shop`. On macOS there is no `/var/lib` and no convention for splitting a daemon's
files, so work and state live together under `/Library/Application Support/3d-print-shop` - and the
claim is under `/var/run` on both, because that is the one directory a reboot is meant to empty and
both platforms have it.

**The store is handed the three and works out none of them.** `DataLayout` is three paths; the one
function that knows a Linux from a Mac is `systemLayout`, called once at the edge. That is what keeps
the platform out of the middle of the store - and it produces different SHAPES rather than one
formula with a different prefix, which a single root could not have done.

`--data <path>` puts all three under one directory instead, which is what somebody who names a place
is asking for: a checkout, a Homebrew prefix that would rather not involve root, a test.
`PRINT_SHOP_DATA` says the same from the environment. The variable cannot be named for the service:
`3D_` is not a legal start for an environment variable.

Not a per-user directory. A running service's work does not belong in somebody's home, and the
service does not run as whoever submitted the job - which is also why `~/Library/Application Support`
is wrong here however right it is for an app: the daemon runs as a user whose home is `/var/empty`.

**The installer creates the first two; the service never does.** `/var/spool/cups` is
`drwx--x--- root:_lp` - made at install time, owned by the service's user. A missing one is a machine
that was never set up, so the store refuses rather than creating one, which would put the shop's work
somewhere nobody is looking.

**The runtime directory is the exception, and the exception proves the rule.** It lives where a boot
empties it, so nothing that made it at install time would still be there - the shop makes it itself,
every start, and `claimData` is what does it.

**And `ready()` refuses one somebody else could write.** The shop puts 0700 on every directory it
creates and 0600 on every file, and none of that survives a parent out of which a whole job directory
can be renamed away or a new one put in its place - so the one mode the installer sets is the one the
shop cannot set for itself, and the only one worth checking. Write, and deliberately not read: a
directory others may read gives up the ids of the jobs held and no more, and refusing that would stop
a shop installed 0750 for an operators' group. `/var/spool/cups` is `drwx--x---` for the same reason.

What each of them holds, on a Linux:

```
/var/spool/3d-print-shop/jobs/
  7/
    job.json                what was submitted, and nothing else
    print.gcode
/var/lib/3d-print-shop/
  next-id                   the id counter
  printers/
    mk4/
      printer.json          what the machine IS
      status.json           what it is DOING
  sessions.json             who is logged in, by the digest of what they hold
/var/run/3d-print-shop/
  running.sock              the claim, held by the shop serving it
```

**One shop to a set of directories, and the kernel enforces it.** The store's numbers are only unique while one
process is handing them out: allocating an id is a read of `next-id`, an add and a write back, so
two shops would both read 7, both write 8, and both hand out 7 - the second overwriting the first
job's gcode and record with no error anywhere. `serve` claims them by LISTENING on a socket in its runtime directory in
it, and a second one is refused.

A socket rather than a lock file, because the claim then belongs to the process rather than to the
filesystem: the kernel drops it when the process ends, however it ends, so a crash leaves nothing to
reason about. The path does outlive the process, and that is the one thing to tidy - but nobody
answering on it is what makes a leftover safe to clear away, which is a question a lock file cannot
answer about itself.

Scoped to the SPOOL rather than to the port. A second `serve` on the same port already fails to
listen; one on a different port over the same directory is the case only this catches.

## What changes, and what does not

**A job record is written at submission and changed by one thing only: a person renaming the job.**
It says what the job is; a job leaves the shop when it is approved rather than being updated on the
way. Nothing in it is derived from, scheduled on, or copied elsewhere - so there is no second version
of any of it, and nothing to keep in step with anything else. That, rather than the writing-once, was
always what the rule was protecting: a name is a label, and rewriting a label creates no disagreement
because nothing else ever held a copy of it.

**A person pausing a job is not in the record**, because that is not what a job IS - it is somebody
intervening in when it may run. It lives in `statusOverride.json` beside the record, holding when the
pause was put on and nothing else. In particular it does not hold the job's STATE, which is derived
below and deliberately stored nowhere; a file that held both would be the second disagreeing copy
this design spends its effort avoiding.

A pause is enforced twice, and the second one is the guard rather than the manners. `printableNow`
declines to offer a paused job, which is what stops one being picked up; `startPrinting` refuses one
outright, because the scheduler decides at one moment and a print begins at another, and a pause can
land in between.

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

**What a printer would RENAME is refused, and that list was measured rather than read.** The stored
path is what a completion event is matched against, so a name the machine alters is a print whose
outcome never arrives and a bed held for ever. Against a real OctoPrint (1.11.8), one character at a
time: `&`, `;` and `$` are taken out of a name silently - `a&b.gcode` is stored as `ab.gcode` - and
everything else the shop allows comes back verbatim, including `#`, brackets, an apostrophe and a
space. A non-ASCII name is NOT transliterated, which the API docs had implied it would be; `ü`, `ß`
and an emoji all survived, so there is no rule against them.

**The API key is not in either file.** A key an operator types when adding a printer is a key in
shell history and in `ps`, and the data directory is a working one rather than a credential store - so
it is kept apart, in `/etc/3d-print-shop/printer-keys.json`, keyed by the printer's own name. A
printer whose key is missing stops, with that as its reason.

It was an environment variable, `PRINT_SHOP_KEY_MK4`, until it had to go into a `launchd` plist -
which anybody can read, so the protection was gone while everything still worked. A file is the
boring answer because a file has a mode: the shop refuses to read this one, or `callers.json`,
unless nobody but its owner can. And it is a SECOND file rather than more of the first deliberately,
because those tokens let somebody into the SHOP while these keys let somebody into the PRINTERS,
bypassing it - so copying what a client machine needs must not hand over what it does not.

**And the shop will write one, which is the one thing it writes into `/etc`.** `POST /printers`
takes the key beside the record - one call, because adding a machine is one act and two would let a
printer land without the key it is reached by - and puts it where the shop already reads them, then
uses it from that moment: a machine added from a browser can be printed on without anybody editing a
file or signalling anything. The key is read out of the body and never joins the record, which is
built from the four fields a printer IS, so it cannot follow one into the data directory.
That is a real change of posture, and worth saying plainly: `/etc` was somewhere the running shop
only ever read. What it does NOT change is the rule that put the key there in the first place - the
file is still 0600, still apart from the printer's record, still never in shell history or in `ps` or
in a world-readable plist, and the shop's own write leaves it the mode it demands of one. The typing
moves from a text editor to a form, and a form is neither of the things that rule was about.

It is write-only. A key opens the machine directly, so a caller may replace one and never ask what it
is: the route answers with the PRINTER, whose trouble is the thing they are actually waiting to see
clear. And a key that arrives this way reaches the log's redactor in the same breath it reaches the
file, because the process that wrote it is the process holding the list of what may never be printed.

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
  estimatedPrintSeconds?: number,       // how long the slicer thought, if the client knows
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
loaded; see "One extruder, for now". A client resolves its own `gray` to
`PLA-SpaceGray` before submitting, because that mapping is an input to its slicing. The queue never
sees a client's own vocabulary.

**`displayName` is optional, and the queue names what it is not given** - `Job 1`, `Job 2`, in
submission order. This is a label for a human, not an identity: the queue issues its own id, and two
jobs may legitimately share a display name.

**`remotePath` is where the job should be pushed on the printer.** Absent, the queue chooses. It is
here because a client often has a better idea of how prints should be organised on the far side than
the queue does.

**`metadata` is carried and never read.** It is how a client keeps its own meaning attached to a job
- a client puts its pieces and copy counts here, so a queue UI can show "Player Box x4" rather than
a filename - without the queue growing a concept of pieces.

## The API

REST over HTTP, and no alternative is interesting here: the service is out-of-process by constraint,
polling is the update model, an HTTP request body is already the stream a gcode wants, and a GUI,
a script and curl all speak it without acquiring anything to do so.

```
POST   /jobs                    submit
GET    /jobs                    what this caller may see, and how many there are altogether
GET    /jobs/{id}
GET    /jobs/{id}/picture       what it looks like - the slicer's embedded image, or a render
PUT    /jobs/{id}/verdict       approved | rejected | abandoned
GET    /filaments[?printer=]    what the queued work is waiting for, busiest first
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

**A job's picture is a picture, never its gcode.** A page listing jobs would otherwise pull every
plate whole, up to `maxGcodeBytes` apiece, to show a thumbnail. The shop serves the largest PNG or
JPG the slicer embedded in the head of the file, as written. Otherwise it renders a PNG itself: every
extrusion move as a lit tube of plastic, isometric, drawn into a depth buffer so nearer beads hide
further ones - what a slicer's own preview does, with no image library to depend on. Beads are
sampled once a plate passes a fixed number of them, so a large plate costs no more than that. A
render is kept in the job's directory the first time it is drawn, under the version of the drawing
that made it, and served from there after that - the gcode never changes, so it cannot fall out of
step, and a new drawing names a new version. An embedded picture is not kept: it is read from the
head of the file for almost nothing.

**`GET /jobs` answers one object, not a list.** `{ accessibleJobs, totalJobs }` - what this caller
may see, and how many the shop holds whoever owns them. A list and a count asked for separately are
two snapshots: a submission landing between them gives a GUI three jobs and a total of two, and
polling is the update model here, so that pair would be asked over and over. There is also no clean
second route for it - `GET /jobs/count` collides with `GET /jobs/{id}`.

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
configured refuses to start, and a fresh machine gets its first admin from `init` - which writes the
file 0600 with one admin in it, says their token once, and refuses to write over callers already
there - rather than from a gap in the checking.

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
- the owner renders its verdict, and so may an admin. Judging a plate is saying whether the thing
  you asked for came out the way you wanted, which is a question only the person who asked it can
  really answer - an admin can see the job and still have no idea whether that warp matters. But an
  owner can be revoked, and a job nobody may judge holds a printer's bed for good, so an admin is
  how one gets unstuck. Both halves are true: the owner is the only one who KNOWS, and an admin is
  the only one who can always act
- every other caller learns only how many jobs the shop holds, as a bare total. Enough to see that
  the queue is busy, and nothing about whose work it is

**An owner is revoked by an absence, not by an act.** Their entry leaves `callers.json` and the id
it carried is nobody's; the jobs that recorded it are simply owned by somebody who is not here. The
id is not spent by that, so putting the same id back makes them theirs again - which is the whole
reason an identity's id is neither its name nor its token. Rotating a credential orphans nothing.

**And it takes effect on SIGHUP, not on a restart.** Adding or revoking a caller is editing the file
the shop already reads, and the signal is what tells it to read it again - which is what a
long-running service is told with, and what keeps rotating a token from meaning losing sight of
every print the shop is watching. Everything in that directory is re-read, each file on its own, so
one somebody has just broken does not hold up another they have just put right.

A re-read it cannot make sense of leaves the callers exactly as they were, and says why. The other
answer - no readable file, therefore nobody may call - revokes every caller at once over a stray
comma, including the operator who would then have to get back in to fix it. That is the opposite of
the rule at STARTUP, where an unreadable file stops the shop: there, nothing is running yet and
refusing costs nothing, while here a shop is already holding work.

**A printer's key is the harder half, and what makes it safe is where a key is USED.** A key is held
by a client that is connected to a machine, and replacing that client disconnects it - which, if a
watcher were waiting on the socket it holds, would take the print it was watching. So the signal
touches no client at all. It replaces the keys the shop holds, and the comparison happens where a
machine is reached: a client is kept while its address AND its key are what the files now say, and
built afresh when either has changed. Reaching a machine is done to start a print on it and to pick
one up to watch, and a printer that is holding something is never started on - so a new key defers
itself until the machine is idle, and nothing in that cache has to know what is being watched.

That leaves one asymmetry worth naming: a keys file that is GONE is read as no keys, the same as it
means on a fresh install, where a missing callers file is a refusal. The machines go out of reach
until it is back, which is visible, reversible, and stops nothing that is already printing.

**Who is logged in is written down, so a restart is not everybody logging in again.** A shop is
restarted by an update at 2am, and sessions held only in memory made that a wall display asking to
be logged in to in the morning. They go in the shop's STATE, in a file of their own - not in
`callers.json`, which is a file a person hand-edits, and not among the jobs, which is one directory
per job and read by a scan of it. What is written is what the shop already holds: the DIGEST of each
session's secret, whose it is, when it began, and roughly when it was last used. That is what makes
the file safe to have at all - a stolen copy says who was logged in and when, which is worth 0600,
and cannot be turned back into a cookie anybody can present.

It is written the way everything else here is written, beside and renamed over, so a crash part way
through leaves the old file rather than half of a new one. It is not waited for by anything
answering a request: a session that outlives a restart is worth less than a login that waits on a
disk, and a write that fails costs the surviving, not the session. Being seen is written at most
every few minutes rather than on every request - the cost of that is an idle clock a few minutes
stale after a restart, and the alternative, leaving it out, is worse than it looks: a session in
constant use would come back looking untouched since it began and be thrown away as idle.

Reading it is the one place that is loud. The file is refused rather than read as far as it goes, and
what to do about that is the shop's to decide and not the file's: it starts, because jobs waiting to
be printed matter more than a login, and it says in its log that everybody has to log in again and
why. Everybody logging in again IS the safe direction; doing it silently is how a shop logs everybody
out every morning with nobody knowing what changed.

**A changed password ends the sessions it let in.** `caller password` promises that; without this it
was not true, because the id still existed and every browser already logged in as that person went
on being them - which is the one place a stolen password was certain to keep working. So the re-read
compares each caller's password hash with the one the shop was holding, and where it changed, that
caller's sessions end. Somebody either forgot theirs or believes somebody else has it; in both cases
every browser logged in as them is one that should not be.

The cost is deliberate and worth writing down: an admin may judge work that is not theirs, and
afterwards nothing says they did. Approval discards the job, the shop keeps no history, and the
verdict leaves no record of whose it was. That is the price of never holding a bed for a job nobody
is left to judge, and it is an argument for the logging in PLAN.md rather than for a field on a
record that is written once.

## What it writes down

The shop runs unattended for hours. Until it had this, the only durable evidence of anything was the
sentence in `printer.paused.reason` - which says nothing about the prints that went well, nothing
about the order things happened in, and nothing at all once a job has left.

**One line of text per event, to stdout:** `<when> <level> <message>`, then whatever the line was
about as `key=value` pairs. `launchd` and `systemd` both capture stdout, so that is a log the shop
does not have to open, rotate, or lose; a file it managed itself would be a second thing to get right
on every machine.

Text rather than JSON, because the first reader of this is a person with a terminal and a wall of
objects is not a log anybody skims. The date leads so a run sorts and greps by time, the two levels
are the same width so it reads down the page as columns, and only a value that would run into the
next one is quoted.

**Two levels, not five.** `INFO` is what an operator needs to know happened; `ERROR` is why something
did not work. The two words everybody already knows, rather than a private vocabulary somebody has to
learn before they can grep. Eight hours of a running shop has to be readable in one pass, and every level past
those two is a decision at each call site that somebody eventually gets wrong.

**A port the CLI supplies**, injected the way `Machines` is, and defaulting to a silent one. A unit
test is then quiet without saying so, and where the lines go stays the operator's business rather
than being `console` decided in the middle of the store.

**The API edge and the printing loop, not the store.** The edge is where a caller's intent is known -
who asked, for what, and what they were told - and it hangs off the same `response.on('finish')` seam
that already tells the foreman something changed. The loop is where the machine's story is known:
what started, how much gcode went over, how the print ended, why a printer was stopped, and what was
picked up again after a restart. The store is left alone; it has no caller and no machine, and
logging from it would say the same things twice.

**This is where history is allowed to live.** The store keeps none by design - a job leaves the shop
when it is approved - so the line saying job 7 was approved, by whom, and whose it was, is the only
thing that will ever be able to answer what happened to it. A log is not a second writer, which is
why this does not break the one-writer rule.

**A secret is never written, and the rule is at the SINK.** The way a printer's key or a caller's
token reaches a log is not that somebody logged it: it is that a failure carried it, in a path, a
header, or a stack. So the sink is built knowing every secret this process holds and refuses to
write any of them, rather than each call site remembering - one place to get right, and a new call
site cannot forget it.

The command line's own output is a different thing on the same stream. `say()` is the COMMAND
answering the person who typed it, and the log is the running SERVICE's record. That is also why the
`listening on <address>:<port>` line keeps its shape: two test suites read the port back out of it.

## The operator's commands

```
3d-print-shop init dave                                  the first admin, on a machine with none
3d-print-shop serve --data /var/spool/3d-print-shop      run the shop, so clients can reach it
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

**Loopback is the default even though every route is authenticated.** A token travels in the clear
over HTTP, so the interface the shop binds is still worth something: the one that costs nothing is
the one with no network to read a token off. `--listen` is how an operator takes that off, in one
place, having been told what it is for.

`add` takes an address and no key, deliberately: see "What changes, and what does not".

Only `serve` names a data directory, because only `serve` holds one. Every `printer` command is a client of a
running shop and takes `--shop-url` instead (or `PRINT_SHOP_URL`, defaulting to this machine).

`start` matters as much as `add`: the shop stops a printer by itself when an upload fails, and
nothing else starts one again. Without it a shop that lost its printer for a moment would stay
stopped for good.

Each printer command is a function answering with LINES rather than printing, so the operator's half of the
shop can be tested without a process and is not stuck behind stdout when an API or a GUI wants it.
The command line only turns argv into a call.

**They go through the API**, like every other client. They used to write the data directory directly, which
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
by what it needs, busiest first. It is `GET /filaments` - a resource of its own rather than anything
under `/jobs`, which would collide with `/jobs/{id}` and be settled by whichever route express saw
first. An admin's to ask, because it counts everybody's work, which is more than the bare total a
caller who owns none of it may learn.

Named a printer - `GET /filaments?printer=mini` - it answers for that machine instead, counting only
the jobs it could take. Without one it answers for the whole shop, which is the right answer where
there is one machine and the wrong one where there are two: a job may name another printer or be too
big for this one, and an operator at the smaller machine would be told to load a filament nothing
there could use. It filters on `canTake` and deliberately NOT on what is loaded, which is the very
thing being asked about.

**It ranks by WORK where it can, and by job count where it cannot.** "Load red, it is six hours" is
the answer an operator wants, and four quick jobs should not outrank one long one - so a job may say
`estimatedPrintSeconds`, which the shop never measures and never corrects. It is a field of its own
rather than something in the `metadata` bag, because ranking by something inside metadata would break
the promise never to interpret it.

Two rules keep a half-answered queue honest. A filament's total is left out entirely where any job
waiting on it said nothing, rather than summed over the ones that did: a partial total is quietly
short, and choosing a spool by a number that understates the queue is worse than choosing by a count.
And the ranking is decided over the whole answer - one filament without a total puts every one of
them back on counting, because otherwise a single job that said how long it takes would outrank six
that did not.

**The shop will serve a page, and is told nothing about it but where it is.** `serve --page <dir>`
puts those files at the root, under the API rather than over it: a path the shop answers is the
shop's whatever a browser thinks, and everything else that is not a file gets `index.html` so a
reload works wherever somebody was. The list of the shop's own paths is the CLIENT's - `SHOP_ROUTES`
- so a route added to the contract cannot quietly start being answered with a page.

It is a directory rather than a package for one reason: the page is a CLIENT of this shop. It
reaches the API through `@3d-print-shop/client` exactly as a slicer would, and a server that
resolved the page's files through the ui package would be the server depending on one of its
clients. The dependency runs one way, and pointing it at a path is what keeps it that way.

**How the page reaches a machine.** It is a package of its own, `@3d-print-shop/ui`, and NOTHING
depends on it. The person installing names it beside the server - `npm i -g @3d-print-shop/server
@3d-print-shop/ui` - and the setup script, which ships inside the server package, finds it where npm
put it and hands the server its path. The server never learns the page exists.

It used to be a dependency of a separate installer package, which was what knew about both halves.
That package went when setting a machine up stopped being an npm postinstall hook and became a
command somebody types, and the command went into the server package. Depending on the page from
THERE would have been the server's manifest naming one of its own clients - so the page is named on
the install line instead, which also leaves room for a machine that wants the server and some other
client and no page at all.

The other two ways were weighed and cost more than they bought. Building the page into the server
gives one artifact that can never skew, and pays for it by making the server's build depend on a
client, which is the direction that may never run - the runtime rule would survive and the invariant
would not. Having the setup script fetch it keeps both packages clean and puts a network fetch into a
script that has never had one, which buys offline failures and a checksum nobody has written, in the
one tool whose whole doctrine is that it refuses rather than guesses.

What the chosen way costs is that nothing PINS the two releases together: somebody can update the
server and not the page. So drift is made visible rather than impossible. The shop answers
`GET /version` with the release it is, and the page - which knows its own, stamped in at build -
says so at the top when they differ. The check is on the page's side because that is the direction
the dependency runs: a client may know about the shop, and the shop learns nothing about the page.
It is asked on every poll, because an upgrade and restart under an open page is exactly when the two
stop matching.

And it is served without a credential, because the page nobody has logged in to yet is the page they
log in ON. There is nothing in it worth protecting - a bundle and a stylesheet - and requiring one
would be a login screen that cannot be fetched without having logged in.

**A password is the person's, and changing it is theirs to do.** `caller password` is an operator at
a terminal, which is right for setting one and wrong for the person who wants to change theirs -
until this, nobody could change their own without finding somebody with a shell on the machine, and
a password nobody can change is a password nobody ever does.

It is `PUT /me/password`, open to every caller because it can only ever change the caller making the
request: the id is taken from who the request turned out to be and never read out of the body, so
there is no shape of request that changes somebody else's. Changing another person's stays an
operator's act at the terminal and has no route at all.

The password they have NOW travels with it and is checked, even though the session already names
them. A session is a screen somebody walked away from, and a password nobody has to know to change
is a password the next person to sit down owns. That makes this the same oracle a login is -
something that says whether a guess was right - so it is counted and made to wait the same way. A
wrong one is refused 403 rather than 401: the session is perfectly good, and a client that read it
as an expired one would throw somebody off the page for mistyping.

What follows a change is every OTHER session that caller holds ending, and the one that asked being
kept. The reason for the first is the reason the SIGHUP path has it: somebody either forgot theirs or
believes somebody else has it. The reason for the second is that asking a person to log in again for
having just proved who they are is a page that punishes the safe thing.

The writing is the running shop's rather than the store's, like a printer's key - the file is written
and then read BACK into what the process holds, in that order, so what is in force is what the file
says and a restart or a re-read finds the same thing. No signal, no restart.

**The verdict is given on the page, because that is where the print was watched.** A printer holds
its bed until a person says whether what came off it is usable, and that person is standing at the
machine with the page in front of them - so a shop whose only way to say it was a terminal printed
one thing per machine and then waited for somebody to walk to a keyboard. It is offered against the
JOB rather than as a screen of its own: two machines can be waiting at once, and "approve" on its
own does not say which bed is about to be freed.

Three buttons rather than two, because the third is the one a shop cannot do without: a print that
was no good and is not worth another still has to let go of what it is holding. The middle one says
"print again" rather than "reject" - the shop's word says what a person thought of the print, and
the button has to say what happens to the job.

The page offers it on every job the shop showed the caller, and does not reason about who may give
one. Ownership is the shop's to decide and it decides it in the route; a page that worked it out
again would be a second copy of the rule, and the copy that drifts is the one in the browser.

## Sending a job to a printer

**Every printer has a name, and the operator adds it.** There is no anonymous printer: a shop that
cannot name a machine cannot stop it, report on it, or send work to it on purpose. A printer is
registered with a name and a build volume, and whether it is stopped is a property of that
registration rather than of the shop.

A printer is also a port - the thing that actually talks to a machine - keyed on the path a job is
pushed to rather than on a job, so it knows nothing of the shop's model. OctoPrint already
identifies a job by its path, so there is no separate handle to invent. A job that names no path is
given one built from its id: ids are unique and safe in a path, display names are neither.

`startNextPrint` is given a printer's NAME and looks it up, rather than being handed a registration.
A registration is a snapshot, and what a printer holds and what is written against it both change
while the shop runs - including inside that call.

**Where a machine can be WATCHED is the adapter's answer too.** A printer the shop reports carries a
`camera`, and it is derived rather than recorded: OctoPrint proxies its bundled webcam at a known
path off the same base URL the API is on, so where the camera lives is part of what the protocol
says, exactly as the upload path is. That keeps it out of `printer add`, where an operator would be
retyping something the shop already knows, and out of the shop's own vocabulary - the shop never
fetches it and has no idea what is in it. It is a URL, answered so that whoever is LOOKING at the
shop can open it, and absent for any machine whose protocol says nothing about one.

```ts
send(remotePath, gcode: Readable)     // answers with where it FILED it, once it has taken it
awaitOutcome(remotePath)              // answers when the print stops, however it stops
```

**Where the file went is the machine's answer, not the shop's guess.** `send` says where to put it
and the machine says where it put it, and those are not always the same string - OctoPrint
transliterates a name it cannot store. A completion event carries the path it filed, and the watcher
matches on that string, so a rename the shop did not follow is a print nobody hears the end of. The
answer goes on the printer's `holding`, beside everything else that moves: it cannot go on the job,
which is written once, and it is not known until the upload has been answered. A holding with no
path - a print started before the shop read that answer back, or interrupted between the upload and
the write - falls back to the path the shop asked for, which is what it did for every print before.

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

**And the printer takes nothing more.** Whatever prevented one upload will prevent the next, so
working down the queue would turn one fault into one failure per job held, and the operator would
have to read the whole run to learn what the first line already said. Which fact is written depends
on whether the machine answered - see `What state a printer is in` - and neither of them is a stop.

**Closing the shop lets go of its machines, in that order:** take no more requests, start nothing
more, then disconnect - which is what settles the watchers, since a client left connected reconnects
for as long as the process lives. A watcher losing its print on the way out is expected rather than
a fault, and must not stop the printer: a shop that came back up with every machine stopped, for a
fault nobody caused, would be worse than one that simply picks the print up again. `SIGTERM` and
`SIGINT` do the same thing, because that is what a supervisor sends.

A print already running is not interrupted. It is on the bed, the printer's status still says so,
and the next run picks it up - which is what `resumeWatching` is for.

## A file the shop cannot read

Everything the shop holds is read back off disk, so what it does with a file it cannot parse is a
decision it has to make three times over - and the answer is different each time, because each file
leaves the shop knowing a different amount. The rule throughout is the one already there: an
unreadable file of some kind means what an ABSENT file of that kind has always meant.

**A job record** that will not parse is a job not in the list, which is what a missing one is. There
is nothing in a job record the shop could act on half of - no filament to schedule by, no owner to
answer to - so half a job is not a job.

**A printer's record** that will not parse is a printer the shop does not have, which is again what
a missing one is. It says what the machine IS: the bed a job is measured against, the address it is
reached at. Without it there is nothing to schedule against and nowhere to send anything, and a
machine the shop cannot describe is not one it can offer. `printer add` writes a fresh record and
keeps the status file, so the machine comes back holding whatever it was holding.

**A printer's status is the one that is different**, and it is the one that actually happens: the
record is written once when a printer is added, where the status is rewritten on every load, pause,
resume, start and finish. It is NOT read as an empty status, which is the trap - `holding` lives in
that file, and it is the only record that a job is on a bed. Read as nothing, a print in progress
would be queued for another machine to print as well. So the printer stays in the list, carrying a
trouble that says its own files cannot be read, and nothing is started on it.

That trouble is derived when the printer is read rather than written down, the way `camera` is -
there is nowhere to record a fact about a file that could not be read. It carries no `since` for the
same reason: the shop knows the file is bad now, not when it went bad. An operator doing anything at
all to the machine puts it right, because changing a status reads it first and a status nobody can
read is one there is nothing to keep from.

**What none of this recovers is what the machine was holding**, and that is worth saying plainly. A
job that was on that bed reads as queued and another printer may take it, so a plate can be printed
twice. Stopping that means stopping the whole shop over one bad file, which is a larger thing than
the fault - so the shop reports the machine as needing somebody, and a person is what settles it.

Said once per file rather than per read: `printers()` and `all()` are asked on every request that
touches anything, so a line each time is a log nobody can read, and being readable in one pass is
what this log is for.

## What state a printer is in

**Nothing records a printer's state as a word.** It is read from what is written down about the
machine - what is loaded, what it is holding, and what the shop has been told or has found out - and
each state below is a combination of those. A single `state` field would be a second place to be
wrong about facts the shop already has, and the facts are what it acts on.

**Idle.** Holding nothing, and free to take work: the bed is clear, and the next look starts the best
job that what is loaded can print. A printer with nothing loaded is idle too. It is not in trouble,
it simply cannot take anything until an operator says what is on it.

**Printing.** Holding a job whose phase is `printing`, with a watcher listening for how it ends. It
takes no other work, because holding anything at all means the bed is not clear.

**Waiting for a verdict.** Holding a job whose phase is `awaiting-approval`. The print has ended -
which is what the machine said, and not a judgement of what came off the bed - and the printer keeps
both the job and the bed until a person gives one. A shop nobody attends fills up in this state, one
printer at a time, and that is deliberate: between prints somebody has to clear a bed, and the
verdict is how the shop finds out that happened.

**Stopped.** `paused`, carrying the reason and the time. It takes no work whatever is loaded and
whether or not the bed is clear, and the stop outlives a restart - a restart is not evidence that
the trouble is over. An operator's word, and an operator's alone: the reason a person gives is a
fact about the room, no machine can contradict it, and only a person can say it is over. Nothing
the shop works out for itself is written here.

**Stopped per printer, not per shop.** A machine in trouble has no business idling a machine that is
working. The reason and the time are recorded so an operator can see what happened without watching
it happen. A fault of the shop's own - the store, the data directory - stops nothing: it is no printer's
fault, and stopping a machine over one names the wrong thing and leaves a person clearing a fault
that was never about the printer.

**Unreachable.** The shop could not get to the machine at all - nothing listening, a name that does
not resolve, no key for it, a key it refused, a login that handed back no session. Recorded as
`unreachable`, with what was seen and when, and deliberately **not** as `paused`: nothing about the
room changed, nobody did anything, and an operator asked to clear it would be confirming something
only the shop can see. It takes no work while it lasts, for the reason a stop does - the next
attempt fails the same way, and one fault would otherwise become one failure per job held - so what
an operator sees is a machine standing idle with the reason beside it.

**And it clears itself**, because the shop is the only one who can tell. Every one of those causes
is ended by something outside the shop - a machine switched on, a key corrected, a router fixed -
and none of them announces itself, so the shop reaches for the machine again on a backoff and lifts
the fact the moment it answers. One login a try. `printer start` lifts it too, and lifts a stop with
it: somebody who has just put a key right should not wait out a backoff to find out whether they
got it.

**Refused.** The machine answered, and would not take the file - a path it will not store, a disk
with no room, a plain no. Recorded as `refused`, with what it said and which file, and it is the one
thing the shop writes about a machine that waits for a person. Not a stop, because nobody stopped
anything - and not retried either, because the machine has already given its answer and finding out
that it still means it costs another whole plate. It stands until somebody says they have looked:
`printer start` is that sentence, and a restart is not, so it outlives one.

**Which of the two a failed upload is belongs to the port.** A send that fails because nothing is
listening, or because the machine went away part way through, is the same fact as a login that could
not be made - `CouldNotReach`, thrown by the adapter wherever it happens, and retried on the clock
at one login a try. A send the machine ANSWERED, with any reply that is not ok, is a refusal. The
whole difference is whether asking again costs a login or a plate, so the distinction lives where
the answer is: beside the `Printer` port, not in the loop above it.

**`printer start` is the one word that answers all of them.** It lifts every fact standing against
the printer - an operator's own stop, a machine out of reach, a file refused, a print nobody is
hearing - forgets whatever wait the shop had set itself, picks the print back up if there is one,
and looks for work. There is no separate word per fact, because an operator does not think in the
shop's categories: they have been to the machine, and what they are saying is try it now. That is
more than the shop can ever find out by itself, so nothing it decided on its own outranks it. It is
told apart from an ordinary change for the same reason - looking for work passes over a printer that
is holding a print, so a lost watch would otherwise wait out a backoff nobody wanted.

**Out of contact.** The shop is holding a print it can no longer hear about, recorded as
`outOfContact` with the time and what took the watch. **This is not a stop.** As far as anyone knows
the machine is fine and the print is still running; there is nothing for a person to do, and asking
one to type `printer start` to clear it would be asking them to confirm something they cannot see.
Nor does it need to idle anything: a printer holding a job takes no work already, so the stop that
used to be written here bought nothing and cost an operator a machine. The printer keeps its job for
the same reason - letting go would queue a job that is on a bed.

It is reachable from one state only. Contact is tested in exactly two places - reaching a machine in
order to start a print, which stops the printer when it fails, and watching one, which only a
printer that is printing has - so unknown always means printing, with the shop having lost the
thread. It is not a dropped packet either: the client reconnects for as long as the process lives, so
losing a watch is minutes of silence rather than a moment of it.

**And it clears itself.** The recovery is the watch: rebuild the client, listen again, and let the
machine's own status settle what happened while nobody was listening - still running that path and
the watch simply resumes, not running it and the last print's result says how it ended. It runs on
the same clock that reaches for a machine out of reach, and having the machine in hand IS contact:
that is what erases `outOfContact`, before anything has been settled about the print, because a shop
saying it cannot hear a machine it is talking to would be saying something false. A restart does the
same thing by another road: what is written says the printer is holding a print, and picking that
back up is what the shop does with one anyway.

**What each backoff does when it succeeds is not the same, and the difference is what a wasted try
costs.** Hearing a machine again starts the waiting over, because a silence after contact is a new
silence and losing a watch again costs one login. A machine merely ANSWERING does not: a client is
kept once it has connected, so answering a login costs it nothing, and the upload that follows can
fail all the same - starting over on that would put the shop back to re-sending a whole plate every
thirty seconds. That count is forgotten when a print actually starts, which is the only thing that
says the machine works.

The known cost is a word: a print CANCELLED during the outage reconciles as `failed`, because a
history records cancelled as unsuccessful and only a live event says otherwise. That is the shop
choosing a wrong word by itself rather than being told one, and it is the price of not stopping.

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
