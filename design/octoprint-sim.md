# octoprint-sim Design

## Purpose

A stand-in OctoPrint, so the shop can be developed and tested against the real protocol without
physical hardware or an OctoPrint install. It implements enough of OctoPrint's actual HTTP and
WebSocket surface that `OctoPrint` (`packages/server/src/OctoPrint.ts`) - the unmodified, real
client - talks to it exactly as it would to a machine. There is no "simulated client": the thing
under test is always the one that will meet the real printer.

It is a library, not an application. `startOctoPrintServer()` answers with a running server and the
handles to drive it, so a test can decide what a submitted job does. Inside, it is three pieces: a
`SimulatedPrinter` that holds what has been issued, what is on the bed and what has been run;
`PushSockets`, which is who is listening and what they are told; and the transport - an express app
and a `ws` server - over both. The split is what lets every rule be asked directly, without a port. A client of this repository may
draw a window around it - one such is an Electron app that renders each submitted job and lets a
person click Complete, Fail or Cancel - and that window is no part of this package.

## Protocol surface

Derived from what `OctoPrint` actually sends:

- `POST /api/files/local` - multipart form upload (`file`, `path`, `print=true`), `X-Api-Key`
  header. Must respond 2xx, answering `{"done":true,"files":{"local":{"name","path","origin"}}}`.
  The client asks for a path and reads `files.local.path` back to learn where the file actually
  went: a completion event carries the path the machine filed it under, so a rename the client did
  not follow is a print nobody hears the end of.
- `GET /api/files/local/<path>` - what the machine holds at that path, which is how a print already
  running is picked up again after a restart.
- `POST /api/job` - JSON body `{"command":"cancel"}`, `X-Api-Key` header. Must respond 2xx.
- `POST /api/login` with `{"passive": true}` - answers `{ name, session }`. OctoPrint's push socket
  does not accept an API key, so this call is what yields the session the socket needs.
- `ws://.../sockjs/websocket` - on open, the client sends `{"auth":"<name>:<session>"}`. OctoPrint's
  own `server/util/sockjs.py` splits that payload on `:` and requires exactly two parts, the second
  being a session from a login call. Nothing authenticates from the URL, and the key deliberately
  never appears there, where proxy and server logs would record it. The simulator delivers events
  only to sockets presenting a session it issued.

  The server pushes
  `{"event":{"type":"PrintDone"|"PrintFailed"|"PrintCancelled","payload":{"path":"<path>"}}}`
  to signal a job's outcome. Broadcast to every connected client, matching real OctoPrint - and
  matching the shop's single persistent connection, which listens for all events regardless of who
  submitted the job.

## One job at a time

A real printer runs one job at a time, so `POST /api/files/local` answers `409` if a previously
submitted job has not yet completed. Enforced here rather than left to callers: a scheduling bug
that submits out of turn gets a hard failure instead of two silently overlapping jobs. The busy
state clears whenever the active job completes, including when a handler throws rather than
completing normally - a crash in a client's handler must not wedge the printer for good.

## What is tested, and where

Driving a real client at this server was where most of its coverage lived, in an acceptance test that
reconnected a real `OctoPrint` against it over a real socket. That test is gone, and what it was for
is worth recording: measured against the same mutations, it caught strictly LESS of the reconnect
logic than `OctoPrint.test.ts` does through an injected socket - including the lost-outcome race that
was found and fixed on 2026-09-12. The frame shapes it seemed to pin are pinned by this package's own
unit tests on one side and `OctoPrint.test.ts` on the other.

The one thing it alone caught was `pushSocket`, the adapter from `ws` to the interface the shop knows -
a text frame arrives from `ws` as a Buffer where the DOM gives a string, and handing that on undecoded
makes every frame unreadable. That is `packages/server/tests/pushSocket.test.ts` now, against a real
`ws` server in-process, because a fake `ws` is precisely where the belief about what `ws` hands over
would be written down.

Its own tests cover what it REFUSES - a bad auth frame, a second job while one is printing. Those are
the traps nothing else springs: loosen one and every suite above still passes, having quietly stopped
proving anything, which was measured rather than assumed.

They are unit tests, and this package has no acceptance suite. `SimulatedPrinter` and `PushSockets`
are asked directly, and the routes are driven through the express app without a port - an express app
is a function of a request. A stand-in socket is not the claim here: what is claimed is what
`PushSockets` does with a frame, and silence is the rejection either way. See
`simulatedPrinter.test.ts`, `pushSockets.test.ts` and `octoPrintApp.test.ts`.

## Known gap: no filament metadata over the wire

OctoPrint's upload API carries no notion of which filament a job needs, so nothing about the shop's
`filaments` reaches the machine. A client that wants to draw a job in its real colour has to read it
out of the gcode itself - PrusaSlicer writes `; filament_colour = #RRGGBB` - which is
slicer-specific guesswork, not something this protocol provides.
