import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { InvalidSubmission } from '../src/Job';
import type { BuildVolume, Job, JobDetails, PrinterOutcome } from '../src/Job';
import type { RegisteredPrinter } from '../src/Printer';
import { JobStore, MAX_GCODE_ENV, NoSuchJob, NoSuchPrinter, DataUnavailable, WrongState, defaultMaxGcodeBytes } from '../src/JobStore';
import { aDataDirectory, parentOf } from './aDataDirectory';
import { toStdout } from '../src/log';
import { layoutUnder } from '../src/dataLayout';
import type { DataLayout } from '../src/dataLayout';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

// AIDEV-NOTE: a real directory, not a mocked fs. Keeping jobs on disk IS what this unit does, so a
// mock would test the mock - it is our behaviour under test, not node's fs. See design/testing.md.
describe('JobStore', () => {
  let where: DataLayout;
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

  // The store is handed the printer rather than its name, so these say which one the only way there
  // is to say it. See `printerNamed`, and `naming a printer` below for what that buys.
  const the = (name: string): Promise<RegisteredPrinter> => shop.printerNamed(name);

  async function held(store: JobStore = shop): Promise<string[]> {
    return (await store.all()).map((job) => `${job.id}:${job.displayName}:${job.state}`).sort();
  }

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-');
    shop = new JobStore(where);
    // A shop with no printers accepts nothing, so every one of these needs one.
    await addPrinter('mk4', { x: 250, y: 210, z: 220 });
  });

  afterEach(async () => {
    await fs.rm(parentOf(where), { recursive: true, force: true });
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

      expect((await new JobStore(where).find(id))?.owner).toBe('u-slicer');
    });

    it('starts a job queued, with nothing printed yet', async () => {
      const job = await submit(details(), gcode());

      expect(job).toMatchObject({ state: 'queued' });
    });

    // Carried, never interpreted - it is how a client keeps its own meaning attached.
    it('carries the metadata, remote path and printer through untouched', async () => {
      const job = await submit(
        details({ remotePath: 'plates/cards.gcode', printer: 'mk4', metadata: { pieces: 'cards', kit: 'wingspan' } }),
        gcode(),
      );

      expect(await shop.find(job.id)).toMatchObject({
        remotePath: 'plates/cards.gcode',
        printer: 'mk4',
        metadata: { pieces: 'cards', kit: 'wingspan' },
      });
    });

    // Written down rather than only echoed back, because what ranks the queue is read from the
    // record long after the submission that carried it has been answered.
    it('records how long a client said the print takes', async () => {
      const job = await submit(details({ estimatedPrintSeconds: 20_460 }), gcode());

      expect((await new JobStore(where).find(job.id))?.estimatedPrintSeconds).toBe(20_460);
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

    // AIDEV-NOTE: `JobDetails` is a declaration about JSON somebody else wrote, so the fields the
    // SHOP decides are copied into the record rather than spread over. These two used to land on
    // disk and come back out again: `asJob` overrides `state` for a queued job and not these.
    it('takes none of the fields the shop decides from the client that submitted it', async () => {
      const claimed = { ...details(), heldBy: 'mk4', lastPrinterOutcome: 'finished' } as JobDetails;

      const job = await submit(claimed, gcode());
      const stored = await shop.find(job.id);

      expect([job.heldBy, job.lastPrinterOutcome]).toEqual([undefined, undefined]);
      expect([stored?.heldBy, stored?.lastPrinterOutcome]).toEqual([undefined, undefined]);
    });
  });

  describe('a submission that does not complete', () => {
    const brokenStream = (): Readable =>
      Readable.from(
        (function* () {
          yield 'G1 X0';
          throw new Error('the link died');
        })(),
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
      await expect(fs.readdir(where.jobs)).resolves.toEqual([]);
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

    const recordOnDisk = (): Promise<string> => fs.readFile(path.join(where.jobs, String(id), 'job.json'), 'utf-8');

    beforeEach(async () => {
      id = (await submit(details(), gcode())).id;
    });

    // AIDEV-NOTE: the claim the whole model rests on. A job is printing because a PRINTER says it is
    // holding it to print; nothing about the job itself changed, so there is no second answer to
    // reconcile and starting a print is one write.
    it('leaves the job exactly as submitted, all the way to its verdict', async () => {
      const asSubmitted = await recordOnDisk();

      await shop.startPrinting(await the('mk4'), id);
      await shop.finishedPrinting(await the('mk4'), 'failed');
      await shop.reject(id);

      expect(await recordOnDisk()).toBe(asSubmitted);
    });

    it('is printing because the printer says it is holding it to print', async () => {
      expect(await shop.startPrinting(await the('mk4'), id)).toMatchObject({ state: 'printing', heldBy: 'mk4' });
      expect((await shop.printerNamed('mk4')).holding).toEqual({ job: id, phase: 'printing' });
    });

    // AIDEV-NOTE: written after the upload rather than with the holding, because until the machine
    // has answered nobody knows where the file went. What watches the print matches on that string.
    it('records where the printer said it filed the gcode', async () => {
      await shop.startPrinting(await the('mk4'), id);

      await shop.printingAt(await the('mk4'), 'plates/umlaut.gcode');

      expect((await shop.printerNamed('mk4')).holding).toEqual({ job: id, phase: 'printing', remotePath: 'plates/umlaut.gcode' });
    });

    // A print is watched to its end from a holding that has by then moved phase, so a path lost on
    // the way would be lost exactly when a restart needed it.
    it('still has that path once the print has ended', async () => {
      await shop.startPrinting(await the('mk4'), id);
      await shop.printingAt(await the('mk4'), 'plates/umlaut.gcode');

      await shop.finishedPrinting(await the('mk4'), 'finished');

      expect((await shop.printerNamed('mk4')).holding?.remotePath).toBe('plates/umlaut.gcode');
    });

    it('refuses to record one for a printer that is printing nothing', async () => {
      await expect(shop.printingAt(await the('mk4'), 'plates/umlaut.gcode')).rejects.toThrow(WrongState);
    });

    // The printer never took it: nothing was printed, so it lets go and the job is queued again by
    // not being held.
    it('queues a job the printer never started again, by letting go of it', async () => {
      await shop.startPrinting(await the('mk4'), id);
      await shop.couldNotStart(await the('mk4'));

      expect(await shop.find(id)).toMatchObject({ state: 'queued' });
      expect((await shop.printerNamed('mk4')).holding).toBeUndefined();
    });

    // AIDEV-NOTE: `finished` is not approval. A print can run to the end and still be unusable, so
    // every ending waits for a human - which is also why the gcode is still here, and why the
    // printer goes on holding it: the bed is not clear either.
    it.each<[PrinterOutcome]>([['finished'], ['failed'], ['cancelled']])(
      'waits for a verdict however the printer ended it (%s)',
      async (outcome) => {
        await shop.startPrinting(await the('mk4'), id);

        expect(await shop.finishedPrinting(await the('mk4'), outcome)).toMatchObject({
          state: 'awaiting-approval',
          lastPrinterOutcome: outcome,
        });
      },
    );

    it('sends a rejected print back to the queue, and frees the printer', async () => {
      await shop.startPrinting(await the('mk4'), id);
      await shop.finishedPrinting(await the('mk4'), 'finished');

      expect(await shop.reject(id)).toMatchObject({ state: 'queued' });
      expect((await shop.printerNamed('mk4')).holding).toBeUndefined();
    });

    it('still has the gcode for a rejected print to be run again from', async () => {
      await shop.startPrinting(await the('mk4'), id);
      await shop.finishedPrinting(await the('mk4'), 'failed');
      await shop.reject(id);

      expect((await readAll(await shop.gcodeStream(id))).length).toBeGreaterThan(0);
    });

    // Approved work leaves the shop entirely - it holds what is outstanding, not what was done.
    it('removes an approved job, gcode and record together, and frees the printer', async () => {
      await shop.startPrinting(await the('mk4'), id);
      await shop.finishedPrinting(await the('mk4'), 'finished');

      await shop.approve(id);

      expect(await shop.find(id)).toBeUndefined();
      await expect(fs.readdir(where.jobs)).resolves.toEqual([]);
      expect((await shop.printerNamed('mk4')).holding).toBeUndefined();
    });

    // Abandoning is approving in what it does to the shop and the opposite of it in what it means:
    // there is no good print, and no reprint either.
    it('removes an abandoned job the same way, and frees the printer', async () => {
      await shop.startPrinting(await the('mk4'), id);
      await shop.finishedPrinting(await the('mk4'), 'failed');

      await shop.abandon(id);

      expect(await shop.find(id)).toBeUndefined();
      expect((await shop.printerNamed('mk4')).holding).toBeUndefined();
    });

    it('does not hand out the id of an approved job again', async () => {
      await shop.startPrinting(await the('mk4'), id);
      await shop.finishedPrinting(await the('mk4'), 'finished');
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
      await shop.load(await the('mk4'), ['PLA-Red', 'PLA-Blue']);

      expect((await shop.printerNamed('mk4')).loaded).toEqual(['PLA-Red', 'PLA-Blue']);
    });

    it('takes an empty list for a machine with nothing on it', async () => {
      await shop.load(await the('mk4'), ['PLA-Red']);
      await shop.load(await the('mk4'), []);

      expect((await shop.printerNamed('mk4')).loaded).toEqual([]);
    });

    // Derived from the record on the way out rather than kept in it, so a printer moved to a new
    // address is watched at the new one without anything being rewritten.
    it('says where the machine can be watched, from the address it was given', async () => {
      expect((await shop.printerNamed('mk4')).camera).toBe('http://mk4/webcam/?action=stream');
    });

    it('says where it moved to when the address changes', async () => {
      await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://moved' });

      expect((await shop.printerNamed('mk4')).camera).toBe('http://moved/webcam/?action=stream');
    });

    // Re-adding a printer is how an operator corrects its address or its bed, and it must not make
    // the shop forget what is on the machine.
    it('still knows what is loaded after the printer is added again', async () => {
      await shop.load(await the('mk4'), ['PLA-Red']);
      await addPrinter('mk4', { x: 250, y: 210, z: 220 });

      expect((await shop.printerNamed('mk4')).loaded).toEqual(['PLA-Red']);
    });

    it('is still loaded after a restart', async () => {
      await shop.load(await the('mk4'), ['PLA-Red']);

      expect((await new JobStore(where).printerNamed('mk4')).loaded).toEqual(['PLA-Red']);
    });

    // AIDEV-NOTE: the shop's list of machines is the SPOOL's, not a running process's - a printer
    // added over the API is added for good, and adding one is a thing an operator does once. Every
    // other restart test here is about what a printer is DOING; this is about it being here at all,
    // which nothing pinned until a printer could be added from somewhere other than a terminal.
    it("is still one of the shop's printers after a restart, with what it was told about it", async () => {
      await shop.addPrinter({ name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, api: 'octoprint', address: 'http://mini' });

      expect(await new JobStore(where).printers()).toEqual([
        expect.objectContaining({ name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini' }),
        expect.objectContaining({ name: 'mk4' }),
      ]);
    });
  });

  // AIDEV-NOTE: the one place a string becomes a printer, and the reason nothing else here takes a
  // name. It answers for a name the shop REGISTERED rather than for whatever path that name would
  // build, so a name a client invented cannot reach the data directory however it is spelled.
  describe('naming a printer', () => {
    it('refuses a name no printer here has', async () => {
      await expect(shop.printerNamed('ender')).rejects.toThrow(NoSuchPrinter);
    });

    // It used to answer 'yes' to whatever the path happened to reach: a printer.json that parses was
    // a printer, wherever up the tree it was found.
    it('refuses a name that climbs out of the printers directory, even onto a printer.json that is there', async () => {
      await fs.writeFile(path.join(where.state, 'printer.json'), JSON.stringify({ name: 'up-the-tree', buildVolume: { x: 1, y: 1, z: 1 } }));

      await expect(shop.printerNamed('..')).rejects.toThrow(NoSuchPrinter);
    });
  });

  describe('a move the lifecycle does not allow', () => {
    it('refuses a second job on a printer that is already holding one', async () => {
      const { id } = await submit(details(), gcode());
      const other = await submit(details(), gcode());
      await shop.startPrinting(await the('mk4'), id);

      await expect(shop.startPrinting(await the('mk4'), other.id)).rejects.toThrow(WrongState);
    });

    // Two printers, because one would be satisfied by refusing every second start.
    it('refuses to start a job another printer is already holding', async () => {
      await addPrinter('mini', { x: 180, y: 180, z: 180 });
      const { id } = await submit(details(), gcode());
      await shop.startPrinting(await the('mk4'), id);

      await expect(shop.startPrinting(await the('mini'), id)).rejects.toThrow(WrongState);
    });

    it('refuses to start anything on a printer that is stopped', async () => {
      const { id } = await submit(details(), gcode());
      await shop.pause(await the('mk4'), 'the door is open');

      await expect(shop.startPrinting(await the('mk4'), id)).rejects.toThrow(WrongState);
    });

    // The scheduler would never choose this pairing, but the store is what makes it impossible: a
    // job claiming mk4 is not mini's to start, however it was asked for.
    it('refuses to start a job on a printer that could not take it', async () => {
      await addPrinter('mini', { x: 180, y: 180, z: 180 });
      const { id } = await submit(details({ printer: 'mk4' }), gcode());

      await expect(shop.startPrinting(await the('mini'), id)).rejects.toThrow(WrongState);
    });

    it('refuses to finish a print that never started', async () => {
      await submit(details(), gcode());

      await expect(shop.finishedPrinting(await the('mk4'), 'finished')).rejects.toThrow(WrongState);
    });

    // Nothing has been printed to judge.
    it.each<['approve' | 'reject' | 'abandon']>([['approve'], ['reject'], ['abandon']])('refuses to %s a job still queued', async (verdict) => {
      const { id } = await submit(details(), gcode());

      await expect(shop[verdict](id)).rejects.toThrow(WrongState);
    });

    // The machine is still printing it. Letting the printer go would queue the job for a second
    // machine while the first is still running it.
    it('refuses to take a printer out of the shop while it is holding work', async () => {
      const { id } = await submit(details(), gcode());
      await shop.startPrinting(await the('mk4'), id);

      await expect(shop.removePrinter(await the('mk4'))).rejects.toThrow(WrongState);
    });

    it('says which job it cannot find', async () => {
      await expect(shop.startPrinting(await the('mk4'), 404)).rejects.toThrow(NoSuchJob);
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
      await shop.pause(await the('mk4'), 'out of filament');

      expect((await shop.printerNamed('mk4')).paused).toMatchObject({ reason: 'out of filament' });
    });

    it('runs again when told to', async () => {
      await shop.pause(await the('mk4'), 'out of filament');
      await shop.resume(await the('mk4'));

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    // Two printers, because one would be satisfied by stopping everything.
    it('stops only the printer named', async () => {
      await shop.pause(await the('mk4'), 'the door is open');

      expect((await shop.printerNamed('mk4')).paused).toBeDefined();
      expect((await shop.printerNamed('mini')).paused).toBeUndefined();
    });

    it('keeps one printer stopped while another is started again', async () => {
      await shop.pause(await the('mk4'), 'out of filament');
      await shop.pause(await the('mini'), 'the door is open');
      await shop.resume(await the('mk4'));

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
      expect((await shop.printerNamed('mini')).paused).toMatchObject({ reason: 'the door is open' });
    });

    it('replaces the reason rather than stopping twice', async () => {
      await shop.pause(await the('mk4'), 'out of filament');
      await shop.pause(await the('mk4'), 'the door is open');

      expect((await shop.printerNamed('mk4')).paused).toMatchObject({ reason: 'the door is open' });
    });

    it('is still stopped after a restart', async () => {
      await shop.pause(await the('mk4'), 'out of filament');

      expect((await new JobStore(where).printerNamed('mk4')).paused).toMatchObject({
        reason: 'out of filament',
      });
    });

    it('records when it stopped', async () => {
      await shop.pause(await the('mk4'), 'out of filament');

      expect((await shop.printerNamed('mk4')).paused?.since).toBeInstanceOf(Date);
    });
  });

  // AIDEV-NOTE: the shop's own reading of a machine, kept apart from a stop. `paused` is what an
  // operator said and only an operator lifts; this is what the shop found, and the shop lifts it.
  describe('a printer the shop cannot get to', () => {
    it('says what it saw, and when', async () => {
      await shop.couldNotReach(await the('mk4'), 'no API key for mk4');

      const printer = await shop.printerNamed('mk4');
      expect(printer.unreachable).toMatchObject({ reason: 'no API key for mk4' });
      expect(printer.unreachable?.since).toBeInstanceOf(Date);
    });

    // A restart is not contact with the machine, so it says nothing about whether this is over.
    it('is still out of reach after a restart', async () => {
      await shop.couldNotReach(await the('mk4'), 'no API key for mk4');

      expect((await new JobStore(where).printerNamed('mk4')).unreachable).toMatchObject({ reason: 'no API key for mk4' });
    });

    it('is not a stop, because nobody is being asked to clear it', async () => {
      await shop.couldNotReach(await the('mk4'), 'no API key for mk4');

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    it('lets go when the machine answers again', async () => {
      await shop.couldNotReach(await the('mk4'), 'no API key for mk4');
      await shop.reachedAgain(await the('mk4'));

      expect((await shop.printerNamed('mk4')).unreachable).toBeUndefined();
    });

    // The machine answering says nothing about the reason a person gave, which no machine can
    // contradict - a printer whose door an operator left open is still stopped when it picks up.
    it("leaves an operator's stop where it is when the machine answers again", async () => {
      await shop.pause(await the('mk4'), 'the door is open');
      await shop.couldNotReach(await the('mk4'), 'no API key for mk4');
      await shop.reachedAgain(await the('mk4'));

      expect((await shop.printerNamed('mk4')).paused).toMatchObject({ reason: 'the door is open' });
    });

    // Somebody who has just put a key right should not wait out a backoff to find out whether it took.
    it('is lifted too when an operator says go', async () => {
      await shop.couldNotReach(await the('mk4'), 'no API key for mk4');
      await shop.resume(await the('mk4'));

      expect((await shop.printerNamed('mk4')).unreachable).toBeUndefined();
    });
  });

  // AIDEV-NOTE: the shop lost hold of a print it was watching. The printer keeps its job - the
  // machine goes on printing whoever is listening - so what is written is that nobody is hearing it.
  describe('a print the shop stopped hearing about', () => {
    beforeEach(async () => {
      const job = await submit(details(), gcode());
      await shop.load(await the('mk4'), ['PLA-SpaceGray']);
      await shop.startPrinting(await the('mk4'), job.id);
    });

    it('says what took the watch, and when', async () => {
      await shop.lostContact(await the('mk4'), 'lost contact for too long');

      const printer = await shop.printerNamed('mk4');
      expect(printer.outOfContact).toMatchObject({ reason: 'lost contact for too long' });
      expect(printer.outOfContact?.since).toBeInstanceOf(Date);
    });

    it('is not a stop, because nobody stopped anything', async () => {
      await shop.lostContact(await the('mk4'), 'lost contact for too long');

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    // Letting go would queue a job that is on a bed.
    it('leaves the printer holding its print', async () => {
      await shop.lostContact(await the('mk4'), 'lost contact for too long');

      expect((await shop.printerNamed('mk4')).holding).toMatchObject({ phase: 'printing' });
    });

    it('lets go when the machine is being heard again', async () => {
      await shop.lostContact(await the('mk4'), 'lost contact for too long');
      await shop.inContactAgain(await the('mk4'));

      expect((await shop.printerNamed('mk4')).outOfContact).toBeUndefined();
    });

    it('is lifted when an operator says go', async () => {
      await shop.lostContact(await the('mk4'), 'lost contact for too long');
      await shop.resume(await the('mk4'));

      expect((await shop.printerNamed('mk4')).outOfContact).toBeUndefined();
    });
  });

  // AIDEV-NOTE: the one thing the shop writes about a machine that waits for a person. The printer
  // ANSWERED, so there is nothing to find out by asking again - and asking costs a whole plate.
  describe('a printer that would not take the file', () => {
    it('says what it would not take, and when', async () => {
      await shop.wouldNotTake(await the('mk4'), '3d-print-shop/job-1.gcode - OctoPrint upload failed: 400 Bad Request');

      const printer = await shop.printerNamed('mk4');
      expect(printer.refused).toMatchObject({ reason: '3d-print-shop/job-1.gcode - OctoPrint upload failed: 400 Bad Request' });
      expect(printer.refused?.since).toBeInstanceOf(Date);
    });

    it('is not a stop, because nobody stopped anything', async () => {
      await shop.wouldNotTake(await the('mk4'), 'OctoPrint upload failed: 400 Bad Request');

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    // The machine answering says nothing about the file it already turned down.
    it('is left where it is when the machine answers again', async () => {
      await shop.wouldNotTake(await the('mk4'), 'OctoPrint upload failed: 400 Bad Request');
      await shop.reachedAgain(await the('mk4'));

      expect((await shop.printerNamed('mk4')).refused).toMatchObject({ reason: 'OctoPrint upload failed: 400 Bad Request' });
    });

    // Which is the only thing that lifts it: a person has looked, and says so.
    it('is lifted when an operator says go', async () => {
      await shop.wouldNotTake(await the('mk4'), 'OctoPrint upload failed: 400 Bad Request');
      await shop.resume(await the('mk4'));

      expect((await shop.printerNamed('mk4')).refused).toBeUndefined();
    });
  });

  // AIDEV-NOTE: a job no printer could ever take is refused on the way in rather than left to sit.
  // A client told at submission can do something about it; one whose job silently starves cannot.
  describe('what the shop will accept', () => {
    it('refuses everything when it has no printers at all', async () => {
      const empty = new JobStore(await aDataDirectory('print-shop-empty-'));

      await expect(empty.submit(details(), gcode(), DAVE)).rejects.toThrow('no printers');
    });

    it('refuses a job for a printer it does not have, naming the ones it does', async () => {
      await expect(submit(details({ printer: 'ender' }), gcode())).rejects.toThrow('no printer called ender - this shop has mk4');
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
      await shop.startPrinting(await the('mk4'), printing.id);

      expect(await held(new JobStore(where))).toEqual(['1:Player Box:printing', '2:Job 2:queued']);
    });

    it('goes on issuing ids where the previous run stopped', async () => {
      await submit(details(), gcode());

      expect((await new JobStore(where).submit(details(), gcode(), DAVE)).id).toBe(2);
    });

    it('still has the gcode a previous run stored', async () => {
      const { id } = await submit(details(), gcode('G1 X42\n'));

      expect((await readAll(await new JobStore(where).gcodeStream(id))).toString()).toBe('G1 X42\n');
    });
  });

  // AIDEV-NOTE: /var/spool/cups is made at install time and owned by the service's user. A missing
  // root means a machine that was never set up, and creating one would put the shop's work
  // somewhere nobody is looking.
  // AIDEV-NOTE: integrity before secrecy. A data directory another user can write is one where a job's gcode
  // can be swapped for different gcode, and the shop sends what is there to a printer unquestioned.
  describe('what the shop leaves on disk', () => {
    // Given the place rather than a name under one root: the three kinds live in three directories
    // now, and which one each belongs to is the thing these are about.
    async function modeOf(...inside: string[]): Promise<string> {
      return ((await fs.stat(path.join(...inside))).mode & 0o777).toString(8);
    }

    it('keeps a job to itself, directory and contents', async () => {
      await submit(details({ displayName: 'Player Box' }), gcode());

      expect(await modeOf(where.jobs, '1')).toBe('700');
      expect(await modeOf(where.jobs, '1', 'print.gcode')).toBe('600');
      expect(await modeOf(where.jobs, '1', 'job.json')).toBe('600');
    });

    it('keeps a printer to itself, record and status alike', async () => {
      await shop.load(await the('mk4'), ['PLA']);

      expect(await modeOf(where.state, 'printers', 'mk4')).toBe('700');
      expect(await modeOf(where.state, 'printers', 'mk4', 'printer.json')).toBe('600');
      expect(await modeOf(where.state, 'printers', 'mk4', 'status.json')).toBe('600');
    });

    // Written by the same atomic rename as everything else, so it is easy to miss.
    it('keeps the id counter to itself', async () => {
      await submit(details(), gcode());

      expect(await modeOf(where.state, 'next-id')).toBe('600');
    });
  });

  describe('when the data directory is not there', () => {
    const absent = (): JobStore => new JobStore(layoutUnder(path.join(tmpdir(), 'print-shop-that-was-never-installed')));

    it.each([
      ['listing', (store: JobStore) => store.all()],
      ['finding', (store: JobStore) => store.find(1)],
      ['submitting', (store: JobStore) => store.submit({ filaments: ['PLA'] }, Readable.from(['G1']), DAVE)],
      // Asked at startup, so a service refuses to START rather than refusing to serve.
      ['starting up', (store: JobStore) => store.ready()],
    ])('refuses rather than creating one when %s', async (_case, act) => {
      await expect(act(absent())).rejects.toThrow(DataUnavailable);
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
  describe('when the data directory is one somebody else could write', () => {
    it.each([
      ['anybody', 0o777],
      ['its group', 0o770],
      ['anybody, without letting them look', 0o722],
    ])('refuses to start when %s could write it', async (_who, mode) => {
      await fs.chmod(where.jobs, mode);

      await expect(shop.ready()).rejects.toThrow(DataUnavailable);
    });

    it('says the mode it found, which is what the operator has to change', async () => {
      await fs.chmod(where.jobs, 0o777);

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
      await fs.chmod(where.jobs, mode);

      await expect(shop.ready()).resolves.toBeUndefined();
    });
  });

  // AIDEV-NOTE: a file the shop cannot read used to take the WHOLE shop with it - `readPrinter`,
  // `readStatus` and `readRecord` each caught the read and not the parse, and everything goes through
  // `printers()`, so one bad file answered the job list, the printer list, a submission and the
  // printing loop alike with a 500, and a restart did not clear it.
  //
  // The two printer files are answered differently because they leave the shop knowing different
  // amounts, and each is answered the way an ABSENT file of that kind already was.
  describe('a file it cannot read', () => {
    const lines: string[] = [];

    const storeThatSays = (): JobStore =>
      new JobStore(
        where,
        {},
        toStdout(
          () => new Date(),
          (line) => lines.push(line),
        ),
      );

    const corrupt = async (file: string): Promise<void> => {
      await fs.writeFile(path.join(where.state, 'printers', file), '{ not json');
    };

    beforeEach(async () => {
      lines.length = 0;
      await addPrinter('mk4', { x: 250, y: 210, z: 220 });
      await addPrinter('mini', { x: 180, y: 180, z: 180 });
    });

    describe('a status nobody can read', () => {
      beforeEach(async () => {
        await corrupt(path.join('mk4', 'status.json'));
      });

      it('leaves the printer listed, and says a person has to look', async () => {
        const mk4 = (await shop.printers()).find((printer) => printer.name === 'mk4');

        expect(mk4?.unreadable?.reason).toContain('not JSON');
        expect(mk4?.buildVolume).toEqual({ x: 250, y: 210, z: 220 });
      });

      // The whole of what was asked for: one bad file is one bad printer.
      it('leaves every other printer exactly as it was', async () => {
        const mini = (await shop.printers()).find((printer) => printer.name === 'mini');

        expect(mini?.unreadable).toBeUndefined();
        expect(mini?.buildVolume).toEqual({ x: 180, y: 180, z: 180 });
      });

      it('is not a printer anything will be started on', async () => {
        const job = await submit(details(), gcode());
        await shop.load(await the('mk4'), ['PLA-SpaceGray']);
        // Loading wrote a status back, which is the recovery below - so this is broken again to ask
        // the question this test is about rather than the one that answer settled.
        await corrupt(path.join('mk4', 'status.json'));

        await expect(shop.startPrinting(await the('mk4'), job.id)).rejects.toThrow(WrongState);
      });

      // AIDEV-NOTE: the way out, and it falls out of how a status is changed rather than being a
      // repair anybody wrote. Changing one reads it first, and a status nobody can read is one there
      // is nothing to keep from - so an operator doing the ordinary thing to a machine they have
      // been to leaves a status the shop can read again. What it cannot bring back is what the
      // machine was holding, which was in the file nobody could read.
      it('is put right by an operator doing anything to the machine', async () => {
        await shop.load(await the('mk4'), ['PLA-SpaceGray']);

        expect((await the('mk4')).unreadable).toBeUndefined();
        expect((await the('mk4')).loaded).toEqual(['PLA-SpaceGray']);
      });

      // Read as an empty status it would say the bed is clear, and a job that is ON that bed would be
      // queued for another machine to print as well.
      it('is not read as a printer holding nothing', async () => {
        expect((await the('mk4')).holding).toBeUndefined();
        expect((await the('mk4')).unreadable).toBeDefined();
      });
    });

    describe('a record nobody can read', () => {
      beforeEach(async () => {
        await corrupt(path.join('mk4', 'printer.json'));
      });

      // There is no bed to measure a job against and no address to reach, which is what an absent
      // record has always meant here.
      it('is not a printer the shop has', async () => {
        expect((await shop.printers()).map((printer) => printer.name)).toEqual(['mini']);
      });

      it('leaves the shop answering for the rest of them', async () => {
        await expect(the('mini')).resolves.toMatchObject({ name: 'mini' });
      });
    });

    describe('a job nobody can read', () => {
      it('is left out of what the shop answers, and the rest are not', async () => {
        const kept = await submit(details(), gcode());
        const broken = await submit(details(), gcode());
        await fs.writeFile(path.join(where.jobs, String(broken.id), 'job.json'), '{ not json');

        expect((await shop.all()).map((job) => job.id)).toEqual([kept.id]);
      });
    });

    describe('what it says about one', () => {
      it('names the file and what would put it right', async () => {
        await corrupt(path.join('mk4', 'status.json'));

        await storeThatSays().printers();

        expect(lines.join('\n')).toContain('mk4');
        expect(lines.join('\n')).toContain('status.json');
      });

      // AIDEV-NOTE: `printers()` is asked on every request that touches anything, so a line per read
      // is a line per request - which is a log nobody can read, and this log exists to be read.
      it('says it once however often the shop is asked', async () => {
        await corrupt(path.join('mk4', 'status.json'));
        const store = storeThatSays();

        await store.printers();
        await store.printers();
        await store.printers();

        expect(lines.filter((line) => line.includes('status.json'))).toHaveLength(1);
      });
    });
  });

  // AIDEV-NOTE: (UT) what a person says about a job AFTER it arrived, which is kept beside the
  // record rather than in it. The record is the submission and is written once; these tests are as
  // much about that staying true as about the operations themselves.
  describe('what somebody says about a job later', () => {
    let id: number;

    beforeEach(async () => {
      await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://mk4' });
      id = (await shop.submit({ filaments: ['PLA-Red'], displayName: 'Player Box' }, Readable.from(['G1 X0 Y0\n']), 'u-dave')).id;
    });

    const recordOnDisk = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await fs.readFile(path.join(where.jobs, String(id), 'job.json'), 'utf-8')) as Record<string, unknown>;

    describe('calling it something else', () => {
      it('is what the job is called from then on', async () => {
        await shop.rename(id, 'Clamp Dock');

        expect((await shop.find(id))?.displayName).toBe('Clamp Dock');
      });

      // The name is IN the record, so this is the write landing where it should. Nothing else in the
      // record may move, which is what the second half asserts.
      it('writes the new name into the record and changes nothing else in it', async () => {
        const before = await recordOnDisk();

        await shop.rename(id, 'Clamp Dock');

        const after = await recordOnDisk();
        expect(after.displayName).toBe('Clamp Dock');
        expect({ ...after, displayName: undefined }).toEqual({ ...before, displayName: undefined });
      });

      it('refuses a name the shop would have refused at submission', async () => {
        await expect(shop.rename(id, 'x'.repeat(256))).rejects.toThrow(InvalidSubmission);
      });

      it('survives being read back from disk rather than from memory', async () => {
        await shop.rename(id, 'Clamp Dock');

        expect((await new JobStore(where).find(id))?.displayName).toBe('Clamp Dock');
      });
    });

    describe('holding it back', () => {
      it('says when it was held', async () => {
        await shop.holdBack(id);

        expect((await shop.find(id))?.heldBack).toBeInstanceOf(Date);
      });

      it('is still queued, because nothing is holding it', async () => {
        await shop.holdBack(id);

        expect((await shop.find(id))?.state).toBe('queued');
      });

      it('is let through again when somebody says so', async () => {
        await shop.holdBack(id);

        await shop.letThrough(id);

        expect((await shop.find(id))?.heldBack).toBeUndefined();
      });

      // Refused rather than accepted quietly: a hold keeps a job from STARTING, and this one has
      // started. Taking it would leave somebody believing they had stopped a print.
      it('is refused on a job a printer is holding', async () => {
        await shop.startPrinting(await shop.printerNamed('mk4'), id);

        await expect(shop.holdBack(id)).rejects.toThrow(WrongState);
      });

      // AIDEV-NOTE: the guard rather than the manners. `printableNow` declines to OFFER a paused job,
      // which is what stops one being picked - but the scheduler decides at one moment and the print
      // starts at another, and a pause can land in between. Without this, that job prints.
      it('cannot be started by a printer even when it is asked directly', async () => {
        await shop.holdBack(id);

        await expect(shop.startPrinting(await shop.printerNamed('mk4'), id)).rejects.toThrow(WrongState);
        expect((await shop.printerNamed('mk4')).holding).toBeUndefined();
      });
    });

    describe('forgetting it', () => {
      it('takes the record, the gcode and what was said about it', async () => {
        await shop.rename(id, 'Clamp Dock');

        await shop.forget(id);

        expect(await shop.find(id)).toBeUndefined();
        await expect(fs.readdir(path.join(where.jobs, String(id)))).rejects.toThrow();
      });

      // A job on a bed leaves by a verdict. Deleting it would leave a printer holding a job that is
      // not there - a machine that looks busy for ever.
      it('is refused on a job a printer is holding', async () => {
        await shop.startPrinting(await shop.printerNamed('mk4'), id);

        await expect(shop.forget(id)).rejects.toThrow(WrongState);
        expect(await shop.find(id)).toBeDefined();
      });
    });
  });

  describe('a picture kept beside a job', () => {
    let id: number;
    const drawn = Buffer.from('a picture of the plate');

    beforeEach(async () => {
      id = (await submit(details(), gcode())).id;
    });

    it('is nothing until one is kept', async () => {
      expect(await shop.keptPicture(id, 'render-1.png')).toBeUndefined();
    });

    it('is handed back as it was kept', async () => {
      await shop.keepPicture(id, 'render-1.png', drawn);

      expect(await shop.keptPicture(id, 'render-1.png')).toEqual(drawn);
    });

    it('is kept under its version, so a picture drawn another way is not taken for it', async () => {
      await shop.keepPicture(id, 'render-1.png', drawn);

      expect(await shop.keptPicture(id, 'render-2.png')).toBeUndefined();
    });

    it('will not be kept under a version that names a path', async () => {
      await expect(shop.keepPicture(id, '../job.json', drawn)).rejects.toThrow(
        'a picture\'s version is a plain name, and "../job.json" is not one',
      );
    });

    it('is not kept for a job the shop does not hold', async () => {
      await expect(shop.keepPicture(99, 'render-1.png', drawn)).rejects.toThrow(NoSuchJob);
    });

    it('is not asked after for a job the shop does not hold', async () => {
      await expect(shop.keptPicture(99, 'render-1.png')).rejects.toThrow(NoSuchJob);
    });
  });

  // AIDEV-NOTE: (UT) the machine's own account of itself, which is the one trouble here the shop
  // does not work out for itself - and the one an operator cannot lift.
  describe('a machine that says it cannot print', () => {
    beforeEach(async () => {
      await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://mk4' });
    });

    it('keeps what the machine said, and reads it back', async () => {
      await shop.saidItCannotPrint(await shop.printerNamed('mk4'), 'Offline after error');

      expect((await shop.printerNamed('mk4')).unavailable?.reason).toBe('Offline after error');
    });

    it('lets it go when the machine says it can again', async () => {
      await shop.saidItCannotPrint(await shop.printerNamed('mk4'), 'Offline after error');

      await shop.saidItCanPrint(await shop.printerNamed('mk4'));

      expect((await shop.printerNamed('mk4')).unavailable).toBeUndefined();
    });

    // An operator's word cannot make hardware answer. Every other trouble here is lifted by `resume`
    // and this one is not, because clearing it would send a plate to a machine that still cannot
    // take it - and the upload would succeed before the start was refused.
    it('is not lifted by an operator resuming the printer', async () => {
      await shop.saidItCannotPrint(await shop.printerNamed('mk4'), 'Offline after error');
      await shop.pause(await shop.printerNamed('mk4'), 'looking at it');

      await shop.resume(await shop.printerNamed('mk4'));

      const printer = await shop.printerNamed('mk4');
      expect(printer.paused).toBeUndefined();
      expect(printer.unavailable?.reason).toBe('Offline after error');
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
