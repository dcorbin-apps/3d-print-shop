import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { serve } from '../../src/api';
import type { Job, JobDetails } from '../../src/Job';
import { JobStore } from '../../src/JobStore';

// AIDEV-NOTE: real HTTP against a real listener on an ephemeral port, over a real spool. There is no
// unit-level cover for the routes on purpose - what is worth proving here is what goes over the
// wire, and a multipart body handed to a fake request would prove only that the test can build one.
describe('the shop over HTTP', () => {
  let spool: string;
  let shop: JobStore;
  let server: Server;
  let shopUrl: string;
  let mockChanged: jest.Mock<() => void>;
  let mockShutDown: jest.Mock<() => void>;

  const MK4 = { x: 250, y: 210, z: 220 };
  const MK4_ADDRESS = 'http://octopi.local';
  const asRegistered = { name: 'mk4', buildVolume: MK4, api: 'octoprint', address: MK4_ADDRESS, loaded: [] };

  const playerBox: JobDetails = { filaments: ['PLA-SpaceGray'], displayName: 'Player Box' };

  async function submit(details: unknown, gcode = 'G1 X100.000 Y100.000\n'): Promise<Response> {
    const body = new FormData();
    body.append('job', JSON.stringify(details));
    body.append('gcode', new Blob([gcode]), 'print.gcode');

    return fetch(`${shopUrl}/jobs`, { method: 'POST', body });
  }

  async function submitted(details: unknown): Promise<Job> {
    return (await submit(details)).json() as Promise<Job>;
  }

  async function ask(path: string): Promise<Response> {
    return fetch(`${shopUrl}${path}`);
  }

  async function send(method: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${shopUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    spool = await mkdtemp(path.join(tmpdir(), 'print-shop-api-'));
    shop = new JobStore(spool);
    await shop.addPrinter({ name: 'mk4', buildVolume: MK4, api: 'octoprint', address: MK4_ADDRESS });

    mockChanged = jest.fn<() => void>();
    mockShutDown = jest.fn<() => void>();
    server = await serve(shop, 0, { changed: mockChanged, shutDown: mockShutDown });
    shopUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(spool, { recursive: true, force: true });
  });

  describe('submitting', () => {
    it('takes a job in and answers with what the shop now holds', async () => {
      const response = await submit(playerBox);

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        id: 1,
        displayName: 'Player Box',
        state: 'queued',
        gcodeBytes: 'G1 X100.000 Y100.000\n'.length,
      });
    });

    it('holds each submission separately, in the order they arrived', async () => {
      await submit(playerBox);
      await submit({ filaments: ['PLA-Red'] });

      const held = (await (await ask('/jobs')).json()) as Job[];

      expect(held.map((job) => job.displayName).sort()).toEqual(['Job 2', 'Player Box']);
    });

    // AIDEV-NOTE: the order is the contract, not a convenience - the description is what lets a
    // hopeless job be refused before its gcode is read. Accommodating the other order means holding
    // tens of megabytes to find out they were not wanted.
    it('refuses gcode that arrives before the description', async () => {
      const body = new FormData();
      body.append('gcode', new Blob(['G1 X100.000\n']), 'print.gcode');
      body.append('job', JSON.stringify(playerBox));

      const response = await fetch(`${shopUrl}/jobs`, { method: 'POST', body });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'the job part has to come before the gcode part, and did not' });
    });

    it('refuses a description with no gcode beside it', async () => {
      const body = new FormData();
      body.append('job', JSON.stringify(playerBox));

      const response = await fetch(`${shopUrl}/jobs`, { method: 'POST', body });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'a submission needs a gcode part' });
    });

    it('refuses a job no printer here has room for, saying what the shop has', async () => {
      const response = await submit({ ...playerBox, requiredBuildVolume: { x: 100, y: 100, z: 400 } });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'nothing here has room for 100x100x400mm - mk4 250x210x220mm' });
    });

    // AIDEV-NOTE: at SIZE, because that is the only way the drain matters. The shop decides against
    // this job before it has read any of it, and a client that is still writing megabytes has to
    // stay connected long enough to read the answer - so what is left of the upload is drained.
    it('answers a refusal while the gcode it refused is still arriving', async () => {
      const tooTall = { ...playerBox, requiredBuildVolume: { x: 100, y: 100, z: 400 } };

      const response = await submit(tooTall, 'G1 X100.000 Y100.000\n'.repeat(400_000));

      expect(response.status).toBe(400);
    });
  });

  describe('asking after a job', () => {
    it('answers with the one asked for', async () => {
      const job = await submitted(playerBox);

      expect(await (await ask(`/jobs/${job.id}`)).json()).toMatchObject({ id: job.id, displayName: 'Player Box' });
    });

    it('says there is no such job when there is not', async () => {
      const response = await ask('/jobs/9');

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'no job 9' });
    });

    // What the client asked for, rather than what Number() made of it - "no job NaN" tells nobody
    // anything.
    it('says what it was asked for when the id is not a number', async () => {
      const response = await send('PUT', '/jobs/abc/verdict', { verdict: 'approved' });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'no job abc' });
    });
  });

  describe('a verdict', () => {
    async function awaitingApproval(): Promise<Job> {
      const job = await submitted(playerBox);
      await shop.startPrinting('mk4', job.id);

      return shop.finishedPrinting('mk4', 'finished');
    }

    it('approves a print, and the job leaves the shop', async () => {
      const job = await awaitingApproval();

      expect((await send('PUT', `/jobs/${job.id}/verdict`, { verdict: 'approved' })).status).toBe(204);
      expect((await ask(`/jobs/${job.id}`)).status).toBe(404);
    });

    it('rejects a print, and the job goes back to be printed again', async () => {
      const job = await awaitingApproval();

      const response = await send('PUT', `/jobs/${job.id}/verdict`, { verdict: 'rejected' });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: job.id, state: 'queued' });
    });

    it('will not judge a job that has not been printed', async () => {
      const job = await submitted(playerBox);

      const response = await send('PUT', `/jobs/${job.id}/verdict`, { verdict: 'approved' });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: `job ${job.id} is queued, so there is no print to judge` });
    });

    it('abandons a print, and the job leaves the shop without being printed again', async () => {
      const job = await awaitingApproval();

      expect((await send('PUT', `/jobs/${job.id}/verdict`, { verdict: 'abandoned' })).status).toBe(204);
      expect((await ask(`/jobs/${job.id}`)).status).toBe(404);
    });

    it('refuses a verdict it does not know', async () => {
      const job = await awaitingApproval();

      const response = await send('PUT', `/jobs/${job.id}/verdict`, { verdict: 'good enough' });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'a verdict is approved, rejected or abandoned, not "good enough"' });
    });
  });

  // AIDEV-NOTE: every change is a moment something might be startable, so the shop is told about
  // all of them rather than about a chosen few - a per-route list is the thing somebody forgets to
  // add to, and a missed wake-up is a job that sits queued for ever.
  describe('saying that something changed', () => {
    it('says so after a change', async () => {
      await submit(playerBox);

      expect(mockChanged).toHaveBeenCalledTimes(1);
    });

    it('says nothing after a mere look', async () => {
      await ask('/jobs');

      expect(mockChanged).not.toHaveBeenCalled();
    });

    // Nothing changed, so there is nothing new to start.
    it('says nothing when the change was refused', async () => {
      await send('PUT', '/printers/mk4/status', { stopped: true });

      expect(mockChanged).not.toHaveBeenCalled();
    });
  });

  describe('closing the shop', () => {
    // Answered before it happens, because a shop that has stopped cannot report that it stopped.
    it('agrees to stop, and then does', async () => {
      const response = await send('POST', '/shutdown', {});

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ stopping: true });
      expect(mockShutDown).toHaveBeenCalled();
    });

    // Looking for work on the way out could start a print the shop is about to stop watching.
    it('is not a change worth looking for work over', async () => {
      await send('POST', '/shutdown', {});

      expect(mockChanged).not.toHaveBeenCalled();
    });
  });

  // The spool root is made when the shop is installed and never by the shop - so a missing one is a
  // machine that was never set up, which is the service's fault and not the client's.
  describe('when the shop was never installed', () => {
    it('says so, and says a client may as well come back later', async () => {
      const missing = path.join(spool, 'never-made');
      const unusable = await serve(new JobStore(missing), 0);

      try {
        const response = await fetch(`http://127.0.0.1:${(unusable.address() as AddressInfo).port}/jobs`);

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: `${missing} is not there - it is created when the shop is installed` });
      } finally {
        await new Promise<void>((resolve) => unusable.close(() => resolve()));
      }
    });
  });

  describe('the printers', () => {
    it('adds one the shop did not have', async () => {
      const mini = { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini.local' };

      const response = await send('POST', '/printers', mini);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ...mini, api: 'octoprint', loaded: [] });
    });

    // Adding a printer that is already here changes its build volume rather than failing, so the
    // answer has to say which of the two happened.
    it('changes one it already had', async () => {
      const taller = { x: 250, y: 210, z: 270 };

      const response = await send('POST', '/printers', { name: 'mk4', buildVolume: taller, address: MK4_ADDRESS });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...asRegistered, buildVolume: taller });
    });

    it.each([
      ['a side it was not given', { x: 180, y: 180 }],
      ['a side of nothing', { x: 180, y: 180, z: 0 }],
    ])('refuses a build volume with %s', async (_description, buildVolume) => {
      const response = await send('POST', '/printers', { name: 'mini', buildVolume, address: 'http://mini.local' });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'a build volume is x, y and z in mm, each greater than zero' });
    });

    it('refuses a body that is not JSON at all', async () => {
      const response = await fetch(`${shopUrl}/printers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ name: mini',
      });

      expect(response.status).toBe(400);
    });

    it('takes one out of the shop', async () => {
      expect((await fetch(`${shopUrl}/printers/mk4`, { method: 'DELETE' })).status).toBe(204);
      expect(await (await ask('/printers')).json()).toEqual([]);
    });

    it('says there is no such printer when asked to remove one it does not have', async () => {
      const response = await fetch(`${shopUrl}/printers/ender`, { method: 'DELETE' });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'no printer called ender - the operator adds one before it can print' });
    });

    // AIDEV-NOTE: no printer here reports its own filament, so this is the operator's word and the
    // only record of what a machine can print right now.
    it('takes what the operator says is loaded, in order', async () => {
      const response = await send('PUT', '/printers/mk4/filament', { loaded: ['PLA-Red', 'PLA-Blue'] });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ name: 'mk4', loaded: ['PLA-Red', 'PLA-Blue'] });
    });

    // Naming none is how an operator says a machine has been emptied.
    it('takes an empty machine for an answer', async () => {
      await send('PUT', '/printers/mk4/filament', { loaded: ['PLA-Red'] });

      expect(await (await send('PUT', '/printers/mk4/filament', { loaded: [] })).json()).toMatchObject({ loaded: [] });
    });

    it('refuses filament that is not a list of names', async () => {
      const response = await send('PUT', '/printers/mk4/filament', { loaded: 'PLA-Red' });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'loaded is the filaments on the machine, in order, and an empty list means none' });
    });

    it('will not load a printer it does not have', async () => {
      expect((await send('PUT', '/printers/ender/filament', { loaded: ['PLA-Red'] })).status).toBe(404);
    });

    it('stops a printer, with the reason an operator should see', async () => {
      const response = await send('PUT', '/printers/mk4/status', { stopped: true, reason: 'door is open' });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ name: 'mk4', paused: { reason: 'door is open' } });
    });

    it('starts a stopped printer again', async () => {
      await shop.pause('mk4', 'door is open');

      const response = await send('PUT', '/printers/mk4/status', { stopped: false });

      expect(await response.json()).toEqual(asRegistered);
    });

    it('will not stop a printer without a reason', async () => {
      const response = await send('PUT', '/printers/mk4/status', { stopped: true });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'stopping a printer needs a reason an operator can act on' });
    });
  });
});
