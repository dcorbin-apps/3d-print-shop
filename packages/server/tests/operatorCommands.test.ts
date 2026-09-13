import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { reachTheShop, run } from '../src/cli';
import { defaultShopUrl } from '@3d-print-shop/client';
import type { Shop } from '@3d-print-shop/client';
import type { Job, JobsHeld, PrinterAdded, RegisteredPrinter, Verdict } from '@3d-print-shop/client';

// AIDEV-NOTE: argv in, lines out. The note on `createCLI` always said the operator's half could be
// tested without a process; it could not, because reaching the shop and saying a line were both
// wired in. Both are handed over now, so what each command DOES with what it was typed is a plain
// call - where before it took two spawned processes and a socket between them to ask.
//
// What each command MEANS is `jobAdmin` and `printerAdmin`, unit tested against a Shop of their own.
// What is here is the wiring: that argv reaches the right one of them, with the right arguments.
describe('the commands an operator types', () => {
  let mockJobs: jest.Mock<Shop['jobs']>;
  let mockPrinters: jest.Mock<Shop['printers']>;
  let mockWaitingOn: jest.Mock<Shop['waitingOn']>;
  let mockVerdict: jest.Mock<Shop['verdict']>;
  let mockAddPrinter: jest.Mock<Shop['addPrinter']>;
  let mockRemovePrinter: jest.Mock<Shop['removePrinter']>;
  let mockLoad: jest.Mock<Shop['load']>;
  let mockPause: jest.Mock<Shop['pause']>;
  let mockResume: jest.Mock<Shop['resume']>;
  let mockShutDown: jest.Mock<Shop['shutDown']>;
  let shop: Shop;
  let said: string[];
  let reachedWith: { shopUrl?: string }[];

  const mk4: RegisteredPrinter = {
    name: 'mk4',
    buildVolume: { x: 250, y: 210, z: 220 },
    api: 'octoprint',
    address: 'http://octopi.local',
    camera: 'http://octopi.local/webcam/?action=stream',
    loaded: ['PLA-Red'],
  };

  const aJob = (id: number, displayName: string): Job => ({
    id,
    displayName,
    filaments: ['PLA-Red'],
    gcodeBytes: 21,
    state: 'queued',
    submittedAt: new Date('2026-09-06T11:22:04.177Z'),
  });

  const typed = (line: string): Promise<number> =>
    run(['node', 'shop', ...line.split(' ').filter((word) => word !== '')], () => undefined, {
      say: (lines) => said.push(...lines),
      reach: (options) => {
        reachedWith.push(options);

        return shop;
      },
    });

  beforeEach(() => {
    said = [];
    reachedWith = [];

    mockJobs = jest.fn<Shop['jobs']>();
    mockJobs.mockResolvedValue({ accessibleJobs: [], totalJobs: 0 } satisfies JobsHeld);
    mockPrinters = jest.fn<Shop['printers']>();
    mockPrinters.mockResolvedValue([mk4]);
    mockWaitingOn = jest.fn<Shop['waitingOn']>();
    mockWaitingOn.mockResolvedValue([]);
    mockVerdict = jest.fn<Shop['verdict']>();
    mockVerdict.mockResolvedValue(undefined);
    mockAddPrinter = jest.fn<Shop['addPrinter']>();
    mockAddPrinter.mockResolvedValue({ printer: mk4, created: true } satisfies PrinterAdded);
    mockRemovePrinter = jest.fn<Shop['removePrinter']>();
    mockRemovePrinter.mockResolvedValue(undefined);
    mockLoad = jest.fn<Shop['load']>();
    mockLoad.mockResolvedValue(mk4);
    mockPause = jest.fn<Shop['pause']>();
    mockPause.mockResolvedValue({ ...mk4, paused: { reason: 'the door is open', since: new Date() } });
    mockResume = jest.fn<Shop['resume']>();
    mockResume.mockResolvedValue(mk4);
    mockShutDown = jest.fn<Shop['shutDown']>();
    mockShutDown.mockResolvedValue(undefined);

    shop = {
      jobs: mockJobs,
      printers: mockPrinters,
      waitingOn: mockWaitingOn,
      verdict: mockVerdict,
      addPrinter: mockAddPrinter,
      removePrinter: mockRemovePrinter,
      load: mockLoad,
      pause: mockPause,
      resume: mockResume,
      shutDown: mockShutDown,
    } as unknown as Shop;
  });

  describe('about the work', () => {
    it('shows what the shop is holding', async () => {
      mockJobs.mockResolvedValue({ accessibleJobs: [aJob(1, 'Player Box')], totalJobs: 1 });

      expect(await typed('job list')).toBe(0);
      expect(mockJobs).toHaveBeenCalledTimes(1);
      expect(said.join('\n')).toContain('Player Box');
    });

    // The operator standing at a machine asks about that machine, and a job it could never take is
    // not work it is waiting on.
    it('asks what to load next, for the whole shop', async () => {
      await typed('job waiting');

      expect(mockWaitingOn).toHaveBeenCalledWith(undefined);
    });

    it('asks what to load next at the machine the operator named', async () => {
      await typed('job waiting mk4');

      expect(mockWaitingOn).toHaveBeenCalledWith('mk4');
    });

    it.each<[string, Verdict]>([
      ['approve', 'approved'],
      ['reject', 'rejected'],
      ['abandon', 'abandoned'],
    ])('gives %s as the verdict %s', async (word, verdict) => {
      await typed(`job ${word} 7`);

      expect(mockVerdict).toHaveBeenCalledWith(7, verdict);
    });

    // `readJobId` refuses what is not a counting number, and the command answers that as a failure
    // rather than asking the shop about job NaN.
    it('refuses an id that is not one, without asking the shop', async () => {
      expect(await typed('job approve seven')).toBe(1);
      expect(mockVerdict).not.toHaveBeenCalled();
    });
  });

  describe('about the printers', () => {
    it('adds one, reading the build volume the operator typed', async () => {
      await typed('printer add mk4 250x210x220 http://octopi.local');

      expect(mockAddPrinter).toHaveBeenCalledWith(expect.objectContaining({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 } }));
    });

    it('refuses a build volume it cannot read, without asking the shop', async () => {
      expect(await typed('printer add mk4 250x210 http://octopi.local')).toBe(1);
      expect(mockAddPrinter).not.toHaveBeenCalled();
    });

    it('lists them', async () => {
      await typed('printer list');

      expect(mockPrinters).toHaveBeenCalledTimes(1);
      expect(said.join('\n')).toContain('mk4');
    });

    it('takes one out', async () => {
      await typed('printer remove mk4');

      expect(mockRemovePrinter).toHaveBeenCalledWith('mk4');
    });

    it('says what is loaded, in the order it was typed', async () => {
      await typed('printer load mk4 PLA-Red PLA-Blue');

      expect(mockLoad).toHaveBeenCalledWith('mk4', ['PLA-Red', 'PLA-Blue']);
    });

    it('stops one with the reason a person should see', async () => {
      await typed('printer stop mk4 the-door-is-open');

      expect(mockPause).toHaveBeenCalledWith('mk4', 'the-door-is-open');
    });

    it('starts one again', async () => {
      await typed('printer start mk4');

      expect(mockResume).toHaveBeenCalledWith('mk4');
    });
  });

  it('asks the shop to stop', async () => {
    await typed('shutdown');

    expect(mockShutDown).toHaveBeenCalledTimes(1);
  });

  // AIDEV-NOTE: every command that reaches the shop takes it, because an operator may mind a shop
  // running somewhere else - that is the whole reason these go through the API rather than reaching
  // into the data directory.
  describe('where the shop is', () => {
    it.each([['job list'], ['printer list'], ['shutdown']])('is whatever --shop-url says, for %p', async (line) => {
      await typed(`${line} --shop-url http://elsewhere:7373`);

      expect(reachedWith).toEqual([{ shopUrl: 'http://elsewhere:7373' }]);
    });

    it('is left to the client to decide when nobody said', async () => {
      await typed('job list');

      expect(reachedWith).toEqual([{}]);
    });
  });

  // AIDEV-NOTE: the default way a command reaches the shop, which every test above replaces - so
  // without this the one line that reads `--shop-url` is the one line nothing looks at. Asked of a
  // port nothing is on, because a client that cannot reach a shop says WHICH shop it could not
  // reach, and that names the url it was built with.
  describe('the client a command reaches the shop with by default', () => {
    it('is pointed where --shop-url says', async () => {
      await expect(reachTheShop({ shopUrl: 'http://127.0.0.1:1' }).jobs()).rejects.toThrow('http://127.0.0.1:1');
    });

    it('is pointed where a client decides when nobody said', async () => {
      await expect(reachTheShop({}).jobs()).rejects.toThrow(defaultShopUrl());
    });
  });

  // A failure from the shop is the operator's answer, and it is a failure of the command too.
  it('answers a refusal from the shop as a failure', async () => {
    mockPrinters.mockRejectedValue(new Error('no printer called ender'));

    expect(await typed('printer list')).toBe(1);
  });
});
