import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { InvalidSubmission } from '../src/Job';
import type { BuildVolume, JobDetails, PrinterOutcome } from '../src/Job';
import { JobStore, NoSuchJob, NoSuchPrinter, SpoolUnavailable, WrongState } from '../src/JobStore';

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
      const first = await shop.submit(details(), gcode());
      const second = await shop.submit(details(), gcode());

      expect([first.id, second.id]).toEqual([1, 2]);
    });

    it('keeps the display name a client gave it', async () => {
      const job = await shop.submit(details({ displayName: 'Player Box' }), gcode());

      expect(job.displayName).toBe('Player Box');
    });

    it('names a job the client did not', async () => {
      const job = await shop.submit(details(), gcode());

      expect(job.displayName).toBe('Job 1');
    });

    it('starts a job queued, with nothing printed yet', async () => {
      const job = await shop.submit(details(), gcode());

      expect(job).toMatchObject({ state: 'queued' });
    });

    // Carried, never interpreted - it is how a client keeps its own meaning attached.
    it('carries the metadata, remote path and printer through untouched', async () => {
      const job = await shop.submit(
        details({ remotePath: 'gamebox/cards.gcode', printer: 'mk4', metadata: { pieces: [{ piece: 'cards' }] } }),
        gcode()
      );

      expect(await shop.find(job.id)).toMatchObject({
        remotePath: 'gamebox/cards.gcode',
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
      const job = await shop.submit(details(), gcode(text));

      expect(job.gcodeBytes).toBe(expected);
    });

    it('hands the gcode back when something is about to print it', async () => {
      const job = await shop.submit(details(), gcode('G1 X0 Y0\n'));

      expect((await readAll(await shop.gcodeStream(job.id))).toString()).toBe('G1 X0 Y0\n');
    });

    it('refuses details it can see are wrong before reading the stream', async () => {
      await expect(shop.submit(details({ filaments: [] }), gcode())).rejects.toThrow(InvalidSubmission);
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
      await expect(shop.submit(details(), Readable.from([]))).rejects.toThrow('delivered none');
    });

    // AIDEV-NOTE: the point of writing the record LAST. A half-delivered job that stayed on disk
    // would need reaping later; there is nothing to reap because it was never visible.
    it.each([
      ['delivered nothing', (): Readable => Readable.from([])],
      ['died part way', brokenStream],
    ])('leaves nothing behind when the stream %s', async (_case, stream) => {
      await expect(shop.submit(details(), stream())).rejects.toThrow();

      expect(await shop.all()).toEqual([]);
      await expect(fs.readdir(path.join(spool, 'jobs'))).resolves.toEqual([]);
    });

    // AIDEV-NOTE: ten, because the directory names are read back as STRINGS and the disk hands them
    // over in its own order - "10" sorts before "2". Fewer jobs than that and a listing that never
    // sorted at all would look right.
    it('lists what it holds in the order it took them, not the order the disk gives them', async () => {
      for (let taken = 0; taken < 10; taken++) await shop.submit(details(), gcode());

      expect((await shop.all()).map((job) => job.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    // A number that once named a job must never name a different one.
    it('spends the id of a job that failed rather than reusing it', async () => {
      await expect(shop.submit(details(), Readable.from([]))).rejects.toThrow();

      expect((await shop.submit(details(), gcode())).id).toBe(2);
    });
  });

  describe('through a print', () => {
    let id: number;

    const recordOnDisk = (): Promise<string> => fs.readFile(path.join(spool, 'jobs', String(id), 'job.json'), 'utf-8');

    beforeEach(async () => {
      id = (await shop.submit(details(), gcode())).id;
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

    it('does not hand out the id of an approved job again', async () => {
      await shop.startPrinting('mk4', id);
      await shop.finishedPrinting('mk4', 'finished');
      await shop.approve(id);

      expect((await shop.submit(details(), gcode())).id).toBe(2);
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
      const { id } = await shop.submit(details(), gcode());
      const other = await shop.submit(details(), gcode());
      await shop.startPrinting('mk4', id);

      await expect(shop.startPrinting('mk4', other.id)).rejects.toThrow(WrongState);
    });

    // Two printers, because one would be satisfied by refusing every second start.
    it('refuses to start a job another printer is already holding', async () => {
      await addPrinter('mini', { x: 180, y: 180, z: 180 });
      const { id } = await shop.submit(details(), gcode());
      await shop.startPrinting('mk4', id);

      await expect(shop.startPrinting('mini', id)).rejects.toThrow(WrongState);
    });

    it('refuses to start anything on a printer that is stopped', async () => {
      const { id } = await shop.submit(details(), gcode());
      await shop.pause('mk4', 'the door is open');

      await expect(shop.startPrinting('mk4', id)).rejects.toThrow(WrongState);
    });

    // The scheduler would never choose this pairing, but the store is what makes it impossible: a
    // job claiming mk4 is not mini's to start, however it was asked for.
    it('refuses to start a job on a printer that could not take it', async () => {
      await addPrinter('mini', { x: 180, y: 180, z: 180 });
      const { id } = await shop.submit(details({ printer: 'mk4' }), gcode());

      await expect(shop.startPrinting('mini', id)).rejects.toThrow(WrongState);
    });

    it('refuses to finish a print that never started', async () => {
      await shop.submit(details(), gcode());

      await expect(shop.finishedPrinting('mk4', 'finished')).rejects.toThrow(WrongState);
    });

    // Nothing has been printed to judge.
    it.each<['approve' | 'reject']>([['approve'], ['reject']])('refuses to %s a job still queued', async (verdict) => {
      const { id } = await shop.submit(details(), gcode());

      await expect(shop[verdict](id)).rejects.toThrow(WrongState);
    });

    // The machine is still printing it. Letting the printer go would queue the job for a second
    // machine while the first is still running it.
    it('refuses to take a printer out of the shop while it is holding work', async () => {
      const { id } = await shop.submit(details(), gcode());
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

      await expect(empty.submit(details(), gcode())).rejects.toThrow('no printers');
    });

    it('refuses a job for a printer it does not have, naming the ones it does', async () => {
      await expect(shop.submit(details({ printer: 'ender' }), gcode())).rejects.toThrow(
        'no printer called ender - this shop has mk4'
      );
    });

    it('refuses a job too big for anything here, saying how big everything is', async () => {
      const tall = details({ requiredBuildVolume: { x: 100, y: 100, z: 400 } });

      await expect(shop.submit(tall, gcode())).rejects.toThrow('nothing here has room for 100x100x400mm');
    });

    // Two sizes, because one would be satisfied by refusing everything that names a volume.
    it('takes a job that fits', async () => {
      const fits = details({ requiredBuildVolume: { x: 240, y: 200, z: 100 } });

      await expect(shop.submit(fits, gcode())).resolves.toMatchObject({ id: 1 });
    });

    it('takes a job that asked for no particular room', async () => {
      await expect(shop.submit(details(), gcode())).resolves.toMatchObject({ id: 1 });
    });
  });

  describe('across a restart', () => {
    // AIDEV-NOTE: the load-bearing test. A second store over the same directory is what a restarted
    // service is, and it must find everything by scanning - there is no index to rebuild.
    it('finds the jobs a previous run left, in the states it left them', async () => {
      const printing = await shop.submit(details({ displayName: 'Player Box' }), gcode());
      await shop.submit(details(), gcode());
      await shop.startPrinting('mk4', printing.id);

      expect(await held(new JobStore(spool))).toEqual(['1:Player Box:printing', '2:Job 2:queued']);
    });

    it('goes on issuing ids where the previous run stopped', async () => {
      await shop.submit(details(), gcode());

      expect((await new JobStore(spool).submit(details(), gcode())).id).toBe(2);
    });

    it('still has the gcode a previous run stored', async () => {
      const { id } = await shop.submit(details(), gcode('G1 X42\n'));

      expect((await readAll(await new JobStore(spool).gcodeStream(id))).toString()).toBe('G1 X42\n');
    });
  });

  // AIDEV-NOTE: /var/spool/cups is made at install time and owned by the service's user. A missing
  // root means a machine that was never set up, and creating one would put the shop's work
  // somewhere nobody is looking.
  describe('when the spool is not there', () => {
    const absent = (): JobStore => new JobStore(path.join(tmpdir(), 'print-shop-that-was-never-installed'));

    it.each([
      ['listing', (store: JobStore) => store.all()],
      ['finding', (store: JobStore) => store.find(1)],
      ['submitting', (store: JobStore) => store.submit({ filaments: ['PLA'] }, Readable.from(['G1']))],
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
});
