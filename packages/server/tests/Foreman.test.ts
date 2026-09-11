import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { Foreman } from '../src/Foreman';
import { silent, toStdout } from '../src/log';
import type { Machines } from '../src/Foreman';
import { JobStore } from '../src/JobStore';
import type { PrinterOutcome } from '../src/Job';
import { CouldNotReach } from '../src/printing';
import type { Printer } from '../src/printing';
import type { RegisteredPrinter } from '../src/Printer';

// AIDEV-NOTE: a real store on a real directory, because what the foreman does is decide from what
// is written down and then write more down. The MACHINES are mocked - there is no printer here -
// and that is the only seam.
describe('the foreman', () => {
  let spool: string;
  let shop: JobStore;
  let foreman: Foreman;
  let mockSend: jest.Mock<(remotePath: string, gcode: Readable) => Promise<string>>;
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
  const outOfContact = (name: string) => async (): Promise<boolean> => (await shop.printerNamed(name)).outOfContact !== undefined;

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

  // AIDEV-NOTE: every foreman this file makes, remembered so that the teardown can stop it. One that
  // is still watching is one still WRITING, and the teardown deletes the spool out from under it -
  // which surfaces as `ENOTEMPTY` from rmdir, in whichever test was unlucky, about one full run in
  // eight. A test that starts something is a test that has to stop it.
  const foremen: Foreman[] = [];

  function aForeman(...how: ConstructorParameters<typeof Foreman>): Foreman {
    const made = new Foreman(...how);
    foremen.push(made);

    return made;
  }

  // AIDEV-NOTE: the waiting is released rather than abandoned. `awaitOutcome` never settles unless a
  // test says so - a print still running is the ordinary case - so waiting on the watchers without
  // this would wait for ever. Stopped FIRST, so that what this releases is written down by nobody:
  // a foreman on its way out treats a lost print as the shutdown taking it, which is what it is.
  let stopWaiting: () => void;

  beforeEach(async () => {
    spool = await fs.mkdtemp(path.join(tmpdir(), 'print-shop-foreman-'));
    shop = new JobStore(spool);

    mockSend = jest.fn<(remotePath: string, gcode: Readable) => Promise<string>>().mockImplementation((remotePath) => Promise.resolve(remotePath));
    // Never settles unless a test says so: a print that is still running is the ordinary case.
    const stillPrinting = new Promise<PrinterOutcome>((_heard, never) => {
      stopWaiting = () => never(new Error('the test ended'));
    });

    // Caught here because most tests never ask for it, and a rejection nobody is waiting on is an
    // unhandled one - which jest reports against whichever test happened to be running.
    stillPrinting.catch(() => undefined);

    mockAwaitOutcome = jest.fn<(remotePath: string) => Promise<PrinterOutcome>>().mockReturnValue(stillPrinting);
    mockReach = jest.fn<Machines>().mockImplementation(async (_printer: RegisteredPrinter): Promise<Printer> => {
      return { send: mockSend, awaitOutcome: mockAwaitOutcome };
    });

    foreman = aForeman(shop, mockReach);
    await addPrinter('mk4');
  });

  afterEach(async () => {
    foremen.forEach((made) => made.stop());
    stopWaiting();
    await Promise.all(foremen.map((made) => made.watchersSettled()));
    foremen.length = 0;

    await fs.rm(spool, { recursive: true, force: true });
  });

  // AIDEV-NOTE: the machine's half of the story. The shop runs unattended for hours, and without
  // these lines the only durable trace of anything is the sentence in `printer.paused.reason` -
  // which says nothing about the prints that went well, or about what happened in what order.
  describe('what it writes down', () => {
    let lines: string[];
    let watched: Foreman;

    beforeEach(() => {
      lines = [];
      watched = aForeman(shop, mockReach, toStdout(() => new Date(), (line) => lines.push(line)));
    });

    it('says what it started, on which printer, and how much gcode went over', async () => {
      const id = await submit();

      await watched.considerStarting();

      expect(lines.join('\n')).toContain(`INFO  started printing printer=mk4 job=${id} displayName="Job 1" gcodeBytes=9`);
    });

    it('says why it could not send one, which is the reason an operator has to act on', async () => {
      await submit();
      mockSend.mockRejectedValue(new Error('OctoPrint upload failed: 400 Bad Request'));

      await watched.considerStarting();

      expect(lines.join('\n')).toContain('ERROR could not send a job to the printer printer=mk4 job=1 why="OctoPrint upload failed: 400 Bad Request"');
    });

    // AIDEV-NOTE: waits for the LINE, not for the job's state. The outcome is written to the store
    // before it is written down here, so waiting on the state wins the race by a tick and this
    // failed about one run in three - a flake that says nothing about the code.
    it('says what the printer made of a print when it ended', async () => {
      await submit();
      mockAwaitOutcome.mockResolvedValue('failed');

      await watched.considerStarting();
      await until(async () => lines.some((line) => line.includes('print ended')));

      expect(lines.join('\n')).toContain('INFO  print ended printer=mk4 outcome=failed');
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

      await aForeman(new JobStore(spool), mockReach).resumeWatching();

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
    it('writes down that it lost the print, and what took it', async () => {
      await submit();
      mockAwaitOutcome.mockRejectedValue(new Error('lost contact for too long'));

      await foreman.considerStarting();

      await until(outOfContact('mk4'));
      expect((await shop.printerNamed('mk4')).outOfContact).toMatchObject({ reason: 'lost contact for too long' });
    });

    // AIDEV-NOTE: it used to be a stop, which asked an operator to confirm something they could not
    // see. As far as anyone knows the machine is still printing, and nothing is idled by this that
    // the print was not idling anyway.
    it('does not stop the printer, which is very likely still printing', async () => {
      await submit();
      mockAwaitOutcome.mockRejectedValue(new Error('lost contact for too long'));

      await foreman.considerStarting();

      await until(outOfContact('mk4'));
      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    // Letting go would queue a job that is on a bed.
    it('keeps the job on the printer', async () => {
      const id = await submit();
      mockAwaitOutcome.mockRejectedValue(new Error('lost contact for too long'));

      await foreman.considerStarting();

      await until(outOfContact('mk4'));
      expect((await shop.printerNamed('mk4')).holding).toMatchObject({ job: id, phase: 'printing' });
    });
  });

  // AIDEV-NOTE: rarer than it looks. The adapter reconnects for as long as the process lives, so a
  // watch is only declared lost after minutes of silence - and the recovery is to listen again and
  // let the machine's own status say what happened while nobody was there.
  describe('listening again for a print it lost', () => {
    let clock: Date;
    let patient: Foreman;

    const laterBy = (ms: number): void => {
      clock = new Date(clock.getTime() + ms);
    };

    beforeEach(async () => {
      clock = new Date('2026-09-09T09:00:00.000Z');
      patient = aForeman(shop, mockReach, silent, () => clock);
      await submit();
      mockAwaitOutcome.mockResolvedValue('finished');
      mockAwaitOutcome.mockRejectedValueOnce(new Error('lost contact for too long'));

      await patient.considerStarting();
      await until(outOfContact('mk4'));

      // AIDEV-NOTE: waiting for the WATCHER, not just for what it wrote. The store shows the loss a
      // tick before the watcher lets go of the printer's name, and a retry started in that gap is
      // refused as a second watch - which is a timeout here and says nothing about the code.
      await patient.watchersSettled();
      mockReach.mockClear();
    });

    // AIDEV-NOTE: a try is taken on by a watcher the clock does not wait for, so these settle it
    // rather than polling what it wrote. The store shows a loss a tick before the watcher lets go of
    // the printer's name, and a try started in that gap is refused as a second watch - which is a
    // timeout that says nothing about the code.
    async function tryAgainAfter(ms: number): Promise<void> {
      laterBy(ms);
      await patient.reachForWhatIsLost();
      await patient.watchersSettled();
    }

    it('leaves the machine alone until it has waited', async () => {
      await tryAgainAfter(0);

      expect(mockReach).not.toHaveBeenCalled();
    });

    it('is hearing it again once the machine answers', async () => {
      await tryAgainAfter(30_000);

      expect((await shop.printerNamed('mk4')).outOfContact).toBeUndefined();
    });

    // The payoff: the print's outcome is written down after all, by the shop that lost it.
    it('writes down how the print ended', async () => {
      await tryAgainAfter(30_000);

      expect(await shop.find(1)).toMatchObject({ state: 'awaiting-approval', lastPrinterOutcome: 'finished' });
    });

    // A machine that has been off for a day is not worth a login every thirty seconds.
    it('waits longer after each try that gets nowhere', async () => {
      mockReach.mockRejectedValue(new Error('nothing is listening at http://mk4'));

      await tryAgainAfter(30_000);
      expect(mockReach).toHaveBeenCalledTimes(1);
      mockReach.mockClear();

      await tryAgainAfter(30_000);
      expect(mockReach).not.toHaveBeenCalled();

      await tryAgainAfter(30_000);
      expect(mockReach).toHaveBeenCalledTimes(1);
    });

    // AIDEV-NOTE: the other half of the rule, and the reason the two are told apart. Having the
    // machine in hand IS contact, so a silence that follows one is a new silence rather than the
    // old one going on - and a machine that keeps dropping its watch costs a login a time, not a
    // plate, so starting over cannot run away.
    it('starts the waiting over once it has heard the machine', async () => {
      mockAwaitOutcome.mockRejectedValue(new Error('lost contact for too long'));
      await tryAgainAfter(30_000);
      mockReach.mockClear();

      await tryAgainAfter(30_000);

      expect(mockReach).toHaveBeenCalledTimes(1);
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

    // AIDEV-NOTE: seen for real before it was guarded against - `printer stopped ... does not
    // resolve` written AFTER `the shop has stopped`, because reaching the machine was still in
    // flight when the shutdown arrived. The attempt fails because of the shutdown, so stopping the
    // printer over it would be blaming a machine for something nobody did to it.
    it('does not stop a printer it could not reach on the way out', async () => {
      await submit();
      let unreachable: (failure: Error) => void = () => undefined;
      mockReach.mockReturnValue(new Promise((_resolve, reject) => (unreachable = reject)));

      const looking = foreman.considerStarting();
      await until(async () => mockReach.mock.calls.length === 1);

      foreman.stop();
      unreachable(new Error('nothing is listening at http://mk4 (ECONNREFUSED)'));
      await looking;

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    // AIDEV-NOTE: the send is in flight when the shutdown arrives, and closing the shop is what
    // breaks it. `startNextPrint` no longer stops the printer over a failed send for exactly this
    // reason - it says it could not start, and the foreman, which knows the shop is closing, decides.
    it('writes nothing against a printer whose upload failed on the way out', async () => {
      await submit();
      let uploadFailed: (failure: Error) => void = () => undefined;
      mockSend.mockReturnValue(new Promise((_resolve, reject) => (uploadFailed = reject)));

      const looking = foreman.considerStarting();
      await until(async () => mockSend.mock.calls.length === 1);

      foreman.stop();
      uploadFailed(new Error('socket hang up'));
      await looking;

      expect(await shop.printerNamed('mk4')).toMatchObject({ paused: undefined, refused: undefined, unreachable: undefined });
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

  // AIDEV-NOTE: the machine ANSWERED - it is reachable, it just would not take the file. Deciding
  // that is the foreman's: `startNextPrint` only reports, because a send that fails during a
  // shutdown is not the printer's fault and only the loop's owner knows that is what happened.
  describe('when a printer will not take a job', () => {
    beforeEach(() => {
      mockSend.mockRejectedValue(new Error('OctoPrint upload failed: 400 Bad Request'));
    });

    it('records what it would not take, and what it said', async () => {
      await submit();

      await foreman.considerStarting();

      expect((await shop.printerNamed('mk4')).refused).toMatchObject({
        reason: '3d-print-shop/job-1.gcode - OctoPrint upload failed: 400 Bad Request',
      });
    });

    // AIDEV-NOTE: the whole reason a refusal is kept apart from being out of reach. The machine has
    // given its answer, and asking again costs a whole plate to be told the same thing.
    it('does not reach for it again on the clock', async () => {
      await submit();
      const patient = aForeman(shop, mockReach, silent, () => new Date('2026-09-09T23:00:00.000Z'));
      await patient.considerStarting();
      mockReach.mockClear();

      await patient.reachForWhatIsLost();

      expect(mockReach).not.toHaveBeenCalled();
    });

    // Nobody stopped anything, so nothing reads as though somebody had.
    it('does not stop the printer', async () => {
      await submit();

      await foreman.considerStarting();

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    // Otherwise one fault against one machine produces one failed upload per job held.
    it('does not try the next job on the same printer', async () => {
      await submit();
      await submit();

      await foreman.considerStarting();
      await foreman.considerStarting();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  // AIDEV-NOTE: the machine went away part way through the upload rather than answering it. That is
  // the same fact as a login that could not be made, and it earns the same retry - one login rather
  // than another plate - which is why the port says which of the two happened.
  describe('when a machine goes away part way through an upload', () => {
    beforeEach(() => {
      mockSend.mockRejectedValue(new CouldNotReach('octopi.local closed the connection'));
    });

    it('takes it as being out of reach rather than as a refusal', async () => {
      await submit();

      await foreman.considerStarting();

      const printer = await shop.printerNamed('mk4');
      expect(printer.unreachable).toMatchObject({ reason: 'octopi.local closed the connection' });
      expect(printer.refused).toBeUndefined();
    });

    it('reaches for it again once it has waited', async () => {
      await submit();
      let clock = new Date('2026-09-09T23:00:00.000Z');
      const patient = aForeman(shop, mockReach, silent, () => clock);
      await patient.considerStarting();
      mockReach.mockClear();

      clock = new Date(clock.getTime() + 30_000);
      await patient.reachForWhatIsLost();

      // Not a count: reaching the machine is what the retry IS, and what the shop does next with a
      // machine that answers is the ordinary look's business.
      expect(mockReach).toHaveBeenCalled();
    });
  });

  describe('when a machine cannot be reached at all', () => {
    beforeEach(() => {
      mockReach.mockRejectedValue(new Error('no API key for mk4'));
    });

    it('writes down that it cannot get to it, and what it saw', async () => {
      await submit();

      await foreman.considerStarting();

      expect((await shop.printerNamed('mk4')).unreachable).toMatchObject({ reason: 'no API key for mk4' });
    });

    // AIDEV-NOTE: it used to be a stop, and an operator had to type `printer start` to clear one.
    // Nothing about the room changed, so there was nothing for them to confirm - and the shop is
    // the only one that can tell when the machine answers again.
    it('does not stop it, since there is nothing for a person to do', async () => {
      await submit();

      await foreman.considerStarting();

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    // Otherwise every change in the shop would produce one more failure against the same machine.
    it('does not try it again on the next look', async () => {
      await submit();
      await foreman.considerStarting();

      await foreman.considerStarting();

      expect(mockReach).toHaveBeenCalledTimes(1);
    });

    // Two printers, because clearing everything would satisfy the test above.
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

  // AIDEV-NOTE: an operator's go is more than a change. The shop is told WHICH machine and that a
  // person has been to look at it - which is the one thing that outranks a wait the shop set itself,
  // and the only way a print nobody is hearing gets picked back up, since looking for work passes
  // over a printer that is holding one.
  describe('when an operator says go', () => {
    it('picks a lost print back up at once', async () => {
      const id = await submit();
      mockAwaitOutcome.mockResolvedValue('finished');
      mockAwaitOutcome.mockRejectedValueOnce(new Error('lost contact for too long'));
      await foreman.considerStarting();
      await until(outOfContact('mk4'));
      await foreman.watchersSettled();
      await shop.resume('mk4');

      await foreman.startAgain('mk4');
      await foreman.watchersSettled();

      expect(await shop.find(id)).toMatchObject({ state: 'awaiting-approval', lastPrinterOutcome: 'finished' });
    });

    it('looks for work the printer can take', async () => {
      await submit();

      await foreman.startAgain('mk4');

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    // Somebody who has just put a machine right should not wait out a wait the shop decided on
    // before they did.
    it('forgets what the printer was waiting out', async () => {
      let clock = new Date('2026-09-09T09:00:00.000Z');
      const patient = aForeman(shop, mockReach, silent, () => clock);
      await submit();
      mockReach.mockRejectedValue(new Error('no API key for mk4'));
      await patient.considerStarting();

      await shop.resume('mk4');
      await patient.startAgain('mk4');
      mockReach.mockClear();

      clock = new Date(clock.getTime() + 30_000);
      await patient.reachForWhatIsLost();

      expect(mockReach).toHaveBeenCalled();
    });
  });

  // AIDEV-NOTE: nobody tells the shop that a machine has come back - it is switched on, or a key is
  // corrected, in a room the shop cannot see. So it asks, on a clock, and a printer that answers is
  // taking work again without anybody having typed anything.
  describe('reaching a machine again by itself', () => {
    let clock: Date;
    let patient: Foreman;

    const laterBy = (ms: number): void => {
      clock = new Date(clock.getTime() + ms);
    };

    // Out of reach for a reason the shop found on its own, which is the only thing this retries.
    async function couldNotBeReached(): Promise<void> {
      mockReach.mockRejectedValue(new Error('no API key for mk4'));
      await patient.considerStarting();
      mockReach.mockClear();
    }

    beforeEach(async () => {
      clock = new Date('2026-09-09T09:00:00.000Z');
      patient = aForeman(shop, mockReach, silent, () => clock);
      await submit();
      await couldNotBeReached();
    });

    it('leaves the machine alone until it has waited', async () => {
      await patient.reachForWhatIsLost();

      expect(mockReach).not.toHaveBeenCalled();
    });

    it('lets go of the fact once the machine answers', async () => {
      mockReach.mockImplementation(async (): Promise<Printer> => ({ send: mockSend, awaitOutcome: mockAwaitOutcome }));
      laterBy(30_000);

      await patient.reachForWhatIsLost();

      expect((await shop.printerNamed('mk4')).unreachable).toBeUndefined();
    });

    // The point of the whole thing: the queue moves again without anybody having typed anything.
    it('starts what was waiting on it', async () => {
      mockReach.mockImplementation(async (): Promise<Printer> => ({ send: mockSend, awaitOutcome: mockAwaitOutcome }));
      laterBy(30_000);

      await patient.reachForWhatIsLost();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    // A machine that has been off for a day is not worth a login every thirty seconds.
    it('waits longer after each try that fails', async () => {
      laterBy(30_000);
      await patient.reachForWhatIsLost();
      mockReach.mockClear();

      laterBy(30_000);
      await patient.reachForWhatIsLost();
      expect(mockReach).not.toHaveBeenCalled();

      laterBy(30_000);
      await patient.reachForWhatIsLost();
      expect(mockReach).toHaveBeenCalledTimes(1);
    });

    // AIDEV-NOTE: what a restart finds - the fact is on disk and nothing is remembered about the
    // last attempt. Trying at once is the point: a shop that has just come up is a good moment to
    // find out, and the cost of being wrong is one login.
    // AIDEV-NOTE: a login answered is not a machine working. The client is kept once it has
    // connected, so answering costs nothing, and the upload that follows can fail all the same -
    // which would be a whole plate every thirty seconds if an answer alone were taken as recovery.
    it('does not start its waiting over just because the machine answered', async () => {
      mockReach.mockImplementation(async (): Promise<Printer> => ({ send: mockSend, awaitOutcome: mockAwaitOutcome }));
      mockSend.mockRejectedValue(new CouldNotReach('octopi.local closed the connection'));
      laterBy(30_000);
      await patient.reachForWhatIsLost();
      mockReach.mockClear();

      laterBy(30_000);
      await patient.reachForWhatIsLost();

      expect(mockReach).not.toHaveBeenCalled();
    });

    it('tries a machine it finds already out of reach', async () => {
      const restarted = aForeman(new JobStore(spool), mockReach, silent, () => clock);

      await restarted.reachForWhatIsLost();

      expect(mockReach).toHaveBeenCalledTimes(1);
    });

    // Reaching the machine says nothing about the reason a person gave.
    it("does not lift an operator's stop", async () => {
      await shop.pause('mk4', 'the door is open');
      laterBy(30_000);

      await patient.reachForWhatIsLost();

      expect(mockReach).not.toHaveBeenCalled();
      expect((await shop.printerNamed('mk4')).paused).toMatchObject({ reason: 'the door is open' });
    });

    it('reaches for nothing on the way out', async () => {
      laterBy(30_000);
      patient.stop();

      await patient.reachForWhatIsLost();

      expect(mockReach).not.toHaveBeenCalled();
    });
  });

  // AIDEV-NOTE: a fault of the SHOP's - the store, the spool - rather than of the machine's. It used
  // to stop the printer, along with everything else that could go wrong inside a start, which put an
  // operator in front of a stopped machine that was never the thing at fault.
  describe('when the shop itself is at fault', () => {
    let lines: string[];
    let watched: Foreman;

    // The job's record goes between reading the queue and claiming the printer, so the failure lands
    // where a store read or a spool that went away would: inside the start, past the machine.
    beforeEach(async () => {
      lines = [];
      watched = aForeman(shop, mockReach, toStdout(() => new Date(), (line) => lines.push(line)));

      const id = await submit();
      mockReach.mockImplementation(async (): Promise<Printer> => {
        await fs.rm(path.join(spool, 'jobs', String(id)), { recursive: true, force: true });

        return { send: mockSend, awaitOutcome: mockAwaitOutcome };
      });
    });

    it('leaves the printer running', async () => {
      await watched.considerStarting();

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });

    it('says what went wrong, since a log line is the only trace of it', async () => {
      await watched.considerStarting();

      expect(lines.join('\n')).toContain('ERROR could not start anything printer=mk4 why="no job 1"');
    });
  });
});
