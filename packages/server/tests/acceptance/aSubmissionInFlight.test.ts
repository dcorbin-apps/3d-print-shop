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

// AIDEV-NOTE: the one test in this repository that needs a listener, and the whole reason it does is
// that the client is still WRITING when the answer goes back.
//
// Every other thing the shop's routes do is asked in-process, where an express app is a function of
// a request: tests/jobRoutes.test.ts, tests/printerRoutes.test.ts, tests/sessionRoutes.test.ts,
// tests/pageServing.test.ts and tests/guard.test.ts. That is not about speed - the socket cost eight
// milliseconds a test - it is that a failing acceptance test says a broad path broke where a unit
// test says which rule refused and why.
//
// Breadth is not lost by that. theRunningShop drives a spawned process over a real socket through
// argv, the API, the store and back out again, which is broader than this file ever was.
describe('a submission the shop refuses while it is still arriving', () => {
  let where: DataLayout;
  let server: Server;
  let shopUrl: string;

  const ADMIN = 'dave-token';
  const callers = new Callers([{ caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] }]);

  const playerBox: JobDetails = { filaments: ['PLA-SpaceGray'], displayName: 'Player Box' };

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-inflight-');
    const shop = new JobStore(where);
    await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://octopi.local' });

    server = await serve(shop, 0, { callers: () => callers });
    shopUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((closed) => server.close(() => closed()));
    await rm(parentOf(where), { recursive: true, force: true });
  });

  // AIDEV-NOTE: at SIZE, because that is the only way the drain matters. The shop decides against
  // this job before it has read any of it, and a client that is still writing megabytes has to stay
  // connected long enough to read the answer - so what is left of the upload is drained rather than
  // dropped. In-process there is no "still arriving": the body is pushed whole before the app is
  // called, and the test would be asserting against a stream it wrote itself.
  it('answers the refusal rather than dropping the connection', async () => {
    const tooTall = { ...playerBox, requiredBuildVolume: { x: 100, y: 100, z: 400 } };
    const body = new FormData();
    body.append('job', JSON.stringify(tooTall));
    body.append('gcode', new Blob(['G1 X100.000 Y100.000\n'.repeat(400_000)]), 'print.gcode');

    const response = await fetch(`${shopUrl}/jobs`, { method: 'POST', body, headers: { authorization: `Bearer ${ADMIN}` } });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'nothing here has room for 100x100x400mm - mk4 250x210x220mm' });
  });
});
