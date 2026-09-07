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

`yarn shop` runs the server straight from source; an installed shop is the `3d-print-shop` binary
`@3d-print-shop/server` declares. Either way it is a plain long-running process, so `launchd` and
`systemd` can both supervise it, and it stops on `SIGTERM`.

**The spool root is the installer's to create, not the shop's.** `/var/spool/cups` is made at
install time and owned by the service's user, and this is the same: a missing root is a machine that
was never set up, so the shop refuses to start rather than putting its work somewhere nobody is
looking. `PRINT_SHOP_SPOOL` overrides the path, for an install that would rather not involve root.

One shop to a spool. `serve` claims it by listening on a socket inside it, so a second shop over the
same spool is refused and a crash leaves nothing to clean up.

## The operator's commands

```
3d-print-shop serve --spool /var/spool/3d-print-shop   run the shop, so clients can reach it
3d-print-shop printer add mk4 250x210x220 http://octopi.local
3d-print-shop printer list                             what it has, and what each is doing
3d-print-shop printer load mk4 PLA-Red                 what is on the machine now
3d-print-shop printer remove mini
3d-print-shop printer stop mk4 "door is open"
3d-print-shop printer start mk4
3d-print-shop job list                                 what it holds, and where each has got to
3d-print-shop job approve 7                            the print is good - the job leaves the shop
3d-print-shop job reject 7                             not usable - print it again from the same gcode
3d-print-shop job abandon 7                            give up on it - no reprint, and it is gone
3d-print-shop shutdown                                 ask it to stop
```

Every command but `serve` is a client of a running shop and takes `--shop-url` (or `PRINT_SHOP_URL`;
`http://localhost:7373` by default). Only `serve` names a spool, because only `serve` holds one.

**The shop listens on loopback.** Nothing it answers is authenticated, so whoever can reach the port
can submit work, delete a printer, or stop the shop mid-print - and `127.0.0.1` keeps that to the
machine it runs on. `serve --listen <address>` says otherwise, and `--listen 0.0.0.0` puts an
unauthenticated shop on the network, which is a thing to decide rather than a thing to default to.

**It takes gcode up to 128MB**, and keeps that much room spare on the spool before accepting any
job — the spool is how the shop survives a restart, so filling it would lose everything it holds,
not just the job that overflowed. `serve --max-gcode <megabytes>` (or `PRINT_SHOP_MAX_GCODE_MB`)
raises it. OctoPrint's own default is 1GB, so the shop is the binding limit until then.

**A verdict is not a formality.** A printer holds its bed until a person has judged what came off it,
so a shop nobody gives verdicts to prints one thing per machine and then stops.

**A printer's API key never reaches the command line**, where it would be in shell history and in
`ps`. The shop reads it from the environment, one variable per printer:
`PRINT_SHOP_KEY_MK4` for a printer called `mk4`.

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
