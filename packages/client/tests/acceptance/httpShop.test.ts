import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpShop } from '../../src/HttpShop';
import type { JobDetails, PrinterRecord, Verdict } from '../../src';

// AIDEV-NOTE: a real socket to a stand-in shop, not the shop itself. What is worth proving here is
// what goes over the WIRE and what comes back off it - the order of a multipart body, a time that
// arrives as a string and has to leave as a Date - none of which the far end can show.
//
// That the shop agrees with all of it is proved from the other side, in the server's own suite,
// where both are to hand.
describe('the shop over HTTP', () => {
  let server: Server;
  let shop: HttpShop;

  let answers: { status: number; body: unknown };
  let asked: { method: string; url: string; body: string }[];

  const MK4: PrinterRecord = {
    name: 'mk4',
    buildVolume: { x: 250, y: 210, z: 220 },
    api: 'octoprint',
    address: 'http://octopi.local',
  };

  const playerBox: JobDetails = { filaments: ['PLA-SpaceGray'], displayName: 'Player Box' };

  const aJob = { id: 7, displayName: 'Player Box', filaments: ['PLA-SpaceGray'], gcodeBytes: 21, state: 'queued' };

  function answer(request: IncomingMessage, response: ServerResponse): void {
    const body: Buffer[] = [];
    request.on('data', (chunk: Buffer) => body.push(chunk));
    request.on('end', () => {
      asked.push({ method: request.method ?? '', url: request.url ?? '', body: Buffer.concat(body).toString() });
      response.writeHead(answers.status, { 'content-type': 'application/json' });
      response.end(answers.status === 204 ? undefined : JSON.stringify(answers.body));
    });
  }

  beforeEach(async () => {
    answers = { status: 200, body: {} };
    asked = [];

    server = createServer(answer);
    // AIDEV-NOTE: 127.0.0.1, not the wildcard. `listen(0)` with no address binds 0.0.0.0, and on
    // macOS that SUCCEEDS on a port a loopback listener already holds - so this stand-in could be
    // handed a port belonging to a shop or a sim from another suite, and every request the test then
    // made to 127.0.0.1 went to THAT server. It showed up as a 401 out of a suite whose stand-in
    // answers no such thing, about one full-suite run in ten. Binding the same address the URL names
    // makes the collision impossible rather than unlikely.
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    shop = new HttpShop(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });

  afterEach(async () => {
    await new Promise<void>((closed) => server.close(() => closed()));
  });

  describe('the jobs it is holding', () => {
    // AIDEV-NOTE: a time is an ISO string on the wire. A caller handed one typed as a Date finds out
    // at its first comparison, somewhere else entirely - which is the whole reason for a client
    // rather than a cast over `response.json()`.
    it('hands back a time as a time', async () => {
      answers = { status: 200, body: { accessibleJobs: [{ ...aJob, submittedAt: '2026-09-06T11:22:04.177Z' }], totalJobs: 1 } };

      const [job] = (await shop.jobs()).accessibleJobs;

      expect(job.submittedAt).toBeInstanceOf(Date);
      expect(job.submittedAt.toISOString()).toBe('2026-09-06T11:22:04.177Z');
    });

    // The operator's question rather than the shop's, and a route of its own: anything under /jobs
    // would collide with /jobs/{id}.
    it('asks what the queue is waiting for', async () => {
      answers = { status: 200, body: [{ filament: 'PLA-Red', jobs: 2 }] };

      expect(await shop.waitingOn()).toEqual([{ filament: 'PLA-Red', jobs: 2 }]);
      expect(asked).toMatchObject([{ method: 'GET', url: '/filaments' }]);
    });

    // A name goes in the query and not the path: /filaments is the resource, and a machine only
    // narrows it. Encoded, because a printer may be named anything a directory can be called.
    it('asks what one machine is waiting for', async () => {
      answers = { status: 200, body: [{ filament: 'PLA-Red', jobs: 2 }] };

      await shop.waitingOn('the big one');

      expect(asked).toMatchObject([{ method: 'GET', url: '/filaments?printer=the%20big%20one' }]);
    });

    it('asks for one by id', async () => {
      answers = { status: 200, body: { ...aJob, submittedAt: '2026-09-06T11:22:04.177Z' } };

      expect(await shop.job(7)).toMatchObject({ id: 7, displayName: 'Player Box' });
      expect(asked[0]).toMatchObject({ method: 'GET', url: '/jobs/7' });
    });
  });

  describe('submitting', () => {
    beforeEach(() => {
      answers = { status: 201, body: { ...aJob, submittedAt: '2026-09-06T11:22:04.177Z' } };
    });

    // The shop validates the description before reading a byte of gcode, which is what lets it
    // refuse a hopeless job without being sent tens of megabytes to say so.
    it('sends the description ahead of the gcode', async () => {
      await shop.submit(playerBox, new Blob(['G1 X100\n']));

      expect(asked[0].body.indexOf('name="job"')).toBeLessThan(asked[0].body.indexOf('name="gcode"'));
    });

    it('sends what the shop schedules on, and the gcode it was given', async () => {
      await shop.submit(playerBox, new Blob(['G1 X100\n']));

      expect(asked[0].body).toContain(JSON.stringify(playerBox));
      expect(asked[0].body).toContain('G1 X100');
    });

    it('answers with the job the shop made of it', async () => {
      expect(await shop.submit(playerBox, new Blob(['G1 X100\n']))).toMatchObject({ id: 7, state: 'queued' });
    });
  });

  describe('a verdict', () => {
    // One route and a value, so every verdict goes the same way in and none of them is an endpoint.
    it.each<[Verdict]>([['approved'], ['rejected'], ['abandoned']])('sends %s as the word the shop reads', async (verdict) => {
      answers = { status: 204, body: undefined };

      await shop.verdict(7, verdict);

      expect(asked[0]).toMatchObject({ method: 'PUT', url: '/jobs/7/verdict', body: `{"verdict":"${verdict}"}` });
    });

    it('answers with nothing for a job that has left the shop', async () => {
      answers = { status: 204, body: undefined };

      expect(await shop.verdict(7, 'approved')).toBeUndefined();
    });

    it('answers with the job when it is back in the queue', async () => {
      answers = { status: 200, body: { ...aJob, submittedAt: '2026-09-06T11:22:04.177Z' } };

      expect(await shop.verdict(7, 'rejected')).toMatchObject({ id: 7, state: 'queued' });
    });
  });

  describe('the printers', () => {
    it('hands back the time a printer stopped as a time', async () => {
      answers = { status: 200, body: [{ ...MK4, loaded: [], paused: { reason: 'the door is open', since: '2026-09-06T11:22:04.177Z' } }] };

      expect((await shop.printers())[0].paused?.since).toBeInstanceOf(Date);
    });

    it('hands back the time the shop lost it as a time', async () => {
      answers = { status: 200, body: [{ ...MK4, loaded: [], unreachable: { reason: 'no API key for mk4', since: '2026-09-06T11:22:04.177Z' } }] };

      expect((await shop.printers())[0].unreachable?.since).toBeInstanceOf(Date);
    });

    it('hands back the time a machine refused a file as a time', async () => {
      answers = { status: 200, body: [{ ...MK4, loaded: [], refused: { reason: 'upload failed: 400', since: '2026-09-06T11:22:04.177Z' } }] };

      expect((await shop.printers())[0].refused?.since).toBeInstanceOf(Date);
    });

    it('hands back the time it stopped hearing a print as a time', async () => {
      answers = { status: 200, body: [{ ...MK4, loaded: [], outOfContact: { reason: 'lost contact', since: '2026-09-06T11:22:04.177Z' } }] };

      expect((await shop.printers())[0].outOfContact?.since).toBeInstanceOf(Date);
    });

    // 201 or 200 is the whole difference between adding a printer and changing one, and it lives
    // only on the wire.
    it.each([
      [201, true],
      [200, false],
    ])('reads %s as created being %s', async (status, created) => {
      answers = { status, body: { ...MK4, loaded: [] } };

      expect((await shop.addPrinter(MK4)).created).toBe(created);
    });

    // A name is whatever an operator typed, and one carrying a `#` makes a URL whose path stops
    // there - so the shop would hear about a printer called mk4, or none at all.
    it('escapes a name on its way into the path', async () => {
      answers = { status: 200, body: { ...MK4, loaded: [] } };

      await shop.load('mk4#2', ['PLA-Red']);

      expect(asked[0].url).toBe('/printers/mk4%232/filament');
    });
  });

  describe('when the shop will not', () => {
    // Its own words, because the far end is what knows why; this end knows only that it was refused.
    it('repeats what the shop said', async () => {
      answers = { status: 400, body: { error: 'nothing here has room for 100x100x400mm - mk4 250x210x220mm' } };

      await expect(shop.submit(playerBox, new Blob(['G1']))).rejects.toThrow('nothing here has room');
    });

    it('falls back to the status when a refusal says nothing', async () => {
      answers = { status: 503, body: {} };

      await expect(shop.jobs()).rejects.toThrow('503');
    });

    // The shop is a service somebody starts, so this is the ordinary mistake rather than an
    // exceptional one, and worth a sentence saying what to do about it.
    it('says the shop is not running when nothing answers', async () => {
      await expect(new HttpShop('http://127.0.0.1:1').jobs()).rejects.toThrow('Is it running?');
    });
  });
});
