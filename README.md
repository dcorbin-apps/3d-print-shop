# 3D Print Shop

A service that takes print jobs and gets them onto a printer: holding each one until the filament it
needs is loaded, sending it to a machine that can take it, and keeping it until a person has said
whether what came off the bed is usable.

It knows nothing about what it is printing. A client hands it a gcode file and says what filament it
needs and how much room it takes; the shop schedules on that and nothing else. No client has
special standing, including the one it was written for.

**One thing reads a plate, and it is deliberately not the shop.** Callers that cannot speak the
shop's own contract reach it through a borrowed protocol under `/octoprint`, and that face has no
field to carry what a job needs - so it reads the plate's own comments to find out. The reading
lives in the face. What reaches the store is a description like any other, and the store has no idea
where it came from. See **A protocol it borrowed** below.

See [design/3d-print-shop.md](design/3d-print-shop.md) for why it is shaped this way,
[design/testing.md](design/testing.md) for how it is tested,
[design/security.md](design/security.md) for what stops a request that is not really somebody's, and
[PLAN.md](PLAN.md) for what is still to do.

## The packages

| Package | What it is |
|---|---|
| `@3d-print-shop/server` | The service, the operator's command line, and the setup script that makes a machine ready to run it. |
| `@3d-print-shop/client` | The contract - the wire types, the `Shop` interface, and `HttpShop`, which speaks it. What a client depends on. |
| `@3d-print-shop/octoprint-sim` | A stand-in OctoPrint, enough of the real protocol to prove the shop talks to one. |
| `@3d-print-shop/ui` | A single page in a browser: what the shop is doing, the printers with their cameras, and the work grouped by what it needs loaded. |

The server depends on the client, not the other way about: the contract is one thing, written once,
so a client cannot be written against an API it can no longer see. The UI is a client like any other
and reaches the shop through the same `HttpShop` - it imports `@3d-print-shop/client/browser`, which
is the same contract without the two things only a program on a machine can do: find a token in a
file, and read an environment variable for the shop's URL.

## Running one

**macOS and Linux.** The shop is a Unix service and is built as one: the installer makes a system
user and a `launchd` or `systemd` daemon, the directories it keeps its work in are judged by their
mode, and a credential is refused if anybody but its owner can read it. None of that has a meaning
on Windows, which is not a target and is not tested.

```
yarn install
yarn build
yarn shop serve --data ./dev
```

It will not start until `/etc/3d-print-shop/callers.json` names somebody who may call it: every
route names its caller, and a shop nobody may call has nothing to answer. `3d-print-shop init dave`
writes that file with one admin in it - see **Who may call it** below.

`yarn shop` runs the server straight from source; an installed shop is the `3d-print-shop` binary
`@3d-print-shop/server` declares. Either way it is a plain long-running process, so `launchd` and
`systemd` can both supervise it, it stops on `SIGTERM`, and it re-reads its credentials on `SIGHUP`.

**It keeps three kinds of thing, and a system has somewhere for each.** Work waiting to be done,
state that has to outlive a restart, and a claim that must not:

| | Linux | macOS |
|---|---|---|
| jobs | `/var/spool/3d-print-shop/jobs` | `/Library/Application Support/3d-print-shop/jobs` |
| printers, sessions, the id counter | `/var/lib/3d-print-shop` | `/Library/Application Support/3d-print-shop/state` |
| the claim on all of it | `/var/run/3d-print-shop` | `/var/run/3d-print-shop` |

`--data <path>` puts all three under one directory instead - a checkout, a Homebrew prefix, a test -
and `PRINT_SHOP_DATA` does the same from the environment. The store is handed the three places and
works out none of them, so the only thing that knows a Linux from a Mac is one function.

**The first two are the installer's to create, not the shop's.** `/var/spool/cups` is made at install
time and owned by the service's user, and this is the same: a missing one is a machine that was never
set up, so the shop refuses to start rather than putting its work somewhere nobody is looking. The
third is the exception - it lives where a reboot empties it, so the shop makes it every time.

They must not be writable by their group or by anybody else, or the shop refuses to start: everything
below them is 0700 and 0600, and none of that stops a job directory being renamed out of a directory
others can write. Being readable is allowed - 0750 for an operators' group is a working install.

One shop to a set of directories. `serve` claims them by listening on a socket in its runtime
directory, so a second shop over the same ones is refused and a crash leaves nothing to clean up.

## Installing it as a service

```
yarn install && yarn build
sudo packages/server/install.sh
```

From a registry it is two commands, and the second one is the one that does everything:

```
sudo npm install -g @3d-print-shop/server @3d-print-shop/ui
sudo 3d-print-shop-install
```

**The install is a command somebody types, not something that happens to them.** `npm install -g`
puts two binaries on PATH - `3d-print-shop`, the operator's command line, and
`3d-print-shop-install` - and stops there. It used to run itself from a `postinstall` hook, which
was wrong twice over: npm holds stdin and swallows stdout of a dependency's postinstall, so an
install that stopped short to ask for its first admin looked like an install that did nothing; and
`--ignore-scripts`, a container build or a CI runner would each have silently got no service at all.
Run by hand the script owns its terminal, so it can ask and be heard, and nothing is copied because
npm has already put the code where the service can read it.

**The page is named, not depended on.** The server does not depend on `@3d-print-shop/ui`: the page
is a client of the shop, and the dependency runs one way. Named together they land side by side in
npm's global directory, which is where the setup script looks for the page, and it refuses without
one, naming the package to install at the server's own version.

Because nothing pins the two together, the page checks instead: it asks the shop which release it is
and says so, at the top of the page, when that is not its own. A browser still holding a page from
before an upgrade is fixed by a reload; a page package left behind by one is fixed by installing both
again together.

It needs an npm whose global directory is outside a home directory, for the same reason the node
does. That is refused with the reason rather than installed into a daemon that could never start.

It works out which machine it is on and does the same thing either way: a system user (`_printshop`
on macOS, `printshop` on Linux) that can be logged in as by nobody; the directories it keeps things
in and `/etc/3d-print-shop`, owned by it at 0700; a copy of the built shop under `/usr/local/lib/3d-print-shop`
owned by root; and a `launchd` daemon or a `systemd` unit that runs it.

The built page is copied too, and the service is pointed at it with `--page`. It is not optional:
the page is how a person uses the shop - where they log in, watch a machine and say whether what came
off the bed is any good - so an install without one is refused rather than made.

**It refuses rather than guesses.** No node outside a home directory that is new enough, no build to
install, no page built, or a shop with no callers yet: each stops it, and each says what to do about
it. The node it
looks for has to be a system one - a daemon runs as `_printshop`, which cannot read into your home
directory, so a version manager's node is no good to it (`brew install node@24`).

The shop is **copied** rather than run out of the checkout, for that same reason and one more: it
means a `git checkout` of another branch is not a live change to a running service. So after a build:

```
yarn build && sudo packages/server/install.sh update
```

**The first admin is made during the install.** It asks what to call them, and `init` - run as the
service user - asks for their password twice: at least 12 characters, which is the only rule. A
password it refuses is asked for again. The token it prints exists nowhere else, so it goes in
`~/.config/3d-print-shop/token` (0600) of whoever runs a client, on whichever machine that is. Run
where there is no terminal, the install stops short instead and prints the commands to finish by
hand.

**Printers come afterwards**, from the page, which takes each one together with the key it is
reached by. `3d-print-shop printer add` takes no key, on purpose - a key on a command line is in
shell history and in `ps` - so a printer added that way gets its key in
`/etc/3d-print-shop/printer-keys.json`, 0600 and owned by the service user, followed by a reload.

Day to day:

| | macOS | Linux |
|---|---|---|
| its log | `tail -f /var/log/3d-print-shop.log` | `journalctl -u 3d-print-shop -f` |
| after a build | `sudo packages/server/install.sh update` | same |
| after editing a credential | `sudo launchctl kill HUP system/com.dcorbin.3d-print-shop` | `sudo systemctl reload 3d-print-shop` |

`sudo packages/server/install.sh uninstall` stops it and removes the service and the installed copy. It
leaves the data, the credentials and the user alone: uninstalling a service is not the same act as
throwing away the work it was holding, and one of those cannot be undone.

## The page in a browser

```
yarn ui
```

Vite on `http://localhost:5173`, proxying the shop's own routes to `http://localhost:7373` so the
browser makes same-origin requests - the API has no CORS handling and should not grow any to suit a
dev server. `PRINT_SHOP_URL` points it at a shop somewhere else.

**Installed, the shop serves the page itself** and there is no second process:

```
yarn build
3d-print-shop serve --page /usr/local/lib/3d-print-shop/packages/ui/dist
```

`--page` is a DIRECTORY and the shop is told nothing else about it - it serves those files at the
root, and whatever is not one of its own routes gets `index.html`, so reloading on any path works.
That is deliberate: the page is a client of this shop, reaching it through `@3d-print-shop/client`
like any other, and a server that resolved the page through the ui package would be the server
depending on a client. The installer passes it for you.

The page is served **without a credential**, and has to be: the page nobody is logged in to yet is
the page they log in on. There is nothing in it worth one - a bundle and a stylesheet - and the API
beside it refuses every route as it always did.

Three bands, top to bottom: the shop's name and what it is doing, counted; the printers, each with
its name, what it is doing and its camera, one of them selected and remembered across a reload; and
every job the caller can see, grouped by the filament it needs loaded first. Choosing a printer
marks the groups it could start on now.

It asks the shop again every two seconds, because every route is a question a client asks and there
is nothing to push. An ask that fails leaves the last good answer on the screen and says what went
wrong above it, so a shop being restarted does not blank a display somebody is watching a print on.

**Somebody logs in to it**, with the id and password the operator set. What that produces is a
session cookie the shop set, which the page cannot read and therefore cannot leak - see **Who may
call it** below. The top bar says who the screen is logged in as, because a screen in a workshop is
one anybody walks up to.

**A machine that says it cannot print is not printed on.** A printer's own account of itself is a
different thing from the shop's reading of it: one whose link to its hardware is down answers over
http perfectly well and can print nothing. The shop keeps a line open to every machine it has - not
only the ones there is work for - and what each says about its own fitness arrives on that line. A
machine saying no is shown as **unavailable**, counted among the ones needing somebody, and passed
over when work is handed out, so a plate is never sent to something that would refuse to start it.

Nobody lifts that one. `printer start` clears an operator's stop, a refusal and an unreachable
machine, and deliberately does not clear this: a person saying a machine is fit does not make its
hardware answer, and the only thing entitled to withdraw it is the machine.

**An admin gets a `+` at the end of the printer row**, which opens a form in the row itself and adds
a machine while the shop runs - name, build volume, address and the API key. A caller who is not an
admin is not offered it: the page asks the shop who it is talking to, over `GET /me`, rather than
offering everything and letting a 403 teach somebody they are not trusted. The shop refuses either
way - withholding the button is manners, not the guard.

The key goes in with the rest, in the same call - adding a machine is one act, and two would let a
printer land without the key it is reached by. It is still kept where every other key is
(`printer-keys.json`, 0600, apart from the printer's record), but the shop writes it there itself
and uses it from that moment: no editing a file, no `SIGHUP`, no restart. It is never read back; the
shop answers with the printer, never with the key, and a key is redacted out of every line it logs.

**Somebody changes their own password from the page**, behind their own name in the corner: the one
they have now, the one they want, and it twice. The one in use is asked for even though the shop
already knows whose browser this is - a session is a screen somebody walked away from. Every OTHER
browser that was logged in as them is logged out by it; the one that asked is kept, because it has
just proved who it is. It needs no signal and no restart: the shop writes the file and puts it in
force in one act.

**A job is renamed on its name**: double-click it, type, and Enter or clicking away keeps it while
Escape abandons it. Renaming is editing the thing you are looking at, so it happens there rather than
behind anything.

**Two marks sit at the right of every job** - pause or resume it, and be rid of it - each naming
itself on hover in the word it would have said. A job that is printing is offered no pause, because a
pause keeps a job from starting and that one started; its second mark says **Cancel** and is a square
rather than a bin, since stopping a print is not throwing it away - what comes off that bed is still
owed a verdict.

The shop's own number for a job is not on the page. It is how a client and the shop name one to each
other; a person reads the name. A name is a label and can be
changed at any time; what was submitted is kept untouched beside it, because a job record is written
once and renaming somebody's mind is not a reason to break that. Pausing holds a queued job back so
the shop passes it over, and is not offered on a print that has started - a hold keeps a job from
STARTING, and saying otherwise on screen would have somebody believe they had stopped a print they
had not.

The last one is a different act depending on what the job is doing, and asks before either. A queued
job is **deleted**: the record, the gcode, all of it, and nothing brings it back. A printing one is
**cancelled** on the machine and does not leave - there is plastic on that bed, so it lands where a
finished print lands and waits for a verdict like any other. A job already waiting for a verdict is
refused, because a verdict is how that one leaves and it has that route already.

**A print that has finished is judged where it is watched.** A job the shop is holding for a verdict
gets three buttons on its line: **approve** (the print is good - the job leaves the shop, gcode and
all), **print again** (not usable - back in the queue to print again from the same gcode) and **give
up** (not usable, and not worth another - the job leaves the shop with nothing to show for it). Any
of them frees the bed, which is why a machine that finished stands holding one until somebody says.

A verdict is the owner's, or an admin's, so it is offered on every job the shop showed this caller
rather than to a role: the shop decides, and says so in its own words if it will not take one.
`job approve`, `job reject` and `job abandon` still do the same thing from a terminal.

## The operator's commands

```
3d-print-shop init dave                                the first admin, on a machine with none
3d-print-shop serve                                    run the shop, so clients can reach it
3d-print-shop printer add mk4 250x210x220 http://octopi.local
3d-print-shop printer list                             what it has, and what each is doing
3d-print-shop printer load mk4 PLA-Red                 what is on the machine now
3d-print-shop printer remove mini
3d-print-shop printer stop mk4 "door is open"
3d-print-shop printer start mk4
3d-print-shop job list                                 what it holds, and where each has got to
3d-print-shop job waiting [printer]                    what to load next, busiest filament first
3d-print-shop job approve 7                            the print is good - the job leaves the shop
3d-print-shop job reject 7                             not usable - print it again from the same gcode
3d-print-shop job abandon 7                            give up on it - no reprint, and it is gone
3d-print-shop shutdown                                 ask it to stop
```

Every command but `serve` and `init` is a client of a running shop and takes `--shop-url` (or
`PRINT_SHOP_URL`; `http://localhost:7373` by default). Only `serve` names a data directory, because only
`serve` holds one; `init` writes credentials on the machine and is what there is before a shop runs.

**Who may call it** is `/etc/3d-print-shop/callers.json`, a list of ids, names, roles and tokens:

```json
[ { "id": "slicer",  "name": "slicer",  "role": "user",  "token": "..." },
  { "id": "dave",    "name": "dave",    "role": "admin", "token": "..." } ]
```

The `id` is what the shop records as owning a job, and a record is never rewritten - so an id is
fixed for as long as that caller exists, while the `name` beside it is only what a log or a UI
shows and may be changed whenever. Letters, digits, dot, dash and underscore, up to 64.

A `user` submits jobs and reads them back. An `admin` does everything else - printers and shutting
down. A caller presents its token as `Authorization: Bearer ...`, which `HttpShop` sends for you
from `PRINT_SHOP_TOKEN` or `~/.config/3d-print-shop/token`.

**A credential hangs off an identity rather than being one.** One person, one id, and a list of what
they may present: a password for the browser, and a token per machine that calls. That is why losing
a laptop costs that laptop's token rather than everything somebody can reach, and why a slicer and
the person who owns it are one owner whose jobs all belong to the same id.

Nothing is stored as it was presented. A **password** is hashed with `scrypt` - memory-hard, salted
per password, the cost written beside it so it can be raised later - because a person chose it and a
person's choice is guessable. A **token** is 32 random bytes of the shop's own making, so guessing is
not a thing that happens: its digest is enough, and being a plain digest is what keeps naming a
caller a map lookup rather than a memory-hard function in front of every request.

```
3d-print-shop caller add ada --role admin      a person: asks for a password, twice
3d-print-shop caller add slicer --machine      a program: prints a token, once
3d-print-shop caller password ada              set what somebody logs in with
3d-print-shop caller token ada                 another token, for another machine
3d-print-shop caller list                      who this shop answers, and what each of them has
3d-print-shop caller migrate                   hash the tokens in a file that still holds them plain
```

A password is never an argument - argv is `ps` and shell history - so these ask for one and the
terminal is told not to echo it. `caller password` is an operator setting somebody else's, at the
machine; a person changing their own does it from the page.

**Logging in** is `POST /sessions`, and the session comes back as a cookie that is `HttpOnly` (no
script on the page can read it), `SameSite=Strict` (no other site can make a browser send it), and
`Secure` when the request arrived over TLS. It expires after 12 hours idle and 7 days whatever
happens, a new one is issued on every login, and `DELETE /sessions` ends it at the shop rather than
only in the browser. Sessions survive a restart - they are kept with the shop's state, by the digest
of what the browser holds, so an update in the night is not everybody logging in again in the
morning. A sessions file the shop cannot read logs everybody out, which is the safe direction - and
the shop says so in its log, rather than starting empty with nobody knowing why.

A wrong password and a name the shop does not know get the same answer, after the same delay -
otherwise the fast refusals are a list of which names exist. After a few wrong ones the shop makes
that name and that address wait, and the wait doubles.

**A caller is added or revoked while the shop runs**: edit the file, or use the commands above, and
send `SIGHUP` - `kill -HUP <pid>`, or `launchctl kill HUP ...` / `systemctl reload ...` - and the
next request is judged against what it now says. A file it cannot read leaves the callers as they
were, and the shop says so in its log rather than locking everybody out over a stray comma. A
password that has changed logs that person out of every browser they were logged in on, which is
what `caller password` is for.

**Upgrading a shop that already has callers**: the old file held tokens in the clear and this one
refuses to read that, naming the command that fixes it. `3d-print-shop caller migrate` hashes what is
there, and every token in it goes on working - nothing has to be reissued to anybody.

**A printer's key is corrected the same way**, in the same signal: `printer-keys.json` is re-read
too, and each file is read on its own, so one that is mistyped does not hold up the other. A key
takes effect the next time the shop reaches that machine, which is when it starts a print on it or
picks one up to watch - a printer holding a print is never started on, so a corrected key waits for
the machine to be idle rather than cutting off a watcher mid-print. A file that is gone is no keys
at all, and the machines are out of reach until it is back.

**A job belongs to the caller who submitted it**, by the `id` above, written with the record and
never rewritten. The owner or an admin reads it; anybody else is told it is not here, because a
refusal would say that it exists. `jobs()` answers `{ accessibleJobs, totalJobs }` - what this
caller may see, and how many the shop holds altogether, which is all a stranger learns.

**A verdict is the owner's**, whatever their role: saying whether the thing you asked for came out
the way you wanted is a question only the caller who asked it can answer. An admin may judge any job
too - an owner is revoked by their entry leaving `callers.json`, and a job nobody may judge would
hold a printer's bed for good.

The shop's own credentials for reaching each printer are a separate file,
`/etc/3d-print-shop/printer-keys.json`, keyed by the printer's name - separate because copying the
first file to a client machine should not hand it every printer's key. Both are 0600, and the shop
refuses to read either if anybody else can.

**Every route names its caller**, so a shop with no `callers.json` does not start - there is no
anonymous mode, not even on loopback. A fresh machine therefore needs its first admin before `serve`
will run at all, and `3d-print-shop init <name>` is what writes one: it makes the file 0600 with a
single admin in it, whose token is 32 random bytes said once and stored nowhere else. It will not
write over callers that are already there, because that file holds every token the shop knows.

**The shop listens on loopback**, because a token travels in the clear over HTTP and the interface
nobody else can reach is the one nobody else can read it off. `serve --listen <address>` says
otherwise, and putting the shop on the network is a thing to decide rather than a thing to
default to.

**It takes gcode up to 128MB**, and keeps that much room spare in the data directory before
accepting any job — it is how the shop survives a restart, so filling it would lose everything it holds,
not just the job that overflowed. `serve --max-gcode <megabytes>` (or `PRINT_SHOP_MAX_GCODE_MB`)
raises it. OctoPrint's own default is 1GB, so the shop is the binding limit until then.

**A verdict is not a formality.** A printer holds its bed until a person has judged what came off it,
so a shop nobody gives verdicts to prints one thing per machine and then stops.

**A machine it cannot reach is not a stopped printer.** The shop writes down that it could not get
to one - what it saw and when - leaves it out of the queue, and reaches for it again on a backoff,
so a printer that was switched off or missing a key comes back by itself and the queue moves again
without anybody typing anything. `printer stop` is an operator's word and only `printer start` lifts
it.

**A print it stops hearing about is not a stopped printer either.** If the shop loses the watch on a
running print - minutes of silence, not a dropped packet - it says so and keeps listening, on the
same backoff. The printer keeps its job, because the machine is very likely still printing it, and
when the shop is heard again the machine's own status says how the print went.

**A machine that answers and says no is a different thing.** An upload the printer turned down - a
path it will not store, a disk with no room - is written down as a refusal and left there, because
the machine has given its answer and asking again re-sends the whole plate to be told the same
thing. That one waits for a person, and `printer start` is how a person says they have dealt with
it.

**`printer start` means try it now, whatever was wrong.** It lifts an operator's stop, a machine out
of reach, a file the machine refused and a print the shop stopped hearing about, forgets whatever
wait it was serving, picks a running print back up, and looks for work. Somebody who has just been
to the machine should not have to say which of those it was, or wait out a backoff the shop chose
before they got there.

**It writes down what it did**, one line of text per event, to stdout - `<when> <level> <message>`
and then `key=value` for the rest:

```
2026-09-08T14:27:59.056Z INFO  job submitted job=1 displayName="Player Box" filaments=["PLA-Red"] owner=dave
2026-09-08T14:27:59.067Z ERROR could not reach the printer printer=mk4 why="fetch failed"
```

What was submitted, what started on which printer, how each print ended, every verdict and who gave
it, and every reason a printer was stopped. `launchd` and `systemd` both capture stdout, so there is no file for the shop to
rotate. Two levels: `INFO` for what happened, `ERROR` for why something did not. A printer's key and
a caller's token are never written, whatever a failure was carrying when it arrived.

**A printer's API key never reaches the command line**, where it would be in shell history and in
`ps`. The shop reads it from `printer-keys.json`, keyed by the printer's own name. Not from the
environment, which it was until that had to be written into a `launchd` plist anybody can read.

## Submitting a job

Through `@3d-print-shop/client`, which is what the contract is for:

```ts
import { HttpShop } from '@3d-print-shop/client';
import { openAsBlob } from 'node:fs';

const shop = new HttpShop('http://localhost:7373');

const job = await shop.submit(
  {
    filaments: ['PLA-Red'],          // the PRINTER's names, in extruder order
    displayName: 'Player Box x4',    // what a person sees in a queue
    requiredBuildVolume: { x: 120, y: 90, z: 40 },
    estimatedPrintSeconds: 20460,    // what the slicer said, if the client knows
    metadata: { anything: 'the shop carries this and never reads it' },
  },
  await openAsBlob('player_box.gcode')
);
```

`openAsBlob` rather than a read buffer: it backs the `Blob` with the file, so `fetch` streams it. A
kit's gcode is exactly the size that makes the difference.

The shop refuses a submission no printer it has could ever take - a build volume that fits nowhere -
before it reads a byte of the upload.

## A protocol it borrowed

Not everything that can produce a plate can be taught a new API. So the shop also answers a protocol
it did not design, under a prefix of its own, for callers that already know how to send a plate
somewhere:

```
POST http://localhost:7373/octoprint/api/files/local
X-Api-Key: <the same token as everything else>

multipart/form-data with a `file` part
```

Point anything that can upload to an OctoPrint at `http://<the shop>:7373/octoprint` and it should
find it. `GET /octoprint/api/version` is what such a caller asks before it sends anything.

**It is a face, not a second contract.** It translates into the same `submit` the contract has
always had, and the store cannot tell one from the other.

**It reads the plate, because the protocol has nowhere to say what a job needs.** That upload carries
a file, a path and two flags, and nothing the shop schedules on. So the face reads the comments a
slicing tool writes into the plate itself: the filament, the estimate, and the bed it was sliced for.
Only the filament is required, because only the filament is required of any job - a plate whose
comments do not name one is refused, and the refusal says so.

**It reads one dialect, and turns away every other plate rather than guessing.** A plate says on its
first line what wrote it, and the shop reads the settings only out of the one whose spellings have
been measured against a real file - `PrusaSlicer 2`, up to but not including a major version nobody
here has seen. Anything else is refused by quoting what the plate said wrote it, because a plate the
shop cannot read may well name its filament in a spelling nobody has measured, and telling somebody
it named none would send them hunting a fault that is the shop's. Widening this means a real plate
from the other tool, in tests/assumptions, and its spellings beside the ones already there.

The bed is taken as the room the job needs, which reads like an over-estimate of the object and is
the right number: a plate's coordinates include the prime line, the skirt and the wipe tower, all
placed against the bed it was sliced for. The object's own extent is the unsafe number, and is
deliberately not what is read.

**A job is named for the model, not for the file.** A slicer's default output name is a template -
the model, then the settings it was sliced with - which is right on a disk full of variants and noise
in a queue, where the filament and the printer are columns of their own. So
`ClampDock_0.4n_0.2mm_PLA_MK4IS_6m.gcode` arrives as **ClampDock**. A name carrying no such template
is left whole with its underscores read as spaces, because somebody who called a file `Player_Box`
meant two words. The answer still describes the file under the name it was sent as; what the shop
decided to call the job is beside it.

**Where it stops pretending.** `POST /octoprint/api/job` is refused, and says why: those commands
mean start now and stop now against a machine somebody is standing at, and this is a queue that
decides for itself when a job may run. An upload asking to print at once is taken and queued like
any other - the answer says the job is queued rather than claiming it started.

**The prefix is not decoration.** At the root, a caller probing `/api/version` would be handed the
page with a 200, which tells whoever set it up nothing at all. Under the prefix that subtree is out
of the page fallback and can answer honestly, including answering no.

This has been driven end to end by a real slicer: a physical printer of host type OctoPrint pointed
at `http://localhost:7373/octoprint/` tests green, probes the version route, and sends a plate the
shop reads and queues. If a slicer reports a connection error and the shop's log shows nothing at
all, the URL was rejected before a socket was opened - look at what was typed, not at the shop.

## Working on it

```
yarn build          every package
yarn typecheck
yarn lint
yarn ut             unit tests - every project, minus the acceptance suites
yarn at             the acceptance suites
yarn test           both
```

The acceptance suites run the real thing: a shop in its own process over a real data directory
(`theRunningShop`), the real client against the real API (`theShopAndItsClient`), and the real
OctoPrint client against `@3d-print-shop/octoprint-sim` (`octoPrintMachines`, `reconnectRecovery`).
No printer is needed for any of them.

## License

Copyright 2026 Dave Corbin. Licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) -
see [LICENSE](LICENSE). Use it, change it, and pass it on for any noncommercial purpose; commercial
use needs a separate license.
