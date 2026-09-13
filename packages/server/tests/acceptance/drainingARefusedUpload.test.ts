import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '../../src/api';
import { Callers } from '../../src/credentials';
import { JobStore } from '../../src/JobStore';
import { digestOf } from '../../src/secrets';
import { aDataDirectory, parentOf } from '../aDataDirectory';
import type { JobDetails } from '../../src/Job';
import type { DataLayout } from '../../src/dataLayout';

// AIDEV-NOTE: the one test here that needs a real listener, and the reason is the CONNECTION rather
// than anything the routes decide. A submission the shop refuses before reading a byte leaves the
// rest of the upload unread, and an HTTP request whose body was never consumed is a message that
// never completed - so the socket stays open, and a shop asked to stop waits for it for ever.
//
// Everything else the routes do is asked in-process, where an express app is a function of a
// request: jobRoutes, printerRoutes, sessionRoutes, pageServing and guard. Not this, and the reason
// was measured rather than assumed: driven in-process with the drain taken out, the request reports
// `readableEnded` true and nothing unread, exactly as it does when the drain is there. The missing
// drain is invisible.
//
// It is invisible because `request.pipe(parts)` empties the request into busboy either way. What
// goes unread is busboy's FILE stream, and on a real socket that backpressures the parser, which
// backpressures the request, which backpressures TCP - so the message never completes. In-process
// the whole body is pushed into a buffer with no flow control, which is the same reason the size
// threshold below exists on a socket and does not exist here. The fake removes the mechanism the
// drain exists to relieve.
describe('an upload the shop refuses without reading', () => {
  let where: DataLayout;
  let server: Server;
  let shopUrl: string;

  const ADMIN = 'dave-token';
  const callers = new Callers([{ caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] }]);

  const GCODE = 'G1 X100.000 Y100.000\n';
  // AIDEV-NOTE: the size is load-bearing, and the threshold was measured rather than guessed: with
  // the drain taken out, 1 line and 1,000 lines are NOT caught, 20,000 and 400,000 are. Below it the
  // whole body is already in the socket's buffer when the shop refuses, so the message completes on
  // its own and there is nothing left to drain. 400,000 is well clear of the edge; 20,000 was
  // already flaky when it was measured.
  const LINES = 400_000;
  const playerBox: JobDetails = { filaments: ['PLA-SpaceGray'], displayName: 'Player Box' };

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-drain-');
    const shop = new JobStore(where);
    await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://octopi.local' });

    server = await serve(shop, 0, { callers: () => callers });
    shopUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server.listening) await new Promise<void>((closed) => server.close(() => closed()));
    await rm(parentOf(where), { recursive: true, force: true });
  });

  /** Settles when the shop has stopped listening, and fails rather than hanging if it cannot. */
  const stopping = (): Promise<void> =>
    new Promise((stopped, cannot) => {
      const waitedLongEnough = setTimeout(() => cannot(new Error('the shop could not stop - a connection it never finished reading is still open')), 2000);

      server.close(() => {
        clearTimeout(waitedLongEnough);
        stopped();
      });
    });

  // AIDEV-NOTE: the refusal was never the thing at risk. The 400 arrives either way, promptly, drain
  // or no drain - so a test asserting only that passed while the bug was there, and what actually
  // caught it was this file's own TEARDOWN timing out. An accident is not a test, so the claim is
  // made here instead: after the refusal, the shop can stop. Without the drain it cannot, because a
  // request whose body was never read is a message that never completed and a socket still open.
  it('is answered, and leaves nothing open that stops the shop from stopping', async () => {
    const tooTall = { ...playerBox, requiredBuildVolume: { x: 100, y: 100, z: 400 } };
    const body = new FormData();
    body.append('job', JSON.stringify(tooTall));
    body.append('gcode', new Blob([GCODE.repeat(LINES)]), 'print.gcode');

    const response = await fetch(`${shopUrl}/jobs`, { method: 'POST', body, headers: { authorization: `Bearer ${ADMIN}` } });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'nothing here has room for 100x100x400mm - mk4 250x210x220mm' });

    await expect(stopping()).resolves.toBeUndefined();
  });
});
