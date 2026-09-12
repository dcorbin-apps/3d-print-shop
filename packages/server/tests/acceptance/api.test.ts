import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { serve } from '../../src/api';
import { FREELY } from '../../src/attempts';
import { Callers } from '../../src/credentials';
import { digestOf, hashPassword } from '../../src/secrets';
import type { Job, JobDetails } from '../../src/Job';
import { JobStore } from '../../src/JobStore';
import { toStdout } from '../../src/log';
import { aDataDirectory, parentOf } from '../aDataDirectory';
import { layoutUnder } from '../../src/dataLayout';
import type { DataLayout } from '../../src/dataLayout';

// AIDEV-NOTE: real HTTP against a real listener on an ephemeral port, over a real data directory. There is no
// unit-level cover for the routes on purpose - what is worth proving here is what goes over the
// wire, and a multipart body handed to a fake request would prove only that the test can build one.
describe('the shop over HTTP', () => {
  let where: DataLayout;
  let shop: JobStore;
  let server: Server;
  let shopUrl: string;
  let mockChanged: jest.Mock<() => void>;
  let mockStarted: jest.Mock<(name: string) => void>;
  let mockShutDown: jest.Mock<() => void>;
  let mockKeyGiven: jest.Mock<(printer: string, key: string) => Promise<void>>;

  const MK4 = { x: 250, y: 210, z: 220 };
  const MK4_ADDRESS = 'http://octopi.local';
  const asRegistered = {
    name: 'mk4',
    buildVolume: MK4,
    api: 'octoprint',
    address: MK4_ADDRESS,
    camera: `${MK4_ADDRESS}/webcam/?action=stream`,
    loaded: [],
  };

  const playerBox: JobDetails = { filaments: ['PLA-SpaceGray'], displayName: 'Player Box' };

  // Every route names its caller, so every request here carries a token - an admin's unless the
  // test is about what a user may do.
  const ADMIN = 'dave-token';
  const USER = 'slicer-token';
  // AIDEV-NOTE: a token is held as a DIGEST now, so these are built the way the file is read rather
  // than keyed by what a request carries - `presenting()` is what turns the one into the other.
  const CALLERS = new Callers([
    { caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] },
    { caller: { id: 'slicer', name: 'slicer', role: 'user' }, credentials: [{ kind: 'token', hash: digestOf(USER) }] },
  ]);
  const AS_ADMIN = { authorization: `Bearer ${ADMIN}` };

  function as(token: string | undefined, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${shopUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function submitting(url: string, body: FormData, token: string = ADMIN): Promise<Response> {
    return fetch(`${url}/jobs`, { method: 'POST', body, headers: { authorization: `Bearer ${token}` } });
  }

  async function submit(details: unknown, gcode = 'G1 X100.000 Y100.000\n'): Promise<Response> {
    const body = new FormData();
    body.append('job', JSON.stringify(details));
    body.append('gcode', new Blob([gcode]), 'print.gcode');

    return submitting(shopUrl, body);
  }

  async function submitted(details: unknown): Promise<Job> {
    return (await submit(details)).json() as Promise<Job>;
  }

  async function ask(path: string): Promise<Response> {
    return as(ADMIN, 'GET', path);
  }

  async function send(method: string, path: string, body: unknown): Promise<Response> {
    return as(ADMIN, method, path, body);
  }

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-api-');
    shop = new JobStore(where);
    await shop.addPrinter({ name: 'mk4', buildVolume: MK4, api: 'octoprint', address: MK4_ADDRESS });

    mockChanged = jest.fn<() => void>();
    mockStarted = jest.fn<(name: string) => void>();
    mockShutDown = jest.fn<() => void>();
    mockKeyGiven = jest.fn<(printer: string, key: string) => Promise<void>>();
    mockKeyGiven.mockResolvedValue(undefined);
    server = await serve(shop, 0, {
      changed: mockChanged,
      started: mockStarted,
      shutDown: mockShutDown,
      keyGiven: mockKeyGiven,
      callers: () => CALLERS,
    });
    shopUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(parentOf(where), { recursive: true, force: true });
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

      const held = (await (await ask('/jobs')).json()) as { accessibleJobs: Job[]; totalJobs: number };

      expect(held.accessibleJobs.map((job) => job.displayName).sort()).toEqual(['Job 2', 'Player Box']);
      expect(held.totalJobs).toBe(2);
    });

    // AIDEV-NOTE: the order is the contract, not a convenience - the description is what lets a
    // hopeless job be refused before its gcode is read. Accommodating the other order means holding
    // tens of megabytes to find out they were not wanted.
    it('refuses gcode that arrives before the description', async () => {
      const body = new FormData();
      body.append('gcode', new Blob(['G1 X100.000\n']), 'print.gcode');
      body.append('job', JSON.stringify(playerBox));

      const response = await submitting(shopUrl, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'the job part has to come before the gcode part, and did not' });
    });

    it('refuses a description with no gcode beside it', async () => {
      const body = new FormData();
      body.append('job', JSON.stringify(playerBox));

      const response = await submitting(shopUrl, body);

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

    // AIDEV-NOTE: apart from `changed`, because looking for work does not pick a lost print back up
    // and nothing else tells the shop that a PERSON has been to look at this machine.
    it('names the printer an operator started', async () => {
      await send('PUT', '/printers/mk4/status', { stopped: false });

      expect(mockStarted).toHaveBeenCalledWith('mk4');
    });

    it('says nobody started a printer that was only stopped', async () => {
      await send('PUT', '/printers/mk4/status', { stopped: true, reason: 'the door is open' });

      expect(mockStarted).not.toHaveBeenCalled();
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

  // AIDEV-NOTE: the data directory IS the recovery model, so an upload that fills it loses every job the shop
  // is holding and not only the one that overflowed. These are the limits that stop that, driven
  // over real HTTP because what is being proven is where the bytes stop - not that a number was set.
  describe('a submission bigger than the shop will take', () => {
    let small: Server;
    let smallUrl: string;

    // Small enough that the test sends bytes rather than megabytes; the rule under test is the same.
    const CAP = 64;

    beforeEach(async () => {
      const store = new JobStore(where, { maxGcodeBytes: CAP });
      await store.addPrinter({ name: 'mk4', buildVolume: MK4, api: 'octoprint', address: MK4_ADDRESS });
      small = await serve(store, 0, { callers: () => CALLERS });
      smallUrl = `http://127.0.0.1:${(small.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => small.close(() => resolve()));
    });

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

      const response = await submitting(smallUrl, body);

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: `the job part is longer than ${1024 * 1024} bytes` });
    });

    it('takes one exactly as big as the cap', async () => {
      expect((await submitting(smallUrl, submission('G'.repeat(CAP)))).status).toBe(201);
    });

    it('refuses one a single byte over', async () => {
      const response = await submitting(smallUrl, submission('G'.repeat(CAP + 1)));

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: `gcode is longer than the ${CAP} bytes this shop takes` });
    });

    // busboy truncates at the cap and ends the stream as though the file were whole, so the danger
    // is not a rejected job - it is an ACCEPTED one holding half a print.
    it('keeps nothing at all of one it refused', async () => {
      await submitting(smallUrl, submission('G'.repeat(CAP + 1)));

      expect(await (await fetch(`${smallUrl}/jobs`, { headers: AS_ADMIN })).json()).toEqual({ accessibleJobs: [], totalJobs: 0 });
      await expect(readdir(where.jobs)).resolves.toEqual([]);
    });

    // Past the part count busboy discards rather than raising, which is the same thing that already
    // happens to a part with a name the shop does not read. The first gcode part is the submission.
    it('ignores a second gcode part rather than refusing a job it has already taken', async () => {
      const body = submission('G1\n');
      body.append('gcode', new Blob(['G2\n']), 'other.gcode');

      const response = await submitting(smallUrl, body);

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ id: 1, gcodeBytes: 3 });
    });
  });

  // A full disk is the machine's fault, not the client's, so it is told to come back rather than
  // told it did something wrong. Room for the BIGGEST job, because this one's size is not yet known.
  describe('when there is no room left', () => {
    it('takes nothing, and says to come back later without saying where it keeps its work', async () => {
      const lines: string[] = [];
      const full = new JobStore(where, { maxGcodeBytes: 1024, freeBytes: () => Promise.resolve(512) });
      const server = await serve(full, 0, {
        callers: () => CALLERS,
        log: toStdout(
          () => new Date(),
          (line) => lines.push(line),
        ),
      });

      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const body = new FormData();
        body.append('job', JSON.stringify(playerBox));
        body.append('gcode', new Blob(['G1\n']), 'print.gcode');

        const response = await submitting(url, body);
        const said = await response.text();

        // A 503 rather than a 4xx: a client that comes back later is doing the right thing.
        expect(response.status).toBe(503);
        expect(JSON.parse(said)).toEqual({ error: 'the shop cannot get at the work it keeps, and why is in its log' });
        expect(said).not.toContain(where.jobs);
        // The operator's half of the same event: how much room there is, and which directory has it.
        expect(lines.join('\n')).toContain(`${where.jobs} has 512 bytes free, and the shop keeps 1024 spare for a job`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // AIDEV-NOTE: the key arrives WITH the printer, in one call, because adding a machine is one act -
  // two would let a printer land without the key it is reached by. Where the key is kept is the
  // running shop's business rather than the store's, so what is asserted here is the hand-over.
  describe('the key a printer is reached by', () => {
    const mini = { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini' };
    const adding = (body: unknown, token = ADMIN): Promise<Response> => as(token, 'POST', '/printers', body);

    it('is handed to whoever keeps the keys, in the call that adds the printer', async () => {
      expect((await adding({ ...mini, key: 'mini-key' })).status).toBe(201);
      expect(mockKeyGiven).toHaveBeenCalledWith('mini', 'mini-key');
    });

    // The printer is what the caller gets back - its trouble is the thing they are waiting to clear -
    // and the key is not in it. There is no reading one back at all.
    it('is not in what the shop answers with', async () => {
      const said = JSON.stringify(await (await adding({ ...mini, key: 'mini-key' })).json());

      expect(said).toContain('mini');
      expect(said).not.toContain('mini-key');
    });

    // AIDEV-NOTE: the record is built from the four fields a printer IS, so a key in the body cannot
    // follow it into printer.json - which is a working directory rather than a credential store.
    it('never reaches the printer the shop wrote down', async () => {
      await adding({ ...mini, key: 'mini-key' });

      expect(JSON.stringify(await (await ask('/printers')).json())).not.toContain('mini-key');
    });

    it('is not required, because a printer the shop already has a key for keeps it', async () => {
      expect((await adding(mini)).status).toBe(201);
      expect(mockKeyGiven).not.toHaveBeenCalled();
    });

    // `keyIn` refuses four kinds of non-key in tests/api.test.ts. What is left here is the half it
    // cannot reach: a refused key leaves no printer behind it either.
    it('refuses a key that is no key, and adds nothing', async () => {
      expect((await adding({ ...mini, key: '' })).status).toBe(400);
      expect(mockKeyGiven).not.toHaveBeenCalled();
      expect(JSON.stringify(await (await ask('/printers')).json())).not.toContain('mini');
    });

    // A key is an admin's, like every other thing about a printer.
    it('is refused to a user outright', async () => {
      expect((await adding({ ...mini, key: 'mini-key' }, USER)).status).toBe(403);
      expect(mockKeyGiven).not.toHaveBeenCalled();
    });

    // A shop served without anywhere to keep one says so rather than taking the printer and losing
    // the key, which would be the half-added machine this route exists to avoid.
    it('is refused by a shop that was given nowhere to keep it', async () => {
      const plain = await serve(shop, 0, { callers: () => CALLERS });

      try {
        const url = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
        const response = await fetch(`${url}/printers`, {
          method: 'POST',
          headers: { ...AS_ADMIN, 'content-type': 'application/json' },
          body: JSON.stringify({ ...mini, key: 'mini-key' }),
        });

        expect(response.status).toBe(400);
        expect(JSON.stringify(await (await ask('/printers')).json())).not.toContain('mini');
      } finally {
        await new Promise<void>((resolve) => plain.close(() => resolve()));
      }
    });
  });

  // AIDEV-NOTE: a shop with somewhere to serve a page from. The files are made here rather than
  // taken from the ui package, because what the shop is given is a DIRECTORY - it knows nothing
  // about what is in one, and a test that reached for the real page would be the dependency this
  // deliberately does not have.
  describe('serving a page beside the API', () => {
    let withAPage: Server;
    let pageUrl: string;
    let page: string;

    const get = (path: string, token?: string): Promise<Response> =>
      fetch(`${pageUrl}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

    beforeEach(async () => {
      page = await mkdtemp(path.join(tmpdir(), 'print-shop-page-'));
      await writeFile(path.join(page, 'index.html'), '<!doctype html><title>the page</title>');
      await mkdir(path.join(page, 'assets'));
      await writeFile(path.join(page, 'assets', 'shop.js'), 'console.log("hello")');

      withAPage = await serve(shop, 0, { callers: () => CALLERS, page });
      pageUrl = `http://127.0.0.1:${(withAPage.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => withAPage.close(() => resolve()));
      await rm(page, { recursive: true, force: true });
    });

    // AIDEV-NOTE: without a credential, and that is the point - the page nobody is logged in to yet
    // is the page they log in ON. Requiring one would be a login screen that cannot be fetched
    // without having logged in.
    it('gives the page to somebody the shop does not know', async () => {
      const response = await get('/');

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('the page');
    });

    it('gives what the page asks for next, equally', async () => {
      const response = await get('/assets/shop.js');

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('hello');
    });

    // A page a browser navigated INTO rather than loaded at the root, then reloaded. Deliberately
    // NOT a path under one of the shop's own routes: those belong to the API whatever a browser
    // thinks, which is the next test.
    it('gives the page for a path inside it, so a reload is not a 404', async () => {
      expect(await (await get('/somewhere/the/page/went')).text()).toContain('the page');
    });

    // AIDEV-NOTE: the thing that would be a hole. Serving files at the root is one mistake away from
    // answering an API path with a page - or worse, from answering one WITHOUT the guard.
    it('does not answer the shop own routes with a page', async () => {
      expect((await get('/jobs')).status).toBe(401);
      expect((await get('/printers')).status).toBe(401);
    });

    it('still answers them properly to somebody it knows', async () => {
      expect((await get('/printers', ADMIN)).status).toBe(200);
    });

    // Nothing is served at all unless the shop was pointed somewhere, which is what a shop with no
    // page installed looks like.
    it('serves nothing of the sort when it was given nowhere to serve from', async () => {
      expect((await ask('/')).status).toBe(404);
    });
  });

  // AIDEV-NOTE: the one route reached before the shop knows who is asking, which is what makes it
  // the one worth being careful about. Over real HTTP, because half of what is being proven is in
  // the headers: what the cookie says, and that a write carrying one has to come from here.
  describe('logging in', () => {
    const PASSWORD = 'a password of some length';
    let withPasswords: Server;
    let loginUrl: string;

    const logIn = (id: string, password: string, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${loginUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ id, password }),
      });

    const cookieFrom = (response: Response): string => (response.headers.get('set-cookie') ?? '').split(';')[0];

    beforeEach(async () => {
      const hash = await hashPassword(PASSWORD);
      const known = new Callers([
        { caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'password', hash }] },
        { caller: { id: 'slicer', name: 'slicer', role: 'user' }, credentials: [{ kind: 'token', hash: digestOf(USER) }] },
      ]);

      withPasswords = await serve(shop, 0, { callers: () => known });
      loginUrl = `http://127.0.0.1:${(withPasswords.address() as AddressInfo).port}`;
    }, 15_000);

    afterEach(async () => {
      await new Promise<void>((resolve) => withPasswords.close(() => resolve()));
    });

    it('answers with the caller, so the page knows what to offer', async () => {
      const response = await logIn('dave', PASSWORD);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    }, 15_000);

    // AIDEV-NOTE: the three that matter, and the reason this is a cookie at all. HttpOnly is what a
    // script on the page cannot read - which a token kept by the page always could. SameSite=Strict
    // is what another site's form cannot make a browser send. Secure is left OFF here because the
    // request arrived over http: a shop on loopback would otherwise set a cookie never sent back.
    it('sets a session a script cannot read and another site cannot send', async () => {
      const said = (await logIn('dave', PASSWORD)).headers.get('set-cookie') ?? '';

      expect(said).toContain('HttpOnly');
      expect(said).toContain('SameSite=Strict');
      expect(said).not.toContain('Secure');
    }, 15_000);

    it('is a session that then names the caller without a token', async () => {
      const cookie = cookieFrom(await logIn('dave', PASSWORD));

      const asked = await fetch(`${loginUrl}/me`, { headers: { cookie } });

      expect(await asked.json()).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    }, 15_000);

    // AIDEV-NOTE: the same answer for a name nobody has and for a password that is wrong. Otherwise
    // the refusals are a list of which names exist, which is the half of a credential an attacker
    // does not have to guess.
    it('says the same thing to a wrong password as to a name it does not know', async () => {
      const wrong = await logIn('dave', 'not the password');
      const nobody = await logIn('nobody at all', 'not the password');

      expect(wrong.status).toBe(nobody.status);
      expect(await wrong.json()).toEqual(await nobody.json());
    }, 20_000);

    it('gives a refused login no session at all', async () => {
      expect((await logIn('dave', 'not the password')).headers.get('set-cookie')).toBeNull();
    }, 15_000);

    // A machine's token is not a password: presenting it here must not be a way in.
    it('refuses a caller who has a token and no password', async () => {
      expect((await logIn('slicer', USER)).status).toBe(401);
    }, 15_000);

    // `loginIn` refuses six shapes in tests/api.test.ts. One here, for what only a running shop can
    // say: that this route - the one reached before the shop knows anybody - puts a body through it.
    it('refuses a body that is not a login', async () => {
      const response = await fetch(`${loginUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'dave' }),
      });

      expect(response.status).toBe(400);
    });

    // AIDEV-NOTE: what stands between a password and somebody working through a list of them.
    it('makes somebody wait after enough wrong ones, and says so', async () => {
      for (let tried = 0; tried <= FREELY; tried += 1) await logIn('dave', 'not the password');

      const turned = await logIn('dave', 'not the password');

      expect(turned.status).toBe(429);
      expect(((await turned.json()) as { error: string }).error).toContain('wait');
    }, 60_000);

    describe('and logging out', () => {
      it('ends the session it was holding', async () => {
        const cookie = cookieFrom(await logIn('dave', PASSWORD));

        const out = await fetch(`${loginUrl}/sessions`, { method: 'DELETE', headers: { cookie, origin: loginUrl } });
        expect(out.status).toBe(204);

        expect((await fetch(`${loginUrl}/me`, { headers: { cookie } })).status).toBe(401);
      }, 15_000);

      it('clears the cookie as well as ending it', async () => {
        const cookie = cookieFrom(await logIn('dave', PASSWORD));

        const out = await fetch(`${loginUrl}/sessions`, { method: 'DELETE', headers: { cookie, origin: loginUrl } });

        expect(out.headers.get('set-cookie')).toContain('print-shop-session=;');
      }, 15_000);
    });

    // AIDEV-NOTE: SameSite is a rule the BROWSER keeps; this is the shop keeping it too. A cookie is
    // sent by whatever page asked, so a WRITE that arrived with one has to have come from here.
    //
    // The rule itself is `requireItCameFromHere`, unit tested over a dozen origins in tests/api.test.ts.
    // What is left here is what only a running shop can say: that the guard hands it the two headers
    // a request really arrived with, that the host half is compared rather than assumed, and that a
    // token is subject to none of it.
    describe('a write carrying a session', () => {
      it('is taken when it came from this shop', async () => {
        const cookie = cookieFrom(await logIn('dave', PASSWORD));

        const response = await fetch(`${loginUrl}/printers/mk4/filament`, {
          method: 'PUT',
          headers: { cookie, origin: loginUrl, 'content-type': 'application/json' },
          body: JSON.stringify({ loaded: ['PLA-Red'] }),
        });

        expect(response.status).toBe(200);
      }, 15_000);

      it('is refused when it came from somewhere else', async () => {
        const cookie = cookieFrom(await logIn('dave', PASSWORD));

        const response = await fetch(`${loginUrl}/printers/mk4/filament`, {
          method: 'PUT',
          headers: { cookie, origin: 'http://somewhere.else', 'content-type': 'application/json' },
          body: JSON.stringify({ loaded: ['PLA-Red'] }),
        });

        expect(response.status).toBe(403);
      }, 15_000);

      // A token is not sent by a browser on anybody's behalf, so none of this applies to one.
      it('is nothing a token has to answer for', async () => {
        const response = await as(USER, 'GET', '/jobs');

        expect(response.status).toBe(200);
      });
    });

    // AIDEV-NOTE: their OWN, which is the whole of what this route is - an operator changing somebody
    // else's is `caller password` at a terminal. The password they have now is asked for even though
    // the shop already knows who is asking, because a session is a screen somebody walked away from.
    describe('and changing your own password', () => {
      const NEW_PASSWORD = 'a different password entirely';
      const A_USERS_TOKEN = 'ada-token';
      let changing: Server;
      let changeUrl: string;
      let known: Callers;
      let mockKept: jest.Mock<(id: string, password: string) => Promise<void>>;

      const naming = async (...held: { id: string; password?: string; token?: string; role?: 'admin' | 'user' }[]): Promise<Callers> =>
        new Callers(
          await Promise.all(
            held.map(async ({ id, password, token, role = 'admin' }) => ({
              caller: { id, name: id, role },
              credentials: [
                ...(password === undefined ? [] : [{ kind: 'password' as const, hash: await hashPassword(password) }]),
                ...(token === undefined ? [] : [{ kind: 'token' as const, hash: digestOf(token) }]),
              ],
            })),
          ),
        );

      const changeTo = (
        password: string,
        current: string,
        headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` },
      ): Promise<Response> =>
        fetch(`${changeUrl}/me/password`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ current, password }),
        });

      const logInThere = (id: string, password: string): Promise<Response> =>
        fetch(`${changeUrl}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, password }),
        });

      beforeEach(async () => {
        // A user among them, because this route is one of the few open to every caller - their own
        // password is the one thing a user may change, and a shop that made it an admin's would be
        // back to nobody being able to change their own.
        const everybody = (changed?: { id: string; password: string }): Promise<Callers> => {
          const passwordOf = (id: string): string => (changed?.id === id ? changed.password : PASSWORD);

          return naming(
            { id: 'dave', password: passwordOf('dave'), token: ADMIN },
            { id: 'slicer', token: USER },
            { id: 'ada', password: passwordOf('ada'), token: A_USERS_TOKEN, role: 'user' },
          );
        };

        known = await everybody();

        // What the shop itself does with one: writes it where the callers are kept, and reads the
        // file back so that what is in force is what it now says - for the caller it was given and
        // nobody else.
        mockKept = jest.fn<(id: string, password: string) => Promise<void>>(async (id, password) => {
          known = await everybody({ id, password });
        });

        changing = await serve(shop, 0, { callers: () => known, passwordChanged: mockKept });
        changeUrl = `http://127.0.0.1:${(changing.address() as AddressInfo).port}`;
      }, 30_000);

      afterEach(async () => {
        await new Promise<void>((resolve) => changing.close(() => resolve()));
      });

      it('is what logs them in afterwards', async () => {
        expect((await changeTo(NEW_PASSWORD, PASSWORD)).status).toBe(204);

        expect((await logInThere('dave', NEW_PASSWORD)).status).toBe(201);
        expect((await logInThere('dave', PASSWORD)).status).toBe(401);
      }, 60_000);

      it('is refused, and nothing written, when the one they have now is wrong', async () => {
        const response = await changeTo(NEW_PASSWORD, 'not the password');

        expect(response.status).toBe(403);
        expect(mockKept).not.toHaveBeenCalled();
      }, 30_000);

      // The id is whoever the request turned out to be. There is no shape of body that changes
      // somebody else's - which is what keeps this open to every caller.
      it('changes the caller who asked, whoever the body names', async () => {
        await fetch(`${changeUrl}/me/password`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
          body: JSON.stringify({ id: 'slicer', current: PASSWORD, password: NEW_PASSWORD }),
        });

        expect(mockKept).toHaveBeenCalledWith('dave', NEW_PASSWORD);
      }, 30_000);

      // A caller with no password is a machine's token, and there is nothing here for it to prove.
      // Giving one their first password is an operator's act, like taking one away.
      it('refuses a caller who has a token and no password', async () => {
        const response = await changeTo(NEW_PASSWORD, PASSWORD, { authorization: `Bearer ${USER}` });

        expect(response.status).toBe(403);
        expect(mockKept).not.toHaveBeenCalled();
      }, 30_000);

      it('refuses the one they are already using', async () => {
        const response = await changeTo(PASSWORD, PASSWORD);

        expect(response.status).toBe(400);
        expect(mockKept).not.toHaveBeenCalled();
      }, 30_000);

      // `passwordChangeIn` refuses six shapes in tests/api.test.ts; one here for the wiring.
      it('refuses a body that is not a change', async () => {
        const response = await fetch(`${changeUrl}/me/password`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
          body: JSON.stringify({ current: PASSWORD }),
        });

        expect(response.status).toBe(400);
      }, 30_000);

      // AIDEV-NOTE: what a new password is FOR - somebody either forgot theirs or believes somebody
      // else has it. The browser doing the changing is kept, because asking somebody to log in again
      // for having just proved who they are is a page that punishes the safe thing.
      it('logs out every other browser, and leaves the one that asked logged in', async () => {
        const elsewhere = ((await logInThere('dave', PASSWORD)).headers.get('set-cookie') ?? '').split(';')[0];
        const here = ((await logInThere('dave', PASSWORD)).headers.get('set-cookie') ?? '').split(';')[0];

        await changeTo(NEW_PASSWORD, PASSWORD, { cookie: here, origin: changeUrl });

        expect((await fetch(`${changeUrl}/me`, { headers: { cookie: elsewhere } })).status).toBe(401);
        expect((await fetch(`${changeUrl}/me`, { headers: { cookie: here } })).status).toBe(200);
      }, 60_000);

      // The same oracle as a login - something that says whether a guess was right - so it is
      // counted the same way.
      it('makes somebody wait after enough wrong ones', async () => {
        for (let tried = 0; tried <= FREELY; tried += 1) await changeTo(NEW_PASSWORD, 'not the password');

        expect((await changeTo(NEW_PASSWORD, 'not the password')).status).toBe(429);
      }, 60_000);

      // AIDEV-NOTE: a user's own password is the whole point of this route. Made an admin's, it
      // would be back to nobody being able to change their own - which is what it is here to fix.
      it("is a user's to change as much as an admin's", async () => {
        const response = await changeTo(NEW_PASSWORD, PASSWORD, { authorization: `Bearer ${A_USERS_TOKEN}` });

        expect(response.status).toBe(204);
        expect(mockKept).toHaveBeenCalledWith('ada', NEW_PASSWORD);
      }, 30_000);

      it('is refused by a shop that was given nowhere to keep one', async () => {
        const nowhere = await serve(shop, 0, { callers: () => known });
        const nowhereUrl = `http://127.0.0.1:${(nowhere.address() as AddressInfo).port}`;

        const response = await fetch(`${nowhereUrl}/me/password`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
          body: JSON.stringify({ current: PASSWORD, password: NEW_PASSWORD }),
        });

        expect(response.status).toBe(400);
        await new Promise<void>((resolve) => nowhere.close(() => resolve()));
      }, 30_000);
    });
  });

  // AIDEV-NOTE: a client that shows a person what they may do has to be able to ask what that is.
  // The one route that answers with a name, and it is the name of whoever asked.
  describe('who the shop takes the caller to be', () => {
    it('says the caller back to them, by the token they presented', async () => {
      expect(await (await as(ADMIN, 'GET', '/me')).json()).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    });

    // The role is the whole point: it is what a UI offers or withholds a printer command by.
    it('says a user is a user', async () => {
      expect(await (await as(USER, 'GET', '/me')).json()).toEqual({ id: 'slicer', name: 'slicer', role: 'user' });
    });

    // It answers about the TOKEN, and a shop that cannot name one answers nothing at all.
    it('tells a caller it cannot name nothing', async () => {
      expect((await as('made-up', 'GET', '/me')).status).toBe(401);
    });

    // Whatever else a token buys, it does not buy the list of who else is here.
    it('says nothing about anybody else', async () => {
      expect(Object.keys((await (await as(ADMIN, 'GET', '/me')).json()) as object)).toEqual(['id', 'name', 'role']);
    });
  });

  // AIDEV-NOTE: over real HTTP because what is being proven is what a request carrying a token does,
  // and every route is reached the way a caller reaches it. The permission table is the security
  // boundary, so what a `user` may NOT do is asserted route by route rather than in the general.
  describe('who is asking', () => {
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
      ['GET', '/me'],
    ])('lets a user %s %s', async (method, path) => {
      expect((await as(USER, method, path)).status).not.toBe(403);
    });

    it('lets a user submit a job', async () => {
      const body = new FormData();
      body.append('job', JSON.stringify(playerBox));
      body.append('gcode', new Blob(['G1\n']), 'print.gcode');

      const response = await submitting(shopUrl, body, USER);

      expect(response.status).toBe(201);
    });

    it.each([
      ['POST', '/shutdown', {}],
      ['POST', '/printers', { name: 'mini', buildVolume: MK4, address: 'http://mini' }],
      ['DELETE', '/printers/mk4', undefined],
      ['PUT', '/printers/mk4/filament', { loaded: ['PLA'] }],
      ['PUT', '/printers/mk4/status', { stopped: true, reason: 'door' }],
    ])('will not let a user %s %s', async (method, path, body) => {
      const response = await as(USER, method, path, body);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: `${method} ${path} is for an admin, and slicer is not one` });
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

    // AIDEV-NOTE: express routes non-strictly, case-insensitively, and serves HEAD from a GET route
    // - so all of these reach a route a user is entitled to. Comparing the raw path refused them,
    // which failed CLOSED and so only ever broke the less privileged caller: a client using a
    // trailing slash worked on an admin token and 403'd on a user one.
    it.each([
      ['GET', '/jobs/'],
      ['GET', '/JOBS'],
      ['GET', '/printers/'],
      ['HEAD', '/jobs'],
      // A verdict is open to any caller and refused on OWNERSHIP inside the route, so what a user
      // must not meet here is a 403 about their role.
      ['PUT', '/jobs/1/verdict/'],
    ])('lets a user %s %s, which express routes to one they may have', async (method, path) => {
      expect((await as(USER, method, path)).status).not.toBe(403);
    });

    // The normalising must not open anything: a trailing slash or a shout is still an admin route.
    it.each([
      ['POST', '/shutdown/'],
      ['DELETE', '/PRINTERS/mk4'],
      ['PUT', '/printers/mk4/status/'],
    ])('still needs an admin for %s %s', async (method, path) => {
      expect((await as(USER, method, path)).status).toBe(403);
    });
  });

  // AIDEV-NOTE: a role says what a caller may DO, and this is what is THEIRS - two questions, and
  // only the second depends on the job. Everything here is decided inside the routes that name one,
  // which is why none of it is in the admin list above.
  describe('whose job it is', () => {
    const asUser = (method: string, path: string, body?: unknown): Promise<Response> => as(USER, method, path, body);

    async function submittedBy(token: string, details: JobDetails = playerBox): Promise<Job> {
      const body = new FormData();
      body.append('job', JSON.stringify(details));
      body.append('gcode', new Blob(['G1\n']), 'print.gcode');

      return (await submitting(shopUrl, body, token)).json() as Promise<Job>;
    }

    async function printedFor(token: string): Promise<number> {
      const { id } = await submittedBy(token);
      await shop.startPrinting('mk4', id);
      await shop.finishedPrinting('mk4', 'finished');

      return id;
    }

    // AIDEV-NOTE: what an install from before this has on disk. A record is written once and never
    // rewritten, so a job from then stays ownerless until it leaves - which is indistinguishable
    // from an owner who has since been revoked, and is handled as the same thing.
    async function aJobFromBeforeOwners(): Promise<number> {
      await mkdir(path.join(where.jobs, '9'), { recursive: true });
      await writeFile(
        path.join(where.jobs, '9', 'job.json'),
        JSON.stringify({ id: 9, displayName: 'Old Box', filaments: ['PLA-SpaceGray'], submittedAt: new Date().toISOString(), gcodeBytes: 3 }),
      );

      return 9;
    }

    it('is the caller who submitted it, by the id that outlives their name', async () => {
      expect(await submittedBy(USER)).toMatchObject({ owner: 'slicer' });
    });

    it('shows a caller their own work, and how much the shop holds altogether', async () => {
      await submittedBy(ADMIN);
      await submittedBy(USER, { filaments: ['PLA-Red'], displayName: 'Tray' });

      expect(await (await asUser('GET', '/jobs')).json()).toMatchObject({
        accessibleJobs: [{ displayName: 'Tray', owner: 'slicer' }],
        totalJobs: 2,
      });
    });

    it('shows an admin every job, whoever it belongs to', async () => {
      await submittedBy(USER);
      await submittedBy(ADMIN);

      expect(await (await ask('/jobs')).json()).toMatchObject({
        accessibleJobs: [{ owner: 'slicer' }, { owner: 'dave' }],
        totalJobs: 2,
      });
    });

    // AIDEV-NOTE: not theirs is answered as not here, deliberately. A 403 would tell a stranger that
    // job 1 exists, and how many jobs the shop holds is the whole of what they are meant to learn.
    it('answers a job that is not theirs as one that is not here', async () => {
      const { id } = await submittedBy(ADMIN);

      const response = await asUser('GET', `/jobs/${id}`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: `no job ${id}` });
    });

    it('lets a caller read their own', async () => {
      const { id } = await submittedBy(USER);

      expect((await asUser('GET', `/jobs/${id}`)).status).toBe(200);
    });

    it('refuses a verdict on a job that is not theirs, as one that is not here', async () => {
      const id = await printedFor(ADMIN);

      expect((await asUser('PUT', `/jobs/${id}/verdict`, { verdict: 'approved' })).status).toBe(404);
    });

    // Judging a plate is saying whether the thing you asked for came out the way you wanted, which
    // is a question only the caller who asked can answer - so a user judges their own.
    it('lets the owner judge their own print, whatever their role', async () => {
      const id = await printedFor(USER);

      expect((await asUser('PUT', `/jobs/${id}/verdict`, { verdict: 'approved' })).status).toBe(204);
    });

    // And an admin judges anybody's, which is what keeps a revoked owner's job from holding a bed
    // for good - revocation is an absence, so nothing else would ever free it.
    it('lets an admin judge a print that is not theirs', async () => {
      const id = await printedFor(USER);

      expect((await send('PUT', `/jobs/${id}/verdict`, { verdict: 'approved' })).status).toBe(204);
    });

    it('is nobody for a job written before the shop recorded an owner, leaving it to an admin', async () => {
      const id = await aJobFromBeforeOwners();

      expect((await asUser('GET', `/jobs/${id}`)).status).toBe(404);
      expect((await ask(`/jobs/${id}`)).status).toBe(200);
    });
  });

  // express.json() leaves the body undefined when there was none, and destructuring that threw a
  // TypeError the client saw as a 500 - a client's mistake reported as the shop's fault.
  // AIDEV-NOTE: the other half of the queue - what is waiting on each filament, which is what an
  // operator standing at the machine is actually asking. `nextToPrint` is the shop's own question;
  // this is theirs.
  describe('what to load next', () => {
    it('answers what the queued work is waiting for, busiest first', async () => {
      await submit({ filaments: ['PLA-Red'] });
      await submit({ filaments: ['PLA-Red'] });
      await submit(playerBox);

      expect(await (await ask('/filaments')).json()).toEqual([
        { filament: 'PLA-Red', jobs: 2 },
        { filament: 'PLA-SpaceGray', jobs: 1 },
      ]);
    });

    // It counts everybody's work, which is more than the bare total a caller who owns none of it may
    // learn - and loading a machine is already an admin's to do.
    it("is an admin's to ask, because it counts work that is not the caller's", async () => {
      expect((await as(USER, 'GET', '/filaments')).status).toBe(403);
    });

    // The operator asking is standing at a machine, and a job it could never take is not work it
    // is waiting on.
    it('answers for one machine when the request names one', async () => {
      await send('POST', '/printers', { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini.local' });
      await submit({ filaments: ['PLA-Red'], printer: 'mk4' });
      await submit({ filaments: ['PLA-White'] });

      expect(await (await ask('/filaments?printer=mini')).json()).toEqual([{ filament: 'PLA-White', jobs: 1 }]);
      expect(await (await ask('/filaments?printer=mk4')).json()).toEqual([
        { filament: 'PLA-Red', jobs: 1 },
        { filament: 'PLA-White', jobs: 1 },
      ]);
    });

    it('refuses to answer for a machine this shop does not have', async () => {
      const response = await ask('/filaments?printer=nowhere');

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('no printer called nowhere') as unknown as string });
    });

    // express reads a repeated parameter as an array, and answering for the whole shop there would
    // be the wrong answer given confidently.
    it('refuses a request that names more than one machine', async () => {
      const response = await ask('/filaments?printer=mk4&printer=mini');

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('printer names one machine') as unknown as string });
    });
  });

  describe('a request that brought no body', () => {
    it.each([
      ['PUT', '/jobs/1/verdict', 'a verdict is approved, rejected or abandoned'],
      ['PUT', '/printers/mk4/filament', 'loaded is the filaments on the machine'],
      ['PUT', '/printers/mk4/status', 'a printer status says stopped true or false'],
    ])('answers %s %s with what was missing', async (method, path, complaint) => {
      const response = await fetch(`${shopUrl}${path}`, { method, headers: AS_ADMIN });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining(complaint) as unknown });
    });

    it('says the same to a body that never claimed to be JSON', async () => {
      const response = await fetch(`${shopUrl}/printers/mk4/filament`, { method: 'PUT', body: 'loaded=PLA', headers: AS_ADMIN });

      expect(response.status).toBe(400);
    });
  });

  // AIDEV-NOTE: the shop uploads to this address with that printer's key attached, so an address it
  // cannot build a request from is a fault that would otherwise surface as a paused printer hours
  // later. Refused at the point an operator can still fix it.
  // AIDEV-NOTE: `addressIn` decides what an address may be and is unit tested over about twenty of
  // them in tests/api.test.ts. One acceptance test, for the thing a unit test cannot say: that the
  // route puts a body through it, and that a refusal comes back as a 400 and not a 500.
  describe('where a printer may be pointed', () => {
    it('puts the address in a body through the rule, and refuses it as a client error', async () => {
      const response = await send('POST', '/printers', { name: 'mini', buildVolume: MK4, address: 'file:///etc/passwd' });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('this shop speaks http and https') as unknown });
    });

    it('takes one it can reach a printer at', async () => {
      expect((await send('POST', '/printers', { name: 'mini', buildVolume: MK4, address: 'http://octopi.local' })).status).toBe(201);
    });
  });

  // AIDEV-NOTE: one per way a name ARRIVES, and no more. What `requireUsablePrinterName` does with a
  // string is a plain function and is unit tested over about twenty of them in tests/api.test.ts;
  // thirty acceptance cases here asked the same question through a socket and answered it with a
  // status code. What only a running shop can say is whether each arrival reaches the rule - a path,
  // a body and a query - and every bug this block has ever caught was one of those not doing so.
  describe('what a client may call a printer', () => {
    it('checks a name that arrives in a path', async () => {
      const response = await send('DELETE', '/printers/..%2F..%2Fetc', undefined);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('is not a name a printer can have') as unknown });
    });

    // `.` and `..` cannot arrive in a URL - express normalises them away before routing - but they
    // arrive in a BODY perfectly well, and `printers/..` is the printers directory itself.
    it('checks a name that arrives in a body, which is the only way `..` can reach the shop', async () => {
      const response = await send('POST', '/printers', { name: '..', buildVolume: MK4, address: 'http://x' });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('is not a name a printer can have') as unknown });
    });

    // The `/printers/:name` mount catches a name in a path and cannot catch one in a query, which is
    // how `?printer=../../../somewhere` came to read a printer.json outside the data directory - and
    // to say which case it was: 200 parsed, 404 absent, 500 unparseable.
    it('checks a name that arrives in a query string, not only one in a path', async () => {
      const response = await ask('/filaments?printer=../../../outside');

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('is not a name a printer can have') as unknown });
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
      // A FILE standing where the next job's directory goes, so the mkdir every submission does
      // fails with the path in its message - a fault of the machine rather than of the request.
      await writeFile(path.join(where.jobs, '1'), 'not a directory');

      const response = await submit(playerBox);
      const said = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(said)).toEqual({ error: 'the shop could not do that, and why is in its log' });
      expect(said).not.toContain(where.jobs);
    });
  });

  // The data directory is made when the shop is installed and never by the shop - so a missing one is a
  // machine that was never set up, which is the service's fault and not the client's.
  describe('when the shop was never installed', () => {
    it('says a client may as well come back later, and tells the operator which directory is missing', async () => {
      const lines: string[] = [];
      const missing = layoutUnder(path.join(parentOf(where), 'never-made'));
      const unusable = await serve(new JobStore(missing), 0, {
        callers: () => CALLERS,
        log: toStdout(
          () => new Date(),
          (line) => lines.push(line),
        ),
      });

      try {
        const response = await fetch(`http://127.0.0.1:${(unusable.address() as AddressInfo).port}/jobs`, { headers: AS_ADMIN });
        const said = await response.text();

        expect(response.status).toBe(503);
        expect(JSON.parse(said)).toEqual({ error: 'the shop cannot get at the work it keeps, and why is in its log' });
        expect(said).not.toContain(missing.jobs);
        expect(lines.join('\n')).toContain(`${missing.jobs} is not there - it is created when the shop is installed`);
      } finally {
        await new Promise<void>((resolve) => unusable.close(() => resolve()));
      }
    });
  });

  // AIDEV-NOTE: what a body may SAY is `loadedIn`, `stoppedIn`, `printerIn` and `keyIn`, each a plain
  // function over a value and each unit tested in tests/api.test.ts. What is left here is what needs
  // the store: a printer that is added and read back, one that is taken out, filament that survives
  // the round trip, and a stop an operator can see afterwards.
  describe('the printers', () => {
    it('adds one the shop did not have', async () => {
      const mini = { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini.local' };

      const response = await send('POST', '/printers', mini);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ...mini, api: 'octoprint', camera: `${mini.address}/webcam/?action=stream`, loaded: [] });
    });

    // Adding a printer that is already here changes its build volume rather than failing, so the
    // answer has to say which of the two happened.
    it('changes one it already had', async () => {
      const taller = { x: 250, y: 210, z: 270 };

      const response = await send('POST', '/printers', { name: 'mk4', buildVolume: taller, address: MK4_ADDRESS });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...asRegistered, buildVolume: taller });
    });

    it('refuses a body that is not JSON at all', async () => {
      const response = await fetch(`${shopUrl}/printers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AS_ADMIN },
        body: '{ name: mini',
      });

      expect(response.status).toBe(400);
    });

    it('takes one out of the shop', async () => {
      expect((await send('DELETE', '/printers/mk4', undefined)).status).toBe(204);
      expect(await (await ask('/printers')).json()).toEqual([]);
    });

    it('says there is no such printer when asked to remove one it does not have', async () => {
      const response = await send('DELETE', '/printers/ender', undefined);

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
  });
});
