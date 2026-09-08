import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { InvalidSubmission } from '../src/Job';
import type { BuildVolume, Job, JobDetails, PrinterOutcome } from '../src/Job';
import { JobStore, MAX_GCODE_ENV, NoSuchJob, NoSuchPrinter, SpoolUnavailable, WrongState, defaultMaxGcodeBytes } from '../src/JobStore';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

// AIDEV-NOTE: a real directory, not a mocked fs. Keeping jobs on disk IS what this unit does, so a
// mock would test the mock - the same distinction design/testing.md draws for the golden store.
describe('JobStore', () => {
  let spool: string;
  let shop: JobStore;

  const gcode = (text = 'G1 X0 Y0\n'): Readable => Readable.from([text]);

  // Every submission carries a caller: the shop answers nobody it cannot name, so there is no such
  // thing as a job that arrived unowned. Whose it is matters in `who a job belongs to` below; the
  // rest of these say it once, here.
  const DAVE = 'u-dave';

  const submit = (details: JobDetails, gcode: Readable, owner: string = DAVE): Promise<Job> => shop.submit(details, gcode, owner);

  function details(overrides: Partial<JobDetails> = {}): JobDetails {
    return { filaments: ['PLA-SpaceGray'], ...overrides };
  }

  async function addPrinter(name: string, buildVolume: BuildVolume): Promise<void> {
    await shop.addPrinter({ name, buildVolume, api: 'octoprint', address: `http://${name}` });
  }

  async function held(store: JobStore = shop): Promise<string[]> {
    return (await store.all()).map((job) => `${job.id}:${job.displayName}:${job.state}`).sort();
  }

  beforeEach(async () => {
    spool = await fs.mkdtemp(path.join(tmpdir(), 'print-shop-'));
    shop = new JobStore(spool);
    // A shop with no printers accepts nothing, so every one of these needs one.
    await addPrinter('mk4', { x: 250, y: 210, z: 220 });
  });

  afterEach(async () => {
    await fs.rm(spool, { recursive: true, force: true });
  });

  describe('taking a job in', () => {
    it('issues ids in order', async () => {
      const first = await submit(details(), gcode());
      const second = await submit(details(), gcode());

      expect([first.id, second.id]).toEqual([1, 2]);
    });

    it('keeps the display name a client gave it', async () => {
      const job = await submit(details({ displayName: 'Player Box' }), gcode());

      expect(job.displayName).toBe('Player Box');
    });

    it('names a job the client did not', async () => {
      const job = await submit(details(), gcode());

      expect(job.displayName).toBe('Job 1');
    });

    // AIDEV-NOTE: written with the record and never again - the record is written once, so an owner
    // is for the life of the job. It is the caller's ID rather than their name for the same reason:
    // a name may be retyped, and a record that cannot be rewritten could not follow it.
    it('records who submitted it, and still says so after a restart', async () => {
      const { id } = await submit(details(), gcode(), 'u-slicer');

      expect((await new JobStore(spool).find(id))?.owner).toBe('u-slicer');
    });

    it('starts a job queued, with nothing printed yet', async () => {
      const job = await submit(details(), gcode());

      expect(job).toMatchObject({ state: 'queued' });
    });

    // Carried, never interpreted - it is how a client keeps its own meaning attached.
    it('carries the metadata, remote path and printer through untouched', async () => {
      const job = await submit(
        details({ remotePath: 'plates/cards.gcode', printer: 'mk4', metadata: { pieces: [{ piece: 'cards' }] } }),
        gcode()
      );

      expect(await shop.find(job.id)).toMatchObject({
        remotePath: 'plates/cards.gcode',
        printer: 'mk4',
        metadata: { pieces: [{ piece: 'cards' }] },
      });
    });

    // Counted as it is written, rather than taken on trust from a client - what is recorded is what
    // actually arrived, which is also what would betray a truncated file.
    it.each([
      ['G1 X0\n', 6],
      ['G1 X0 Y0 E1\n', 12],
    ])('records how many bytes of %p arrived', async (text, expected) => {
      const job = await submit(details(), gcode(text));

      expect(job.gcodeBytes).toBe(expected);
    });

    it('hands the gcode back when something is about to print it', async () => {
      const job = await submit(details(), gcode('G1 X0 Y0\n'));

      expect((await readAll(await shop.gcodeStream(job.id))).toString()).toBe('G1 X0 Y0\n');
    });

    it('refuses details it can see are wrong before reading the stream', async () => {
      await expect(submit(details({ filaments: [] }), gcode())).rejects.toThrow(InvalidSubmission);
    });
  });

  describe('a submission that does not complete', () => {
    const brokenStream = (): Readable =>
      Readable.from(
        (function* () {
          yield 'G1 X0';
          throw new Error('the link died');
        })()
      );

    it('refuses a stream that delivers nothing', async () => {
      await expect(submit(details(), Readable.from([]))).rejects.toThrow('delivered none');
    });

    // AIDEV-NOTE: the point of writing the record LAST. A half-delivered job that stayed on disk
    // would need reaping later; there is nothing to reap because it was never visible.
    it.each([
      ['delivered nothing', (): Readable => Readable.from([])],
      ['died part way', brokenStream],
    ])('leaves nothing behind when the stream %s', async (_case, stream) => {
      await expect(submit(details(), stream())).rejects.toThrow();

      expect(await shop.all()).toEqual([]);
      await expect(fs.readdir(path.join(spool, 'jobs'))).resolves.toEqual([]);
    });

    // AIDEV-NOTE: ten, because the directory names are read back as STRINGS and the disk hands them
    // over in its own order - "10" sorts before "2". Fewer jobs than that and a listing that never
    // sorted at all would look right.
    it('lists what it holds in the order it took them, not the order the disk gives them', async () => {
      for (let taken = 0; taken < 10; taken++) await submit(details(), gcode());

      expect((await shop.all()).map((job) => job.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    // A number that once named a job must never name a different one.
    it('spends the id of a job that failed rather than reusing it', async () => {
      await expect(submit(details(), Readable.from([]))).rejects.toThrow();

      expect((await submit(details(), gcode())).id).toBe(2);
    });
  });

  describe('through a print', () => {
    let id: number;

    const recordOnDisk = (): Promise<string> => fs.readFile(path.join(spool, 'jobs', String(id), 'job.json'), 'utf-8');

    beforeEach(async () => {
      id = (await submit(details(), gcode())).id;
    });

    // AIDEV-NOTE: the claim the whole model rests on. A job is printing because a PRINTER says it is
    // holding it to print; nothing about the job itself changed, so there is no second answer to
    // reconcile and starting a print is one write.
    it('leaves the job exactly as submitted, all the way to its verdict', async () => {
      const asSubmitted = await recordOnDisk();

      await shop.startPrinting('mk4', id);
      await shop.finishedPrinting('mk4', 'failed');
      await shop.reject(id);

      expect(await recordOnDisk()).toBe(asSubmitted);
    });

    it('is printing because the printer says it is holding it to print', async () => {
      expect(await shop.startPrinting('mk4', id)).toMatchObject({ state: 'printing', heldBy: 'mk4' });
      expect((await shop.printerNamed('mk4')).holding).toEqual({ job: id, phase: 'printing' });
    });

    // AIDEV-NOTE: written after the upload rather than with the holding, because until the machine
    // has answered nobody knows where the file went. What watches the print matches on that string.
    it('records where the printer said it filed the gcode', async () => {
      await shop.startPrinting('mk4', id);

      await shop.printingAt('mk4', 'plates/umlaut.gcode');

      expect((await shop.printerNamed('mk4')).holding).toEqual({ job: id, phase: 'printing', remotePath: 'plates/umlaut.gcode' });
    });

    // A print is watched to its end from a holding that has by then moved phase, so a path lost on
    // the way would be lost exactly when a restart needed it.
    it('still has that path once the print has ended', async () => {
      await shop.startPrinting('mk4', id);
      await shop.printingAt('mk4', 'plates/umlaut.gcode');

      await shop.finishedPrinting('mk4', 'finished');

      expect((await shop.printerNamed('mk4')).holding?.remotePath).toBe('plates/umlaut.gcode');
    });

    it('refuses to record one for a printer that is printing nothing', async () => {
      await expect(shop.printingAt('mk4', 'plates/umlaut.gcode')).rejects.toThrow(WrongState);
    });

    // The printer never took it: nothing was printed, so it lets go and the job is queued again by
    // not being held.
    it('queues a job the printer never started again, by letting go of it', async () => {
      await shop.startPrinting('mk4', id);
      await shop.couldNotStart('mk4');

      expect(await shop.find(id)).toMatchObject({ state: 'queued' });
      expect((await shop.printerNamed('mk4')).holding).toBeUndefined();
    });

    // AIDEV-NOTE: `finished` is not approval. A print can run to the end and still be unusable, so
    // every ending waits for a human - which is also why the gcode is still here, and why the
    // printer goes on holding it: the bed is not clear either.
    it.each<[PrinterOutcome]>([['finished'], ['failed'], ['cancelled']])(
      'waits for a verdict however the printer ended it (%s)',
      async (outcome) => {
        await shop.startPrinting('mk4', id);

        expect(await shop.finishedPrinting('mk4', outcome)).toMatchObject({
          state: 'awaiting-approval',
          lastPrinterOutcome: outcome,
        });
      }
    );

    it('sends a rejected print back to the queue, and frees the printer', async () => {
      await shop.startPrinting('mk4', id);
      await shop.finishedPrinting('mk4', 'finished');

      expect(await shop.reject(id)).toMatchObject({ state: 'queued' });
      expect((await shop.printerNamed('mk4')).holding).toBeUndefined();
    });

    it('still has the gcode for a rejected print to be run again from', async () => {
      await shop.startPrinting('mk4', id);
      await shop.finishedPrinting('mk4', 'failed');
      await shop.reject(id);

      expect((await readAll(await shop.gcodeStream(id))).length).toBeGreaterThan(0);
    });

    // Approved work leaves the shop entirely - it holds what is outstanding, not what was done.
    it('removes an approved job, gcode and record together, and frees the printer', async () => {
      await shop.startPrinting('mk4', id);
      await shop.finishedPrinting('mk4', 'finished');

      await shop.approve(id);

      expect(await shop.find(id)).toBeUndefined();
      await expect(fs.readdir(path.join(spool, 'jobs'))).resolves.toEqual([]);
      expect((await shop.printerNamed('mk4')).holding).toBeUndefined();
    });

    // Abandoning is approving in what it does to the shop and the opposite of it in what it means:
    // there is no good print, and no reprint either.
    it('removes an abandoned job the same way, and frees the printer', async () => {
      await shop.startPrinting('mk4', id);
      await shop.finishedPrinting('mk4', 'failed');

      await shop.abandon(id);

      expect(await shop.find(id)).toBeUndefined();
      expect((await shop.printerNamed('mk4')).holding).toBeUndefined();
    });

    it('does not hand out the id of an approved job again', async () => {
      await shop.startPrinting('mk4', id);
      await shop.finishedPrinting('mk4', 'finished');
      await shop.approve(id);

      expect((await submit(details(), gcode())).id).toBe(2);
    });
  });

  // AIDEV-NOTE: no printer here reports its own filament - SpoolManager existed once and is gone -
  // so this is the operator's word, and the only record of what a machine can print right now.
  describe('what is loaded', () => {
    it('has nothing loaded until somebody says otherwise', async () => {
      expect((await shop.printerNamed('mk4')).loaded).toEqual([]);
    });

    it('remembers what was loaded, in the order it was given', async () => {
      await shop.load('mk4', ['PLA-Red', 'PLA-Blue']);

      expect((await shop.printerNamed('mk4')).loaded).toEqual(['PLA-Red', 'PLA-Blue']);
    });

    it('takes an empty list for a machine with nothing on it', async () => {
      await shop.load('mk4', ['PLA-Red']);
      await shop.load('mk4', []);

      expect((await shop.printerNamed('mk4')).loaded).toEqual([]);
    });

    // Re-adding a printer is how an operator corrects its address or its bed, and it must not make
    // the shop forget what is on the machine.
    it('still knows what is loaded after the printer is added again', async () => {
      await shop.load('mk4', ['PLA-Red']);
      await addPrinter('mk4', { x: 250, y: 210, z: 220 });

      expect((await shop.printerNamed('mk4')).loaded).toEqual(['PLA-Red']);
    });

    it('is still loaded after a restart', async () => {
      await shop.load('mk4', ['PLA-Red']);

      expect((await new JobStore(spool).printerNamed('mk4')).loaded).toEqual(['PLA-Red']);
    });
  });

  describe('a move the lifecycle does not allow', () => {
    it('refuses a second job on a printer that is already holding one', async () => {
      const { id } = await submit(details(), gcode());
      const other = await submit(details(), gcode());
      await shop.startPrinting('mk4', id);

      await expect(shop.startPrinting('mk4', other.id)).rejects.toThrow(WrongState);
    });

    // Two printers, because one would be satisfied by refusing every second start.
    it('refuses to start a job another printer is already holding', async () => {
      await addPrinter('mini', { x: 180, y: 180, z: 180 });
      const { id } = await submit(details(), gcode());
      await shop.startPrinting('mk4', id);

      await expect(shop.startPrinting('mini', id)).rejects.toThrow(WrongState);
    });

    it('refuses to start anything on a printer that is stopped', async () => {
      const { id } = await submit(details(), gcode());
      await shop.pause('mk4', 'the door is open');

      await expect(shop.startPrinting('mk4', id)).rejects.toThrow(WrongState);
    });

    // The scheduler would never choose this pairing, but the store is what makes it impossible: a
    // job claiming mk4 is not mini's to start, however it was asked for.
    it('refuses to start a job on a printer that could not take it', async () => {
      await addPrinter('mini', { x: 180, y: 180, z: 180 });
      const { id } = await submit(details({ printer: 'mk4' }), gcode());

      await expect(shop.startPrinting('mini', id)).rejects.toThrow(WrongState);
    });

    it('refuses to finish a print that never started', async () => {
      await submit(details(), gcode());

      await expect(shop.finishedPrinting('mk4', 'finished')).rejects.toThrow(WrongState);
    });

    // Nothing has been printed to judge.
    it.each<['approve' | 'reject' | 'abandon']>([['approve'], ['reject'], ['abandon']])(
      'refuses to %s a job still queued',
      async (verdict) => {
        const { id } = await submit(details(), gcode());

        await expect(shop[verdict](id)).rejects.toThrow(WrongState);
      }
    );

    // The machine is still printing it. Letting the printer go would queue the job for a second
    // machine while the first is still running it.
    it('refuses to take a printer out of the shop while it is holding work', async () => {
      const { id } = await submit(details(), gcode());
      await shop.startPrinting('mk4', id);

      await expect(shop.removePrinter('mk4')).rejects.toThrow(WrongState);
    });

    it('says which job it cannot find', async () => {
      await expect(shop.startPrinting('mk4', 404)).rejects.toThrow(NoSuchJob);
    });
  });

  // AIDEV-NOTE: stopping is a property of the PRINTER, so one broken machine does not idle a
  // working one. Remembered across a restart: restarting is not evidence the fault is gone, and
  // coming back up working would hide the reason somebody needs to see.
  describe('stopping a printer', () => {
    beforeEach(async () => {
      await addPrinter('mini', { x: 180, y: 180, z: 180 });
    });

    it('runs until something stops it', async () => {
      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    it('says why it stopped', async () => {
      await shop.pause('mk4', 'the printer is unreachable');

      expect((await shop.printerNamed('mk4')).paused).toMatchObject({ reason: 'the printer is unreachable' });
    });

    it('runs again when told to', async () => {
      await shop.pause('mk4', 'the printer is unreachable');
      await shop.resume('mk4');

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    // Two printers, because one would be satisfied by stopping everything.
    it('stops only the printer named', async () => {
      await shop.pause('mk4', 'the door is open');

      expect((await shop.printerNamed('mk4')).paused).toBeDefined();
      expect((await shop.printerNamed('mini')).paused).toBeUndefined();
    });

    it('keeps one printer stopped while another is started again', async () => {
      await shop.pause('mk4', 'out of filament');
      await shop.pause('mini', 'the door is open');
      await shop.resume('mk4');

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
      expect((await shop.printerNamed('mini')).paused).toMatchObject({ reason: 'the door is open' });
    });

    it('replaces the reason rather than stopping twice', async () => {
      await shop.pause('mk4', 'out of filament');
      await shop.pause('mk4', 'the door is open');

      expect((await shop.printerNamed('mk4')).paused).toMatchObject({ reason: 'the door is open' });
    });

    it('is still stopped after a restart', async () => {
      await shop.pause('mk4', 'the printer is unreachable');

      expect((await new JobStore(spool).printerNamed('mk4')).paused).toMatchObject({
        reason: 'the printer is unreachable',
      });
    });

    it('records when it stopped', async () => {
      await shop.pause('mk4', 'the printer is unreachable');

      expect((await shop.printerNamed('mk4')).paused?.since).toBeInstanceOf(Date);
    });

    it('will not stop a printer it does not have', async () => {
      await expect(shop.pause('ender', 'anything')).rejects.toThrow(NoSuchPrinter);
    });
  });

  // AIDEV-NOTE: a job no printer could ever take is refused on the way in rather than left to sit.
  // A client told at submission can do something about it; one whose job silently starves cannot.
  describe('what the shop will accept', () => {
    it('refuses everything when it has no printers at all', async () => {
      const empty = new JobStore(await fs.mkdtemp(path.join(tmpdir(), 'print-shop-empty-')));

      await expect(empty.submit(details(), gcode(), DAVE)).rejects.toThrow('no printers');
    });

    it('refuses a job for a printer it does not have, naming the ones it does', async () => {
      await expect(submit(details({ printer: 'ender' }), gcode())).rejects.toThrow(
        'no printer called ender - this shop has mk4'
      );
    });

    it('refuses a job too big for anything here, saying how big everything is', async () => {
      const tall = details({ requiredBuildVolume: { x: 100, y: 100, z: 400 } });

      await expect(submit(tall, gcode())).rejects.toThrow('nothing here has room for 100x100x400mm');
    });

    // Two sizes, because one would be satisfied by refusing everything that names a volume.
    it('takes a job that fits', async () => {
      const fits = details({ requiredBuildVolume: { x: 240, y: 200, z: 100 } });

      await expect(submit(fits, gcode())).resolves.toMatchObject({ id: 1 });
    });

    it('takes a job that asked for no particular room', async () => {
      await expect(submit(details(), gcode())).resolves.toMatchObject({ id: 1 });
    });
  });

  describe('across a restart', () => {
    // AIDEV-NOTE: the load-bearing test. A second store over the same directory is what a restarted
    // service is, and it must find everything by scanning - there is no index to rebuild.
    it('finds the jobs a previous run left, in the states it left them', async () => {
      const printing = await submit(details({ displayName: 'Player Box' }), gcode());
      await submit(details(), gcode());
      await shop.startPrinting('mk4', printing.id);

      expect(await held(new JobStore(spool))).toEqual(['1:Player Box:printing', '2:Job 2:queued']);
    });

    it('goes on issuing ids where the previous run stopped', async () => {
      await submit(details(), gcode());

      expect((await new JobStore(spool).submit(details(), gcode(), DAVE)).id).toBe(2);
    });

    it('still has the gcode a previous run stored', async () => {
      const { id } = await submit(details(), gcode('G1 X42\n'));

      expect((await readAll(await new JobStore(spool).gcodeStream(id))).toString()).toBe('G1 X42\n');
    });
  });

  // AIDEV-NOTE: /var/spool/cups is made at install time and owned by the service's user. A missing
  // root means a machine that was never set up, and creating one would put the shop's work
  // somewhere nobody is looking.
  // AIDEV-NOTE: integrity before secrecy. A spool another user can write is one where a job's gcode
  // can be swapped for different gcode, and the shop sends what is there to a printer unquestioned.
  describe('what the shop leaves on disk', () => {
    async function modeOf(...where: string[]): Promise<string> {
      return ((await fs.stat(path.join(spool, ...where))).mode & 0o777).toString(8);
    }

    it('keeps a job to itself, directory and contents', async () => {
      await submit(details({ displayName: 'Player Box' }), gcode());

      expect(await modeOf('jobs', '1')).toBe('700');
      expect(await modeOf('jobs', '1', 'print.gcode')).toBe('600');
      expect(await modeOf('jobs', '1', 'job.json')).toBe('600');
    });

    it('keeps a printer to itself, record and status alike', async () => {
      await shop.load('mk4', ['PLA']);

      expect(await modeOf('printers', 'mk4')).toBe('700');
      expect(await modeOf('printers', 'mk4', 'printer.json')).toBe('600');
      expect(await modeOf('printers', 'mk4', 'status.json')).toBe('600');
    });

    // Written by the same atomic rename as everything else, so it is easy to miss.
    it('keeps the id counter to itself', async () => {
      await submit(details(), gcode());

      expect(await modeOf('next-id')).toBe('600');
    });
  });

  describe('when the spool is not there', () => {
    const absent = (): JobStore => new JobStore(path.join(tmpdir(), 'print-shop-that-was-never-installed'));

    it.each([
      ['listing', (store: JobStore) => store.all()],
      ['finding', (store: JobStore) => store.find(1)],
      ['submitting', (store: JobStore) => store.submit({ filaments: ['PLA'] }, Readable.from(['G1']), DAVE)],
      // Asked at startup, so a service refuses to START rather than refusing to serve.
      ['starting up', (store: JobStore) => store.ready()],
    ])('refuses rather than creating one when %s', async (_case, act) => {
      await expect(act(absent())).rejects.toThrow(SpoolUnavailable);
    });

    it('does not create the directory it refused to use', async () => {
      const store = absent();
      await expect(store.all()).rejects.toThrow();

      await expect(fs.stat(path.join(tmpdir(), 'print-shop-that-was-never-installed'))).rejects.toThrow();
    });
  });

  // AIDEV-NOTE: the root's own mode, which the installer sets and the shop only checks. Everything
  // the shop creates below it is already 0700 and 0600, and none of that survives a root out of
  // which a whole job directory can be renamed.
  describe('when the spool is one somebody else could write', () => {
    it.each([
      ['anybody', 0o777],
      ['its group', 0o770],
      ['anybody, without letting them look', 0o722],
    ])('refuses to start when %s could write it', async (_who, mode) => {
      await fs.chmod(spool, mode);

      await expect(shop.ready()).rejects.toThrow(SpoolUnavailable);
    });

    it('says the mode it found, which is what the operator has to change', async () => {
      await fs.chmod(spool, 0o777);

      await expect(shop.ready()).rejects.toThrow('(mode 777)');
    });

    // Reading gives up the ids of the jobs held and nothing else, since every record and every gcode
    // is 0600 - and refusing it would stop a shop installed 0750 for an operators' group, which is a
    // working install rather than a fault.
    it.each([
      ['nobody else', 0o700],
      ['a group that may read it', 0o750],
      ['anybody who may read it', 0o755],
    ])('starts over one %s could write', async (_who, mode) => {
      await fs.chmod(spool, mode);

      await expect(shop.ready()).resolves.toBeUndefined();
    });
  });
});

describe('the largest gcode a shop takes', () => {
  const wasSaid = process.env[MAX_GCODE_ENV];

  afterEach(() => {
    if (wasSaid === undefined) delete process.env[MAX_GCODE_ENV];
    else process.env[MAX_GCODE_ENV] = wasSaid;
  });

  it('is 128MB when nothing says otherwise', () => {
    delete process.env[MAX_GCODE_ENV];
    expect(defaultMaxGcodeBytes()).toBe(128 * 1024 * 1024);
  });

  it('is what the environment says, in megabytes', () => {
    process.env[MAX_GCODE_ENV] = '512';
    expect(defaultMaxGcodeBytes()).toBe(512 * 1024 * 1024);
  });

  // A shop that refused every job, or read a typo as one, is worse than one using its default.
  it.each([['0'], ['plenty'], ['']])('falls back to the default when told %p', (said) => {
    process.env[MAX_GCODE_ENV] = said;
    expect(defaultMaxGcodeBytes()).toBe(128 * 1024 * 1024);
  });
});
