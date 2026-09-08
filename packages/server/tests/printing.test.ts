import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { JobStore } from '../src/JobStore';
import { recordOutcome, remotePathFor, startNextPrint } from '../src/printing';
import type { Printer } from '../src/printing';
import type { PrintAttempt } from '../src/printing';
import type { Job, PrinterOutcome } from '../src/Job';

describe('printing the next job', () => {
  let spool: string;
  let shop: JobStore;
  let mockSend: jest.Mock<(remotePath: string, gcode: Readable) => Promise<string>>;
  let mockAwaitOutcome: jest.Mock<(remotePath: string) => Promise<PrinterOutcome>>;
  let machine: Printer;

  // Every submission carries a caller: the shop answers nobody it cannot name, so there is no such
  // thing as a job that arrived unowned. Whose it is matters in `who a job belongs to` below; the
  // rest of these say it once, here.
  const DAVE = 'u-dave';

  async function submit(filaments: string[], overrides: Record<string, unknown> = {}): Promise<Job> {
    return shop.submit({ filaments, ...overrides }, Readable.from(['G1 X0 Y0\n']), DAVE);
  }

  // What a printer can print is what is loaded ON it now, so saying so is part of setting one up.
  async function printOn(name: string, loaded: string[]): Promise<PrintAttempt> {
    await shop.load(name, loaded);

    return startNextPrint(shop, async () => machine, name);
  }

  beforeEach(async () => {
    spool = await fs.mkdtemp(path.join(tmpdir(), 'print-shop-printing-'));
    shop = new JobStore(spool);

    // A machine that files a job where it was asked to, which is the ordinary case. A test about one
    // that files it somewhere else says so itself.
    mockSend = jest.fn<(remotePath: string, gcode: Readable) => Promise<string>>().mockImplementation((remotePath) => Promise.resolve(remotePath));
    mockAwaitOutcome = jest.fn<(remotePath: string) => Promise<PrinterOutcome>>().mockResolvedValue('finished');
    machine = { send: mockSend, awaitOutcome: mockAwaitOutcome };

    await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://mk4' });
    await shop.addPrinter({ name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, api: 'octoprint', address: 'http://mini' });
  });

  afterEach(async () => {
    await fs.rm(spool, { recursive: true, force: true });
  });

  describe('when a job can be printed', () => {
    // AIDEV-NOTE: answers as soon as the machine HAS the file. A print runs for hours; waiting here
    // would make its outcome something only a live stack frame knows, lost to a restart. What the
    // printer is holding is written down instead, and recordOutcome watches it from there.
    it('answers as soon as the machine has taken the file', async () => {
      const job = await submit(['PLA-Red']);

      const attempt = await printOn('mk4', ['PLA-Red']);

      expect(attempt).toMatchObject({ did: 'started', job: { id: job.id } });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockAwaitOutcome).not.toHaveBeenCalled();
    });

    it('leaves the printer holding it, so nothing else starts on that bed', async () => {
      const job = await submit(['PLA-Red']);

      await printOn('mk4', ['PLA-Red']);

      expect((await shop.printerNamed('mk4')).holding).toEqual({ job: job.id, phase: 'printing', remotePath: remotePathFor(job) });
    });

    it('sends the gcode that was stored with it', async () => {
      await submit(['PLA-Red']);

      await printOn('mk4', ['PLA-Red']);

      const [, gcode] = mockSend.mock.calls[0];
      const chunks: Buffer[] = [];
      for await (const chunk of gcode) chunks.push(Buffer.from(chunk as Buffer));
      expect(Buffer.concat(chunks).toString()).toBe('G1 X0 Y0\n');
    });

    it('takes the path the client asked for', async () => {
      await submit(['PLA-Red'], { remotePath: 'plates/cards.gcode' });

      await printOn('mk4', ['PLA-Red']);

      expect(mockSend.mock.calls[0][0]).toBe('plates/cards.gcode');
    });

    // From the id, not the display name: ids are unique and safe in a path, names are neither.
    it('makes a path for a client that asked for none', async () => {
      await submit(['PLA-Red'], { displayName: 'Player Box / mk2' });

      await printOn('mk4', ['PLA-Red']);

      expect(mockSend.mock.calls[0][0]).toBe('3d-print-shop/job-1.gcode');
    });
  });

  describe('when nothing can be printed', () => {
    // Reaching a machine means opening a socket to it, and the shop looks for work after every
    // change it makes - so an eager reach would connect to every idle printer every time.
    it('does not reach a printer it has nothing to send', async () => {
      let reached = 0;

      await startNextPrint(
        shop,
        async () => {
          reached++;
          return machine;
        },
        'mk4',
      );

      expect(reached).toBe(0);
    });

    it('does nothing when what is loaded prints nothing', async () => {
      await submit(['PLA-Red']);

      expect(await printOn('mk4', ['PLA-Blue'])).toEqual({ did: 'nothing', because: 'nothing-printable' });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does nothing when the shop is holding no jobs at all', async () => {
      expect(await printOn('mk4', ['PLA-Red'])).toEqual({ did: 'nothing', because: 'nothing-printable' });
    });
  });

  // AIDEV-NOTE: the upload failed, so no filament was spent. The job goes back exactly as it was,
  // and what to make of the failure is left to whoever owns the loop: the same send fails because
  // the shop is closing the machines, and only the caller knows that is what happened.
  describe('when the printer will not take the job', () => {
    beforeEach(() => {
      mockSend.mockRejectedValue(new Error('connection refused'));
    });

    it('says it could not start, where it was sending, and why', async () => {
      const job = await submit(['PLA-Red']);

      const attempt = await printOn('mk4', ['PLA-Red']);

      expect(attempt).toMatchObject({ did: 'could-not-start', remotePath: remotePathFor(job) });
      expect((attempt as { failure: Error }).failure.message).toBe('connection refused');
    });

    it('puts the job back by letting go of it', async () => {
      const job = await submit(['PLA-Red']);

      await printOn('mk4', ['PLA-Red']);

      expect(await shop.find(job.id)).toMatchObject({ state: 'queued' });
    });

    it('leaves the printer running, having stopped nothing itself', async () => {
      await submit(['PLA-Red']);

      await printOn('mk4', ['PLA-Red']);

      expect((await shop.printerNamed('mk4')).paused).toBeUndefined();
    });
  });

  // AIDEV-NOTE: the other half of startNextPrint, and the reason it can answer early. Started fresh
  // after a restart from the printer's own status: a print that was running when the shop went down
  // is still running, and its outcome is still worth having.
  describe('watching a print to its end', () => {
    // `finished` says the machine reached the end, not that what came off the bed is usable - so it
    // waits for a person either way, and the printer goes on holding the bed until then.
    it.each<[PrinterOutcome]>([['finished'], ['failed'], ['cancelled']])('leaves a %s print waiting for a verdict', async (outcome) => {
      const job = await submit(['PLA-Red']);
      mockAwaitOutcome.mockResolvedValue(outcome);
      await printOn('mk4', ['PLA-Red']);

      expect(await recordOutcome(shop, machine, 'mk4')).toBe(outcome);

      expect(await shop.find(job.id)).toMatchObject({ state: 'awaiting-approval', lastPrinterOutcome: outcome });
    });

    it('watches the path the job was sent to', async () => {
      const job = await submit(['PLA-Red'], { remotePath: 'plates/cards.gcode' });
      await printOn('mk4', ['PLA-Red']);

      await recordOutcome(shop, machine, 'mk4');

      expect(mockAwaitOutcome).toHaveBeenCalledWith(remotePathFor(job));
    });

    // AIDEV-NOTE: the machine files a job where it likes - OctoPrint transliterates a name it cannot
    // store - and its completion event carries THAT path. A shop watching the path it asked for
    // would wait for an event that never comes, for a print that has already finished.
    it('watches where the machine said it filed it, not where it was asked to', async () => {
      await submit(['PLA-Red'], { remotePath: 'plates/ümläut.gcode' });
      mockSend.mockResolvedValue('plates/umlaut.gcode');
      await printOn('mk4', ['PLA-Red']);

      await recordOutcome(shop, machine, 'mk4');

      expect(mockAwaitOutcome).toHaveBeenCalledWith('plates/umlaut.gcode');
    });

    it('writes down where the machine filed it, so a later run watches the same path', async () => {
      await submit(['PLA-Red']);
      mockSend.mockResolvedValue('somewhere/else.gcode');

      await printOn('mk4', ['PLA-Red']);

      expect((await shop.printerNamed('mk4')).holding?.remotePath).toBe('somewhere/else.gcode');
    });

    // What a run started before the shop read that answer back looks like, and what an interrupted
    // one leaves: a holding with no path at all. The shop's own guess is what is left to watch.
    it('falls back to the path it asked for when nothing recorded one', async () => {
      const job = await submit(['PLA-Red'], { remotePath: 'plates/cards.gcode' });
      await shop.startPrinting('mk4', job.id);

      await recordOutcome(shop, machine, 'mk4');

      expect(mockAwaitOutcome).toHaveBeenCalledWith('plates/cards.gcode');
    });

    // A restarted service knows only what the printer's status says, which is enough.
    it('picks up a print a previous run started', async () => {
      await submit(['PLA-Red']);
      await printOn('mk4', ['PLA-Red']);

      await recordOutcome(new JobStore(spool), machine, 'mk4');

      expect(await new JobStore(spool).find(1)).toMatchObject({ state: 'awaiting-approval' });
    });

    it('refuses to watch a printer that is printing nothing', async () => {
      await expect(recordOutcome(shop, machine, 'mk4')).rejects.toThrow('not printing anything');
    });
  });

  // AIDEV-NOTE: a broken machine must not idle a working one. This is why the pause is keyed on the
  // printer rather than being a property of the shop.
  describe('with more than one printer', () => {
    // AIDEV-NOTE: the pause consulted has to be THIS printer's. Checking the unnamed one instead
    // looks right whenever only unnamed printers are stopped, which is why both directions are here.
    it('will not print on a machine that was stopped', async () => {
      await submit(['PLA-Red'], { printer: 'mk4' });
      await shop.pause('mk4', 'the door is open');

      expect(await printOn('mk4', ['PLA-Red'])).toEqual({ did: 'nothing', because: 'paused' });
    });

    it('prints on a named machine while the unnamed one is stopped', async () => {
      await submit(['PLA-Red'], { printer: 'mk4' });
      await shop.pause('mini', 'nothing to do with mk4');

      expect(await printOn('mk4', ['PLA-Red'])).toMatchObject({ did: 'started' });
    });

    it('goes on printing on a machine that is working', async () => {
      await submit(['PLA-Red'], { printer: 'mk4' });
      await submit(['PLA-Red'], { printer: 'mini' });
      mockSend.mockRejectedValueOnce(new Error('connection refused'));

      await printOn('mk4', ['PLA-Red']);

      expect(await printOn('mini', ['PLA-Red'])).toMatchObject({ did: 'started' });
    });
  });
});
