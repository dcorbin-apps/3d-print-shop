# @3d-print-shop/installer

One shell script. It makes the things a machine needs before it can run a print shop as a service:
the user that owns the work, the directories the work goes in, and `launchd` or `systemd` to keep it
running.

It is a package of its own rather than part of the server, because installing a daemon is not
something that should happen to somebody who merely depends on the shop's code - and because
`npm i -g @3d-print-shop/installer` reads as "install the service" where `npm i
@3d-print-shop/server` reads as "give me the library".

## Installing

```
sudo npm i -g @3d-print-shop/installer
```

npm's `postinstall` runs the script, which finds the server npm put beside it and installs the
service around it. Nothing is copied: npm has already put the code where the service can read it.

Run without `sudo`, it tells you what to type rather than failing - a `postinstall` that exits
non-zero would fail the whole npm install.

**From a checkout**, for working on the shop itself:

```
yarn install && yarn build
sudo packages/installer/install.sh
```

The script works out which of the two it is by where it sits: under `node_modules/@3d-print-shop/`
it is a package, and anything else is a checkout. From a checkout it **copies** the build to
`/usr/local/lib/3d-print-shop` and points the service there, for two reasons - the service user
cannot read into your home directory, and a `git checkout` of another branch should not be a live
change to a running service.

## What it does

```
sudo 3d-print-shop-install [install|update|uninstall]
```

| | |
|---|---|
| `install` | the default. Makes the user, the directories, the copy of the shop, and the service |
| `update` | copies a fresh build over the installed one and restarts. What to run after `yarn build`, and **only from a checkout** - an installed package is updated by installing it again |
| `uninstall` | stops the service and removes it. The data, the credentials and the user are **left alone** |

`uninstall` leaves the data because uninstalling a service is not the same act as throwing away the
work it was holding, and one of those cannot be undone.

## What it makes

| | Linux | macOS |
|---|---|---|
| the user it runs as | `printshop` | `_printshop` |
| jobs | `/var/spool/3d-print-shop/jobs` | `/Library/Application Support/3d-print-shop/jobs` |
| state | `/var/lib/3d-print-shop` | `/Library/Application Support/3d-print-shop/state` |
| credentials | `/etc/3d-print-shop` | `/etc/3d-print-shop` |
| the service | `/etc/systemd/system/3d-print-shop.service` | `/Library/LaunchDaemons/com.dcorbin.3d-print-shop.plist` |
| its log | `journalctl -u 3d-print-shop -f` | `tail -f /var/log/3d-print-shop.log` |

A system user that nobody can log in as. The directories are `0700` and owned by it; the shop refuses
to start if its own directories are writable by anyone else.

The runtime directory - the claim one shop takes on a set of directories so a second cannot run over
the same ones - is `/var/run/3d-print-shop` on both, and is **not** the installer's: it is meant to
be emptied by a boot, so the shop makes it every time.

## It refuses rather than guesses

- **no node outside a home directory**, new enough. The service runs as its own user, which cannot
  read a node a version manager put under yours - so it looks for a system one and says where to get
  one (`brew install node@24`, or your distribution's package). `PRINT_SHOP_NODE=/path/to/node`
  overrides the search.
- **no build to install**, from a checkout that has not run `yarn build`.
- **no page built.** The page is how a person uses the shop - where they log in, watch a machine, and
  say whether what came off the bed is any good - so an install without one is refused rather than
  made.
- **not run as root.** It writes under `/var`, `/etc` and `/usr/local`.

## It installs without starting, once

A shop with no callers refuses to start, because every route names its caller and a shop nobody may
call has nothing to answer. So the first install stops short and prints the exact commands: make the
first admin as the service user, keep the token where the client looks for it, then run the install
again to start it.

That is deliberate rather than tidy. Started with no callers, the supervisor would restart it every
few seconds for as long as the machine was up - a log nobody can read, and a fault that reads like a
bug.

## Known: macOS is not currently installable

The script makes `/var/spool/3d-print-shop/jobs` and `/var/lib/3d-print-shop` on both platforms,
where the service on macOS looks under `/Library/Application Support/3d-print-shop`. It will install
and then refuse to start, saying a directory is missing - correctly, since the one it wants was
never made. Linux is unaffected, and is what CI builds and what this has been run on. See PLAN.md.
