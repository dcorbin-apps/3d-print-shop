import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { Foreman } from '../src/Foreman';
import { toStdout } from '../src/log';
import type { Machines } from '../src/Foreman';
import { JobStore } from '../src/JobStore';
import type { PrinterOutcome } from '../src/Job';
import type { Printer } from '../src/printing';
import type { RegisteredPrinter } from '../src/Printer';

// AIDEV-NOTE: a real store on a real directory, because what the foreman does is decide from what
// is written down and then write more down. The MACHINES are mocked - there is no printer here -
// and that is the only seam.
describe('the foreman', () => {
  let spool: string;
  let shop: JobStore;
  let foreman: Foreman;
  let mockSend: jest.Mock<(remotePath: string, gcode: Readable) => Promise<void>>;
  let mockAwaitOutcome: jest.Mock<(remotePath: string) => Promise<PrinterOutcome>>;
  let mockReach: jest.Mock<Machines>;

  // The watching a start sets off is deliberately not awaited, so tests wait for what it writes
  // rather than for it. A generous limit: this is about the work happening at all, not how fast.
  async function until(settled: () => Promise<boolean>): Promise<void> {
    const giveUpAt = Date.now() + 5_000;

    while (!(await settled())) {
      if (Date.now() > giveUpAt) throw new Error('the foreman never got there');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  // A turn of the event loop, not a wait: whatever was already queued has run by the time this
  // returns, which is enough to tell "not yet" from "not ever".
  const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const jobIs = (id: number, state: string) => async (): Promise<boolean> => (await shop.find(id))?.state === state;
  const printerIsStopped = (name: string) => async (): Promise<boolean> => (await shop.printerNamed(name)).paused !== undefined;

  async function addPrinter(name: string): Promise<void> {
    await shop.addPrinter({ name, buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: `http://${name}` });
    await shop.load(name, ['PLA-Red']);
  }

  // Every submission carries a caller: the shop answers nobody it cannot name, so there is no such
  // thing as a job that arrived unowned. Whose it is matters in `who a job belongs to` below; the
  // rest of these say it once, here.
  const DAVE = 'u-dave';

  async function submit(overrides: Record<string, unknown> = {}): Promise<number> {
    return (await shop.submit({ filaments: ['PLA-Red'], ...overrides }, Readable.from(['G1 X0 Y0\n']), DAVE)).id;
  }

  beforeEach(async () => {
    spool = await fs.mkdtemp(path.join(tmpdir(), 'print-shop-foreman-'));
    shop = new JobStore(spool);

    mockSend = jest.fn<(remotePath: string, gcode: Readable) => Promise<void>>().mockResolvedValue(undefined);
    // Never settles unless a test says so: a print that is still running is the ordinary case.
    mockAwaitOutcome = jest.fn<(remotePath: string) => Promise<PrinterOutcome>>().mockReturnValue(new Promise(() => {}));
    mockReach = jest.fn<Machines>().mockImplementation(async (_printer: RegisteredPrinter): Promise<Printer> => {
      return { send: mockSend, awaitOutcome: mockAwaitOutcome };
    });

    foreman = new Foreman(shop, mockReach);
    await addPrinter('mk4');
  });

  afterEach(async () => {
    await fs.rm(spool, { recursive: true, force: true });
  });

  // AIDEV-NOTE: the machine's half of the story. The shop runs unattended for hours, and without
  // these lines the only durable trace of anything is the sentence in `printer.paused.reason` -
  // which says nothing about the prints that went well, or about what happened in what order.
  describe('what it writes down', () => {
    let lines: Record<string, unknown>[];
    let watched: Foreman;

    beforeEach(() => {
      lines = [];
      watched = new Foreman(
        shop,
        mockReach,
        toStdout(
          () => new Date(),
          (line) => lines.push(JSON.parse(line) as Record<string, unknown>)
        )
      );
    });

    it('says what it started, on which printer, and how much gcode went over', async () => {
      const id = await submit();

      await watched.considerStarting();

      expect(lines).toContainEqual(
        expect.objectContaining({ event: 'started printing', level: 'note', printer: 'mk4', job: id, gcodeBytes: 9 })
      );
    });

    it('says why it could not send one, which is the reason an operator has to act on', async () => {
      await submit();
      mockSend.mockRejectedValue(new Error('octopi.local refused the connection'));

      await watched.considerStarting();

      expect(lines).toContainEqual(
        expect.objectContaining({
          event: 'could not send a job to the printer',
          level: 'fault',
          printer: 'mk4',
          why: 'octopi.local refused the connection',
        })
      );
    });

    it('says what the printer made of a print when it ended', async () => {
      const id = await submit();
      mockAwaitOutcome.mockResolvedValue('failed');

      await watched.considerStarting();
      await until(jobIs(id, 'awaiting-approval'));

      expect(lines).toContainEqual(expect.objectContaining({ event: 'print ended', printer: 'mk4', outcome: 'failed' }));
    });
  });

  describe('looking for work', () => {
    it('starts what a free printer can print', async () => {
      const id = await submit();

      await foreman.considerStarting();

      expect(await shop.find(id)).toMatchObject({ state: 'printing', heldBy: 'mk4' });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('starts nothing when what is loaded prints nothing', async () => {
      await submit({ filaments: ['PLA-Blue'] });

      await foreman.considerStarting();

      expect(mockSend).not.toHaveBeenCalled();
    });

    // Holding anything means the bed is not clear, verdict or no verdict.
    it('starts nothing on a printer that is already holding a job', async () => {
      await submit();
      await submit();
      await foreman.considerStarting();

      await foreman.considerStarting();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    // AIDEV-NOTE: startNextPrint refuses a busy printer too, so this is not about the job being
    // started - it is about not building and connecting a client for a machine with nothing to do.
    it('does not even reach a printer that is holding something', async () => {
      const id = await submit();
      await submit();
      // Put it in the printer's hands directly: a print the foreman started would have a watcher
      // reaching for the same machine, which is not what this is about.
      await shop.startPrinting('mk4', id);

      await foreman.considerStarting();

      expect(mockReach).not.toHaveBeenCalled();
    });

    it('starts nothing on a printer that is stopped', async () => {
      await submit();
      await shop.pause('mk4', 'the door is open');

      await foreman.considerStarting();

      expect(mockSend).not.toHaveBeenCalled();
    });

    // Two printers, because one would be satisfied by starting a single job and stopping.
    it('gives every free printer something to do', async () => {
      await addPrinter('mini');
      const first = await submit();
      const second = await submit();

      await foreman.considerStarting();

      expect(await shop.find(first)).toMatchObject({ state: 'printing' });
      expect(await shop.find(second)).toMatchObject({ state: 'printing' });
    });

    // AIDEV-NOTE: the reason looks are serialised. Both would find the printer free, and while the
    // store refuses the second start, the file would already have gone to the machine twice.
    it('sends one job once when asked to look twice at the same moment', async () => {
      await submit();
      await submit();

      await Promise.all([foreman.considerStarting(), foreman.considerStarting()]);

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('watching what it started', () => {
    it('writes down how the print ended', async () => {
      const id = await submit();
      mockAwaitOutcome.mockResolvedValue('failed');

      await foreman.considerStarting();

      await until(jobIs(id, 'awaiting-approval'));
      expect(await shop.find(id)).toMatchObject({ lastPrinterOutcome: 'failed' });
    });

    // A restart does not stop a machine, and after one nobody is listening to it.
    it('picks up a print a previous run left running', async () => {
      const id = await submit();
      await foreman.considerStarting();
      mockAwaitOutcome.mockResolvedValue('finished');

      await new Foreman(new JobStore(spool), mockReach).resumeWatching();

      await until(jobIs(id, 'awaiting-approval'));
    });

    // One watcher per printer: two would both wait on the same path, and the second to hear the
    // outcome would try to write it down again and stop the printer for being in the wrong state.
    // One watcher per printer: two would both wait on the same path, and the second to hear the
    // outcome would try to write it down again and stop the printer for being in the wrong state.
    it('takes on a print nobody is watching', async () => {
      const id = await submit();
      await shop.startPrinting('mk4', id);

      expect(await foreman.resumeWatching()).toEqual(['mk4']);
    });

    it('leaves a print it is already watching alone', async () => {
      await submit();
      await foreman.considerStarting();

      expect(await foreman.resumeWatching()).toEqual([]);
    });

    // A print waiting for a verdict has already ended. There is nothing left to hear about it.
    it('picks up nothing for a printer holding a print that is already judged', async () => {
      const id = await submit();
      await shop.startPrinting('mk4', id);
      await shop.finishedPrinting('mk4', 'finished');

      expect(await foreman.resumeWatching()).toEqual([]);
    });

    it('picks up nothing at all for a printer that is idle', async () => {
      expect(await foreman.resumeWatching()).toEqual([]);
    });

    // Otherwise the job says it is printing and nobody is listening to the machine.
    it('stops a printer whose print it loses track of', async () => {
      await submit();
      mockAwaitOutcome.mockRejectedValue(new Error('lost contact for too long'));

      await foreman.considerStarting();

      await until(printerIsStopped('mk4'));
      expect((await shop.printerNamed('mk4')).paused).toMatchObject({ reason: expect.stringContaining('lost contact') });
    });
  });

  // AIDEV-NOTE: on the way out, a watcher losing its print is expected - disconnecting the machines
  // is what took it - and the print is still on the bed for the next run to pick up.
  describe('when the shop is closing', () => {
    it('starts nothing more', async () => {
      await submit();
      foreman.stop();

      await foreman.considerStarting();

      expect(mockSend).not.toHaveBeenCalled();
    });

    // AIDEV-NOTE: what makes an orderly stop possible - the caller can wait for the shop to go quiet
    // rather than exiting while a watcher is still writing down an outcome.
    it('settles only once its watchers have', async () => {
      let printFinished: (outcome: PrinterOutcome) => void = () => undefined;
      mockAwaitOutcome.mockReturnValue(new Promise((resolve) => (printFinished = resolve)));
      await submit();
      await foreman.considerStarting();
      await until(async () => mockAwaitOutcome.mock.calls.length === 1);

      let quiet = false;
      const settling = foreman.watchersSettled().then(() => (quiet = true));
      await nextTurn();
      expect(quiet).toBe(false);

      printFinished('finished');
      await settling;

      expect(quiet).toBe(true);
    });

    // Otherwise a shop would come back up with every printer stopped, for a fault nobody caused.
    it('does not stop a printer whose print it loses on the way out', async () => {
      await submit();
      let lost: (failure: Error) => void = () => undefined;
      mockAwaitOutcome.mockReturnValue(new Promise((_resolve, reject) => (lost = reject)));
      await foreman.considerStarting();
      await until(async () => mockAwaitOutcome.mock.calls.length === 1);

      foreman.stop();
      lost(new Error('the connection was closed'));

      await foreman.watchersSettled();

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });
  });

  describe('when a machine cannot be reached at all', () => {
    beforeEach(() => {
      mockReach.mockRejectedValue(new Error('no API key for mk4'));
    });

    it('stops the printer, saying what was wrong', async () => {
      await submit();

      await foreman.considerStarting();

      expect((await shop.printerNamed('mk4')).paused).toMatchObject({ reason: expect.stringContaining('no API key for mk4') });
    });

    // Otherwise every change in the shop would produce one more failure against the same machine.
    it('does not try it again on the next look', async () => {
      await submit();
      await foreman.considerStarting();

      await foreman.considerStarting();

      expect(mockReach).toHaveBeenCalledTimes(1);
    });

    // Two printers, because stopping the whole shop would satisfy the test above.
    it('leaves a working printer working', async () => {
      await addPrinter('mini');
      mockReach.mockImplementation(async (printer: RegisteredPrinter): Promise<Printer> => {
        if (printer.name === 'mk4') throw new Error('no API key for mk4');

        return { send: mockSend, awaitOutcome: mockAwaitOutcome };
      });
      const id = await submit();

      await foreman.considerStarting();

      expect(await shop.find(id)).toMatchObject({ state: 'printing', heldBy: 'mini' });
    });
  });
});
