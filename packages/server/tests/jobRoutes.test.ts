import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createApi } from '../src/api';
import { Callers } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { toStdout } from '../src/log';
import { digestOf } from '../src/secrets';
import { aDataDirectory, parentOf } from './aDataDirectory';
import { MULTIPART, drive, multipart } from './inProcess';
import { layoutUnder } from '../src/dataLayout';
import type { Job, JobDetails } from '../src/Job';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: the job routes over the real router and the real store, answering in-process. What a
// BODY may say is a function over a value in tests/api.test.ts; what is here needs the store - a job
// taken in and read back, a verdict that frees a bed, and who a job belongs to.
//
// A multipart body is built by hand, which is the input rather than the claim: what busboy makes of
// one is tests/assumptions/multipartParts.test.ts, and the one thing a socket is still needed for -
// a refusal answered while megabytes are still arriving - stays in the acceptance suite.
describe('the jobs, over the shop routes', () => {
  let where: DataLayout;
  let shop: JobStore;
  let asked: ReturnType<typeof drive>;
  let mockChanged: jest.Mock<() => void>;
  let mockStarted: jest.Mock<(name: string) => void>;
  let mockShutDown: jest.Mock<() => void>;

  const ADMIN = 'dave-token';
  const USER = 'slicer-token';
  const MK4 = { x: 250, y: 210, z: 220 };
  const MK4_ADDRESS = 'http://octopi.local';
  const playerBox: JobDetails = { filaments: ['PLA-SpaceGray'], displayName: 'Player Box' };

  const callers = new Callers([
    { caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] },
    { caller: { id: 'slicer', name: 'slicer', role: 'user' }, credentials: [{ kind: 'token', hash: digestOf(USER) }] },
  ]);

  const send = (method: string, path: string, json?: unknown): ReturnType<typeof asked> => asked(method, path, { token: ADMIN, json });
  const ask = (path: string): ReturnType<typeof asked> => asked('GET', path, { token: ADMIN });

  const submission = (details: unknown, gcode = 'G1 X100.000 Y100.000\n'): Buffer =>
    multipart([
      { name: 'job', value: JSON.stringify(details) },
      { name: 'gcode', value: gcode, filename: 'print.gcode' },
    ]);

  const submitting = (body: Buffer, token = ADMIN, driver = asked): ReturnType<typeof asked> =>
    driver('POST', '/jobs', { token, body, contentType: MULTIPART });

  const submit = (details: unknown, gcode?: string): ReturnType<typeof asked> => submitting(submission(details, gcode));
  const submitted = async (details: unknown): Promise<Job> => (await submit(details)).body as Job;

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-jobs-');
    shop = new JobStore(where);
    await shop.addPrinter({ name: 'mk4', buildVolume: MK4, api: 'octoprint', address: MK4_ADDRESS });

    mockChanged = jest.fn<() => void>();
    mockStarted = jest.fn<(name: string) => void>();
    mockShutDown = jest.fn<() => void>();
    asked = drive(createApi(shop, { changed: mockChanged, started: mockStarted, shutDown: mockShutDown, callers: () => callers }));
  });

  afterEach(async () => {
    await rm(parentOf(where), { recursive: true, force: true });
  });

  describe('submitting', () => {
    it('takes a job in and answers with what the shop now holds', async () => {
      const answer = await submit(playerBox);

      expect(answer.status).toBe(201);
      expect(answer.body).toMatchObject({
        id: 1,
        displayName: 'Player Box',
        state: 'queued',
        gcodeBytes: 'G1 X100.000 Y100.000\n'.length,
      });
    });

    it('holds each submission separately, in the order they arrived', async () => {
      await submit(playerBox);
      await submit({ filaments: ['PLA-Red'] });

      const held = (await ask('/jobs')).body as { accessibleJobs: Job[]; totalJobs: number };

      expect(held.accessibleJobs.map((job) => job.displayName).sort()).toEqual(['Job 2', 'Player Box']);
      expect(held.totalJobs).toBe(2);
    });

    // AIDEV-NOTE: the order is the contract, not a convenience - the description is what lets a
    // hopeless job be refused before its gcode is read. Accommodating the other order means holding
    // tens of megabytes to find out they were not wanted.
    it('refuses gcode that arrives before the description', async () => {
      const body = multipart([
        { name: 'gcode', value: 'G1 X100.000\n', filename: 'print.gcode' },
        { name: 'job', value: JSON.stringify(playerBox) },
      ]);

      const answer = await submitting(body);

      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ error: 'the job part has to come before the gcode part, and did not' });
    });

    it('refuses a description with no gcode beside it', async () => {
      const answer = await submitting(multipart([{ name: 'job', value: JSON.stringify(playerBox) }]));

      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ error: 'a submission needs a gcode part' });
    });

    // AIDEV-NOTE: the shop decides against this job before reading a byte of it, which leaves the
    // rest of the upload unread - and an unread file part backpressures the parser, which
    // backpressures the request. A request that stops being read is an HTTP message that never
    // completes, so the socket stays open and a shop asked to stop waits for it for ever.
    //
    // At SIZE, and the threshold is real: the body has to be bigger than what the buffers between
    // here and the parser will swallow. With the drain taken out this hands over 147,456 bytes of
    // 8,400,228 and stalls; at a few thousand lines it completes either way and proves nothing.
    //
    // This was an acceptance test for most of its life, on the grounds that only a real socket could
    // show it. That was wrong, and wrong in a way worth remembering: the first harness pushed the
    // whole body in at once, so it had no flow control to observe and a stalled reader looked exactly
    // like a finished one. The mechanism is node's streams, not TCP.
    it('is drained even when it is refused, so the request can finish', async () => {
      const tooTall = { ...playerBox, requiredBuildVolume: { x: 100, y: 100, z: 400 } };

      const answer = await submit(tooTall, 'G1 X100.000 Y100.000\n'.repeat(400_000));

      expect(answer.status).toBe(400);
      expect(answer.wasDrained()).toBe(true);
      expect(answer.handedOver()).toBeGreaterThan(8_000_000);
    }, 30_000);

    it('refuses a job no printer here has room for, saying what the shop has', async () => {
      const answer = await submit({ ...playerBox, requiredBuildVolume: { x: 100, y: 100, z: 400 } });

      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ error: 'nothing here has room for 100x100x400mm - mk4 250x210x220mm' });
    });
  });

  describe('asking after a job', () => {
    it('answers with the one asked for', async () => {
      const job = await submitted(playerBox);

      expect((await ask(`/jobs/${job.id}`)).body).toMatchObject({ id: job.id, displayName: 'Player Box' });
    });

    it('says there is no such job when there is not', async () => {
      const answer = await ask('/jobs/9');

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ error: 'no job 9' });
    });

    // What the client asked for, rather than what Number() made of it - "no job NaN" tells nobody
    // anything.
    it('says what it was asked for when the id is not a number', async () => {
      const answer = await send('PUT', '/jobs/abc/verdict', { verdict: 'approved' });

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ error: 'no job abc' });
    });
  });

  describe('a verdict', () => {
    async function awaitingApproval(): Promise<Job> {
      const job = await submitted(playerBox);
      await shop.startPrinting(await shop.printerNamed('mk4'), job.id);

      return shop.finishedPrinting(await shop.printerNamed('mk4'), 'finished');
    }

    it('approves a print, and the job leaves the shop', async () => {
      const job = await awaitingApproval();

      expect((await send('PUT', `/jobs/${job.id}/verdict`, { verdict: 'approved' })).status).toBe(204);
      expect((await ask(`/jobs/${job.id}`)).status).toBe(404);
    });

    it('rejects a print, and the job goes back to be printed again', async () => {
      const job = await awaitingApproval();

      const answer = await send('PUT', `/jobs/${job.id}/verdict`, { verdict: 'rejected' });

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ id: job.id, state: 'queued' });
    });

    it('will not judge a job that has not been printed', async () => {
      const job = await submitted(playerBox);

      const answer = await send('PUT', `/jobs/${job.id}/verdict`, { verdict: 'approved' });

      expect(answer.status).toBe(409);
      expect(answer.body).toEqual({ error: `job ${job.id} is queued, so there is no print to judge` });
    });

    it('abandons a print, and the job leaves the shop without being printed again', async () => {
      const job = await awaitingApproval();

      expect((await send('PUT', `/jobs/${job.id}/verdict`, { verdict: 'abandoned' })).status).toBe(204);
      expect((await ask(`/jobs/${job.id}`)).status).toBe(404);
    });
  });

  // AIDEV-NOTE: every change is a moment something might be startable, so the shop is told about all
  // of them rather than about a chosen few - a per-route list is the thing somebody forgets to add
  // to, and a missed wake-up is a job that sits queued for ever.
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
      const answer = await send('POST', '/shutdown', {});

      expect(answer.status).toBe(202);
      expect(answer.body).toEqual({ stopping: true });
      expect(mockShutDown).toHaveBeenCalled();
    });

    // Looking for work on the way out could start a print the shop is about to stop watching.
    it('is not a change worth looking for work over', async () => {
      await send('POST', '/shutdown', {});

      expect(mockChanged).not.toHaveBeenCalled();
    });
  });

  // AIDEV-NOTE: the data directory IS the recovery model, so an upload that fills it loses every job
  // the shop is holding and not only the one that overflowed. These are the limits that stop that.
  describe('a submission bigger than the shop will take', () => {
    // Small enough that the test sends bytes rather than megabytes; the rule under test is the same.
    const CAP = 64;
    const DESCRIPTION_CAP = 256;
    let small: ReturnType<typeof drive>;

    // A description of exactly the size asked for. Padded with ASCII, so the bytes busboy counts and
    // the characters JSON.stringify produced are the same number.
    const describedIn = (bytes: number): unknown => {
      const empty = JSON.stringify({ ...playerBox, metadata: { padding: '' } }).length;

      return { ...playerBox, metadata: { padding: 'x'.repeat(bytes - empty) } };
    };

    beforeEach(async () => {
      const store = new JobStore(where, { maxGcodeBytes: CAP });
      await store.addPrinter({ name: 'mk4', buildVolume: MK4, api: 'octoprint', address: MK4_ADDRESS });
      small = drive(createApi(store, { callers: () => callers }, { maxDescriptionBytes: DESCRIPTION_CAP }));
    });

    // The description arrives before the gcode by contract, so refusing an outsized one is refusing
    // before anything has been written - which is why this one may refuse where a part count cannot.
    it('refuses a description longer than it will read', async () => {
      const answer = await submitting(submission(describedIn(DESCRIPTION_CAP + 1), 'G1\n'), ADMIN, small);

      expect(answer.status).toBe(413);
      expect(answer.body).toEqual({ error: `the job part is longer than ${DESCRIPTION_CAP} bytes` });
    });

    // AIDEV-NOTE: busboy flags a value truncated on REACHING fieldSize rather than passing it, so
    // told the shop's own number it called this one cut when nothing had been cut - a description
    // that parsed perfectly was refused for being longer than a number it was equal to. It is told
    // one byte more than the shop allows, which is what makes this the boundary it looks like.
    it('takes a description of exactly the size it will read', async () => {
      expect((await submitting(submission(describedIn(DESCRIPTION_CAP), 'G1\n'), ADMIN, small)).status).toBe(201);
    });

    it('takes one exactly as big as the cap', async () => {
      expect((await submitting(submission(playerBox, 'G'.repeat(CAP)), ADMIN, small)).status).toBe(201);
    });

    it('refuses one a single byte over', async () => {
      const answer = await submitting(submission(playerBox, 'G'.repeat(CAP + 1)), ADMIN, small);

      expect(answer.status).toBe(413);
      expect(answer.body).toEqual({ error: `gcode is longer than the ${CAP} bytes this shop takes` });
    });

    // AIDEV-NOTE: the store refuses this, not busboy - there is no fileSize among SUBMISSION_LIMITS
    // deliberately, so nothing truncates the gcode on the way in. What is worth proving is that a
    // refusal part way through leaves NOTHING: the bytes already written are a job the shop would
    // otherwise be holding half of, and it is the data directory that pays for it.
    it('keeps nothing at all of one it refused', async () => {
      await submitting(submission(playerBox, 'G'.repeat(CAP + 1)), ADMIN, small);

      expect((await small('GET', '/jobs', { token: ADMIN })).body).toEqual({ accessibleJobs: [], totalJobs: 0 });
      await expect(readdir(where.jobs)).resolves.toEqual([]);
    });

    // Past the part count busboy discards rather than raising, which is the same thing that already
    // happens to a part with a name the shop does not read. The first gcode part is the submission.
    it('ignores a second gcode part rather than refusing a job it has already taken', async () => {
      const body = multipart([
        { name: 'job', value: JSON.stringify(playerBox) },
        { name: 'gcode', value: 'G1\n', filename: 'print.gcode' },
        { name: 'gcode', value: 'G2\n', filename: 'other.gcode' },
      ]);

      const answer = await submitting(body, ADMIN, small);

      expect(answer.status).toBe(201);
      expect(answer.body).toMatchObject({ id: 1, gcodeBytes: 3 });
    });
  });

  // A full disk is the machine's fault, not the client's, so it is told to come back rather than
  // told it did something wrong. Room for the BIGGEST job, because this one's size is not yet known.
  describe('when there is no room left', () => {
    it('takes nothing, and says to come back later without saying where it keeps its work', async () => {
      const lines: string[] = [];
      const full = new JobStore(where, { maxGcodeBytes: 1024, freeBytes: () => Promise.resolve(512) });
      const noRoom = drive(
        createApi(full, {
          callers: () => callers,
          log: toStdout(
            () => new Date(),
            (line) => lines.push(line)
          ),
        })
      );

      const answer = await submitting(submission(playerBox, 'G1\n'), ADMIN, noRoom);

      // A 503 rather than a 4xx: a client that comes back later is doing the right thing.
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual({ error: 'the shop cannot get at the work it keeps, and why is in its log' });
      expect(answer.text).not.toContain(where.jobs);
      // The operator's half of the same event: how much room there is, and which directory has it.
      expect(lines.join('\n')).toContain(`${where.jobs} has 512 bytes free, and the shop keeps 1024 spare for a job`);
    });
  });

  // AIDEV-NOTE: a role says what a caller may DO, and this is what is THEIRS - two questions, and
  // only the second depends on the job. All of it is decided inside the routes that name one, which
  // is why none of it is in the permission table.
  describe('whose job it is', () => {
    const asUser = (method: string, path: string, json?: unknown): ReturnType<typeof asked> => asked(method, path, { token: USER, json });

    const submittedBy = async (token: string, details: JobDetails = playerBox): Promise<Job> =>
      (await submitting(submission(details, 'G1\n'), token)).body as Job;

    async function printedFor(token: string): Promise<number> {
      const { id } = await submittedBy(token);
      await shop.startPrinting(await shop.printerNamed('mk4'), id);
      await shop.finishedPrinting(await shop.printerNamed('mk4'), 'finished');

      return id;
    }

    // AIDEV-NOTE: what an install from before this has on disk. A record is written once and never
    // rewritten, so a job from then stays ownerless until it leaves - which is indistinguishable
    // from an owner who has since been revoked, and is handled as the same thing.
    async function aJobFromBeforeOwners(): Promise<number> {
      await mkdir(path.join(where.jobs, '9'), { recursive: true });
      await writeFile(
        path.join(where.jobs, '9', 'job.json'),
        JSON.stringify({ id: 9, displayName: 'Old Box', filaments: ['PLA-SpaceGray'], submittedAt: new Date().toISOString(), gcodeBytes: 3 })
      );

      return 9;
    }

    it('is the caller who submitted it, by the id that outlives their name', async () => {
      expect(await submittedBy(USER)).toMatchObject({ owner: 'slicer' });
    });

    it('shows a caller their own work, and how much the shop holds altogether', async () => {
      await submittedBy(ADMIN);
      await submittedBy(USER, { filaments: ['PLA-Red'], displayName: 'Tray' });

      expect((await asUser('GET', '/jobs')).body).toMatchObject({
        accessibleJobs: [{ displayName: 'Tray', owner: 'slicer' }],
        totalJobs: 2,
      });
    });

    it('shows an admin every job, whoever it belongs to', async () => {
      await submittedBy(USER);
      await submittedBy(ADMIN);

      expect((await ask('/jobs')).body).toMatchObject({ accessibleJobs: [{ owner: 'slicer' }, { owner: 'dave' }], totalJobs: 2 });
    });

    // AIDEV-NOTE: not theirs is answered as not here, deliberately. A 403 would tell a stranger that
    // job 1 exists, and how many jobs the shop holds is the whole of what they are meant to learn.
    it('answers a job that is not theirs as one that is not here', async () => {
      const { id } = await submittedBy(ADMIN);

      const answer = await asUser('GET', `/jobs/${id}`);

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ error: `no job ${id}` });
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

  // AIDEV-NOTE: what the queue is waiting for is `waitingOn`, unit tested in tests/selection.test.ts
  // over a dozen shops. None of that is asked again here - what is left is the wiring: that the route
  // answers with what `waitingOn` made of the shop's own jobs, and that it is handed the machine the
  // query named rather than the whole shop.
  describe('what to load next', () => {
    it('answers with what the queue is waiting for', async () => {
      await submit({ filaments: ['PLA-Red'] });

      expect((await ask('/filaments')).body).toEqual([{ filament: 'PLA-Red', jobs: 1 }]);
    });

    // Two machines and a job only one of them may take, because one machine would be satisfied by a
    // route that read the query and then answered for the whole shop anyway.
    it('answers for the machine the query named, and not for the shop', async () => {
      await send('POST', '/printers', { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini.local' });
      await submit({ filaments: ['PLA-Red'], printer: 'mk4' });

      expect((await ask('/filaments?printer=mini')).body).toEqual([]);
      expect((await ask('/filaments?printer=mk4')).body).toEqual([{ filament: 'PLA-Red', jobs: 1 }]);
    });

    // The name in the query reaches the store, which is the other half of what `onePrinterName`
    // hands on - it checks that a name is USABLE and cannot know whether the shop has one.
    it('refuses to answer for a machine this shop does not have', async () => {
      const answer = await ask('/filaments?printer=nowhere');

      expect(answer.status).toBe(404);
      expect(answer.body).toMatchObject({ error: expect.stringContaining('no printer called nowhere') as unknown });
    });
  });

  // express.json() leaves the body undefined when there was none, and destructuring that threw a
  // TypeError the client saw as a 500 - a client's mistake reported as the shop's fault.
  describe('a request that brought no body', () => {
    it.each([
      ['PUT', '/jobs/1/verdict', 'a verdict is approved, rejected or abandoned'],
      ['PUT', '/printers/mk4/filament', 'loaded is the filaments on the machine'],
      ['PUT', '/printers/mk4/status', 'a printer status says stopped true or false'],
    ])('answers %s %s with what was missing', async (method, route, complaint) => {
      const answer = await asked(method, route, { token: ADMIN });

      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ error: expect.stringContaining(complaint) as unknown });
    });

    it('says the same to a body that never claimed to be JSON', async () => {
      const answer = await asked('PUT', '/printers/mk4/filament', { token: ADMIN, body: Buffer.from('loaded=PLA') });

      expect(answer.status).toBe(400);
    });
  });

  // A failure the shop did not mean is written by whatever broke, and node's filesystem errors name
  // the path they failed on - so the message is the one thing that must not go back to a caller.
  describe('when something breaks that the shop did not expect', () => {
    it('says where to look rather than what broke', async () => {
      // A FILE standing where the next job's directory goes, so the mkdir every submission does
      // fails with the path in its message - a fault of the machine rather than of the request.
      await writeFile(path.join(where.jobs, '1'), 'not a directory');

      const answer = await submit(playerBox);

      expect(answer.status).toBe(500);
      expect(answer.body).toEqual({ error: 'the shop could not do that, and why is in its log' });
      expect(answer.text).not.toContain(where.jobs);
    });
  });

  // The data directory is made when the shop is installed and never by the shop - so a missing one
  // is a machine that was never set up, which is the service's fault and not the client's.
  describe('when the shop was never installed', () => {
    it('says a client may as well come back later, and tells the operator which directory is missing', async () => {
      const lines: string[] = [];
      const missing = layoutUnder(path.join(parentOf(where), 'never-made'));
      const unusable = drive(
        createApi(new JobStore(missing), {
          callers: () => callers,
          log: toStdout(
            () => new Date(),
            (line) => lines.push(line)
          ),
        })
      );

      const answer = await unusable('GET', '/jobs', { token: ADMIN });

      expect(answer.status).toBe(503);
      expect(answer.body).toEqual({ error: 'the shop cannot get at the work it keeps, and why is in its log' });
      expect(answer.text).not.toContain(missing.jobs);
      expect(lines.join('\n')).toContain(`${missing.jobs} is not there - it is created when the shop is installed`);
    });
  });
});
