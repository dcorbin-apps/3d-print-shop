import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

  // AIDEV-NOTE: the spool IS the recovery model, so an upload that fills it loses every job the shop
  // is holding and not only the one that overflowed. These are the limits that stop that, driven
  // over real HTTP because what is being proven is where the bytes stop - not that a number was set.
  describe('a submission bigger than the shop will take', () => {
    let small: Server;
    let smallUrl: string;

    // Small enough that the test sends bytes rather than megabytes; the rule under test is the same.
    const CAP = 64;

    beforeEach(async () => {
      const store = new JobStore(spool, { maxGcodeBytes: CAP });
      await store.addPrinter({ name: 'mk4', buildVolume: MK4, api: 'octoprint', address: MK4_ADDRESS });
      small = await serve(store, 0);
      smallUrl = `http://127.0.0.1:${(small.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => small.close(() => resolve()));
    });

    async function submitTo(url: string, body: FormData): Promise<Response> {
      return fetch(`${url}/jobs`, { method: 'POST', body });
    }

    function submission(gcode: string): FormData {
      const body = new FormData();
      body.append('job', JSON.stringify(playerBox));
      body.append('gcode', new Blob([gcode]), 'print.gcode');
      return body;
    }

    // The description arrives before the gcode by contract, so refusing an outsized one is refusing
    // before anything has been written - which is why this one may refuse where a part count cannot.
    it('refuses a description longer than it will read', async () => {
      const body = new FormData();
      body.append('job', JSON.stringify({ ...playerBox, metadata: { padding: 'x'.repeat(1024 * 1024) } }));
      body.append('gcode', new Blob(['G1\n']), 'print.gcode');

      const response = await submitTo(smallUrl, body);

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: `the job part is longer than ${1024 * 1024} bytes` });
    });

    it('takes one exactly as big as the cap', async () => {
      expect((await submitTo(smallUrl, submission('G'.repeat(CAP)))).status).toBe(201);
    });

    it('refuses one a single byte over', async () => {
      const response = await submitTo(smallUrl, submission('G'.repeat(CAP + 1)));

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: `gcode is longer than the ${CAP} bytes this shop takes` });
    });

    // busboy truncates at the cap and ends the stream as though the file were whole, so the danger
    // is not a rejected job - it is an ACCEPTED one holding half a print.
    it('keeps nothing at all of one it refused', async () => {
      await submitTo(smallUrl, submission('G'.repeat(CAP + 1)));

      expect(await (await fetch(`${smallUrl}/jobs`)).json()).toEqual([]);
      await expect(readdir(path.join(spool, 'jobs'))).resolves.toEqual([]);
    });

    // Past the part count busboy discards rather than raising, which is the same thing that already
    // happens to a part with a name the shop does not read. The first gcode part is the submission.
    it('ignores a second gcode part rather than refusing a job it has already taken', async () => {
      const body = submission('G1\n');
      body.append('gcode', new Blob(['G2\n']), 'other.gcode');

      const response = await submitTo(smallUrl, body);

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ id: 1, gcodeBytes: 3 });
    });
  });

  // A full disk is the machine's fault, not the client's, so it is told to come back rather than
  // told it did something wrong. Room for the BIGGEST job, because this one's size is not yet known.
  describe('when the spool has no room left', () => {
    it('takes nothing, and says to come back later', async () => {
      const full = new JobStore(spool, { maxGcodeBytes: 1024, freeBytes: () => Promise.resolve(512) });
      const server = await serve(full, 0);

      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const body = new FormData();
        body.append('job', JSON.stringify(playerBox));
        body.append('gcode', new Blob(['G1\n']), 'print.gcode');

        const response = await fetch(`${url}/jobs`, { method: 'POST', body });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: `${spool} has 512 bytes free, and the shop keeps 1024 spare for a job` });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // AIDEV-NOTE: over real HTTP because what is being proven is what a request carrying a token does,
  // and every route is reached the way a caller reaches it. The permission table is the security
  // boundary, so what a `user` may NOT do is asserted route by route rather than in the general.
  describe('who is asking', () => {
    let guarded: Server;
    let guardedUrl: string;

    const ADMIN = 'dave-token';
    const USER = 'gamebox-token';

    beforeEach(async () => {
      guarded = await serve(shop, 0, {
        callers: new Map([
          [ADMIN, { name: 'dave', role: 'admin' as const }],
          [USER, { name: 'gamebox', role: 'user' as const }],
        ]),
      });
      guardedUrl = `http://127.0.0.1:${(guarded.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => guarded.close(() => resolve()));
    });

    function as(token: string | undefined, method: string, path: string, body?: unknown): Promise<Response> {
      return fetch(`${guardedUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    it('refuses a caller carrying no token at all', async () => {
      const response = await as(undefined, 'GET', '/jobs');

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'this shop does not know that token' });
    });

    it('refuses a token it does not know', async () => {
      expect((await as('made-up', 'GET', '/jobs')).status).toBe(401);
    });

    // The same answer either way, so a caller cannot learn which tokens exist by watching for a
    // different refusal.
    it('says the same thing to a bad token as to none', async () => {
      const missing = await as(undefined, 'GET', '/jobs');
      const wrong = await as('made-up', 'GET', '/jobs');

      expect(await wrong.json()).toEqual(await missing.json());
    });

    it.each([
      ['GET', '/jobs'],
      ['GET', '/jobs/1'],
      ['GET', '/printers'],
    ])('lets a user %s %s', async (method, path) => {
      expect((await as(USER, method, path)).status).not.toBe(403);
    });

    it('lets a user submit a job', async () => {
      const body = new FormData();
      body.append('job', JSON.stringify(playerBox));
      body.append('gcode', new Blob(['G1\n']), 'print.gcode');

      const response = await fetch(`${guardedUrl}/jobs`, { method: 'POST', body, headers: { authorization: `Bearer ${USER}` } });

      expect(response.status).toBe(201);
    });

    it.each([
      ['POST', '/shutdown', {}],
      ['PUT', '/jobs/1/verdict', { verdict: 'approved' }],
      ['POST', '/printers', { name: 'mini', buildVolume: MK4, address: 'http://mini' }],
      ['DELETE', '/printers/mk4', undefined],
      ['PUT', '/printers/mk4/filament', { loaded: ['PLA'] }],
      ['PUT', '/printers/mk4/status', { stopped: true, reason: 'door' }],
    ])('will not let a user %s %s', async (method, path, body) => {
      const response = await as(USER, method, path, body);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: `${method} ${path} is for an admin, and gamebox is not one` });
    });

    it.each([
      ['PUT', '/printers/mk4/filament', { loaded: ['PLA'] }],
      ['PUT', '/printers/mk4/status', { stopped: true, reason: 'door' }],
    ])('lets an admin %s %s', async (method, path, body) => {
      expect((await as(ADMIN, method, path, body)).status).toBe(200);
    });

    // A route nobody classified needs an admin, so forgetting one makes the shop stricter.
    it('needs an admin for a route it has never heard of', async () => {
      expect((await as(USER, 'POST', '/something-added-later')).status).toBe(403);
    });
  });

  // AIDEV-NOTE: the shop uploads to this address with that printer's key attached, so an address it
  // cannot build a request from is a fault that would otherwise surface as a paused printer hours
  // later. Refused at the point an operator can still fix it.
  describe('where a printer may be pointed', () => {
    async function add(address: string): Promise<Response> {
      return send('POST', '/printers', { name: 'mini', buildVolume: MK4, address });
    }

    it.each([
      ['octopi.local', 'it is not a URL'],
      ['', 'a printer needs an address'],
      ['   ', 'a printer needs an address'],
      ['file:///etc/passwd', 'this shop speaks http and https, not file'],
      ['ftp://octopi.local', 'this shop speaks http and https, not ftp'],
      ['http://user:secret@octopi.local', 'it carries a username and password'],
      ['http://octopi.local?key=abc', 'with nothing after them'],
      ['http://octopi.local#top', 'with nothing after them'],
    ])('refuses %p', async (address, complaint) => {
      const response = await add(address);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining(complaint) as unknown });
    });

    it.each([['http://octopi.local'], ['https://octopi.local'], ['http://127.0.0.1:5000'], ['http://octopi.local/prusa']])(
      'takes %p',
      async (address) => {
        expect((await add(address)).status).toBe(201);
      }
    );

    // Every request appends its own path, so a kept trailing slash would double the separator.
    it('keeps the address without the trailing slash it was given', async () => {
      await add('http://octopi.local/');

      expect(await (await send('POST', '/printers', { name: 'mini', buildVolume: MK4, address: 'http://octopi.local/' })).json()).toMatchObject({
        address: 'http://octopi.local',
      });
    });

    // Not checked, and deliberately: a printer over a VPN is legitimate, and only an admin may add
    // one. See PLAN.md.
    it('does not care whether the address is on this network', async () => {
      expect((await add('http://198.51.100.7')).status).toBe(201);
    });
  });

  // AIDEV-NOTE: a name reaches the spool as a directory, and DELETE removes that directory
  // recursively - so what a client may call a printer is a boundary, not a nicety. Driven over real
  // HTTP with the encoding a client would actually send: express decodes %2F before a handler sees
  // it, so a guard reading the raw URL would miss every one of these.
  describe('what a client may call a printer', () => {
    const REFUSED = ['..%2F..%2Fetc', '..%2f..%2fescape', 'mk4%2Fnested', 'back%5Cslash', 'a%00b', '%20'];

    it.each(REFUSED)('will not delete %s', async (name) => {
      const response = await send('DELETE', `/printers/${name}`, undefined);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('is not a name a printer can have') as unknown });
    });

    it.each(REFUSED)('will not load filament onto %s', async (name) => {
      expect((await send('PUT', `/printers/${name}/filament`, { loaded: ['PLA'] })).status).toBe(400);
    });

    it.each(REFUSED)('will not stop %s', async (name) => {
      expect((await send('PUT', `/printers/${name}/status`, { stopped: true, reason: 'door' })).status).toBe(400);
    });

    it.each(REFUSED)('will not add one called %s', async (name) => {
      const response = await send('POST', '/printers', { name: decodeURIComponent(name), buildVolume: MK4, address: 'http://x' });

      expect(response.status).toBe(400);
    });

    // `.` and `..` cannot arrive in a URL - express normalises them away before routing - but they
    // arrive in a BODY perfectly well, and `printers/..` is the printers directory itself.
    it.each([['.'], ['..']])('will not add one called %p, which names a directory that already exists', async (name) => {
      const response = await send('POST', '/printers', { name, buildVolume: MK4, address: 'http://x' });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('is not a name a printer can have') as unknown });
    });

    // The refusal is about the NAME, so it comes before the shop looks anything up - a 400 rather
    // than the 404 an unknown printer gets, and the same answer whether or not one exists.
    it('refuses the name rather than reporting it missing', async () => {
      const response = await send('DELETE', '/printers/..%2F..%2Fetc', undefined);

      expect(response.status).toBe(400);
      expect(response.status).not.toBe(404);
    });

    it('still takes an ordinary name', async () => {
      expect((await send('PUT', '/printers/mk4/filament', { loaded: ['PLA'] })).status).toBe(200);
    });

    // A name with a space or a '#' in it is legal and reaches the shop encoded; refusing those
    // would be the guard overreaching.
    it.each([['Prusa%20MK4'], ['mk4%23two']])('takes %s, which is only a name that needed encoding', async (name) => {
      await send('POST', '/printers', { name: decodeURIComponent(name), buildVolume: MK4, address: 'http://x' });

      expect((await send('PUT', `/printers/${name}/filament`, { loaded: ['PLA'] })).status).toBe(200);
    });
  });

  // A failure the shop did not mean is written by whatever broke, and node's filesystem errors name
  // the path they failed on - so the message is the one thing that must not go back to a caller.
  describe('when something breaks that the shop did not expect', () => {
    it('says where to look rather than what broke', async () => {
      // `jobs` as a FILE, so the mkdir every submission does fails with the spool path in its message.
      await rm(path.join(spool, 'jobs'), { recursive: true, force: true });
      await writeFile(path.join(spool, 'jobs'), 'not a directory');

      const response = await submit(playerBox);
      const said = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(said)).toEqual({ error: 'the shop could not do that, and why is in its log' });
      expect(said).not.toContain(spool);
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
