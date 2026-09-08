# 3D Print Shop

A service that takes print jobs and gets them onto a printer: holding each one until the filament it
needs is loaded, sending it to a machine that can take it, and keeping it until a person has said
whether what came off the bed is usable.

It knows nothing about what it is printing. A client hands it a gcode file and says what filament it
needs and how much room it takes; the shop schedules on that and nothing else. gamebox is its first
client and has no special standing.

See [design/3d-print-shop.md](design/3d-print-shop.md) for why it is shaped this way, and
[PLAN.md](PLAN.md) for what is still to do.

## The packages

| Package | What it is |
|---|---|
| `@3d-print-shop/server` | The service, and the operator's command line. |
| `@3d-print-shop/client` | The contract - the wire types, the `Shop` interface, and `HttpShop`, which speaks it. What a client depends on. |
| `@3d-print-shop/octoprint-sim` | A stand-in OctoPrint, enough of the real protocol to prove the shop talks to one. |

The server depends on the client, not the other way about: the contract is one thing, written once,
so a client cannot be written against an API it can no longer see.

## Running one

```
yarn install
yarn build
yarn shop serve --spool /var/spool/3d-print-shop
```

It will not start until `/etc/3d-print-shop/callers.json` names somebody who may call it: every
route names its caller, and a shop nobody may call has nothing to answer. `3d-print-shop init dave`
writes that file with one admin in it - see **Who may call it** below.

`yarn shop` runs the server straight from source; an installed shop is the `3d-print-shop` binary
`@3d-print-shop/server` declares. Either way it is a plain long-running process, so `launchd` and
`systemd` can both supervise it, it stops on `SIGTERM`, and it re-reads `callers.json` on `SIGHUP`.

**The spool root is the installer's to create, not the shop's.** `/var/spool/cups` is made at
install time and owned by the service's user, and this is the same: a missing root is a machine that
was never set up, so the shop refuses to start rather than putting its work somewhere nobody is
looking. `PRINT_SHOP_SPOOL` overrides the path, for an install that would rather not involve root.

One shop to a spool. `serve` claims it by listening on a socket inside it, so a second shop over the
same spool is refused and a crash leaves nothing to clean up.

## The operator's commands

```
3d-print-shop init dave                                the first admin, on a machine with none
3d-print-shop serve --spool /var/spool/3d-print-shop   run the shop, so clients can reach it
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
`PRINT_SHOP_URL`; `http://localhost:7373` by default). Only `serve` names a spool, because only
`serve` holds one; `init` writes credentials on the machine and is what there is before a shop runs.

**Who may call it** is `/etc/3d-print-shop/callers.json`, a list of ids, names, roles and tokens:

```json
[ { "id": "gamebox", "name": "gamebox", "role": "user",  "token": "..." },
  { "id": "dave",    "name": "dave",    "role": "admin", "token": "..." } ]
```

The `id` is what the shop records as owning a job, and a record is never rewritten - so an id is
fixed for as long as that caller exists, while the `name` beside it is only what a log or a UI
shows and may be changed whenever. Letters, digits, dot, dash and underscore, up to 64.

A `user` submits jobs and reads them back. An `admin` does everything else - printers and shutting
down. A caller presents its token as `Authorization: Bearer ...`, which `HttpShop` sends for you
from `PRINT_SHOP_TOKEN` or `~/.config/3d-print-shop/token`.

**A caller is added or revoked while the shop runs**: edit the file and send `SIGHUP` - `kill -HUP
<pid>`, or `launchctl kill HUP ...` / `systemctl reload ...` - and the next request is judged against
what it now says. A file it cannot read leaves the callers as they were, and the shop says so in its
log rather than locking everybody out over a stray comma. Nothing else is re-read.

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

**It takes gcode up to 128MB**, and keeps that much room spare on the spool before accepting any
job — the spool is how the shop survives a restart, so filling it would lose everything it holds,
not just the job that overflowed. `serve --max-gcode <megabytes>` (or `PRINT_SHOP_MAX_GCODE_MB`)
raises it. OctoPrint's own default is 1GB, so the shop is the binding limit until then.

**A verdict is not a formality.** A printer holds its bed until a person has judged what came off it,
so a shop nobody gives verdicts to prints one thing per machine and then stops.

**It writes down what it did**, one line of text per event, to stdout - `<when> <level> <message>`
and then `key=value` for the rest:

```
2026-09-08T14:27:59.056Z INFO  job submitted job=1 displayName="Player Box" filaments=["PLA-Red"] owner=dave
2026-09-08T14:27:59.067Z ERROR printer stopped printer=mk4 why="could not start anything on mk4: fetch failed"
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
    metadata: { anything: 'the shop carries this and never reads it' },
  },
  await openAsBlob('player_box.gcode')
);
```

`openAsBlob` rather than a read buffer: it backs the `Blob` with the file, so `fetch` streams it. A
kit's gcode is exactly the size that makes the difference.

The shop refuses a submission no printer it has could ever take - a build volume that fits nowhere -
before it reads a byte of the upload.

## Working on it

```
yarn build          every package
yarn typecheck
yarn lint
yarn ut             unit tests - every project, minus the acceptance suites
yarn at             the acceptance suites
yarn test           both
```

The acceptance suites run the real thing: a shop in its own process over a real spool
(`theRunningShop`), the real client against the real API (`theShopAndItsClient`), and the real
OctoPrint client against `@3d-print-shop/octoprint-sim` (`octoPrintMachines`, `reconnectRecovery`).
No printer is needed for any of them.

## License

Copyright 2026 Dave Corbin. Licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) -
see [LICENSE](LICENSE). Use it, change it, and pass it on for any noncommercial purpose; commercial
use needs a separate license.
