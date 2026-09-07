import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  UnreadableVolume,
  addPrinter,
  listPrinters,
  loadFilament,
  parseBuildVolume,
  pausePrinter,
  removePrinter,
  resumePrinter,
  shutDownShop,
} from '../src/printerAdmin';
import type { PrinterAdded, PrinterRecord, RegisteredPrinter, Shop } from '@3d-print-shop/client';

describe('parseBuildVolume', () => {
  it.each([
    ['250x210x220', { x: 250, y: 210, z: 220 }],
    ['180x180x180', { x: 180, y: 180, z: 180 }],
  ])('reads %s as three sides in mm', (text, expected) => {
    expect(parseBuildVolume(text)).toEqual(expected);
  });

  it('reads a fractional side', () => {
    expect(parseBuildVolume('250.5x210x220')).toEqual({ x: 250.5, y: 210, z: 220 });
  });

  // AIDEV-NOTE: a bed is two numbers and a build volume is three. Someone will type the bed size,
  // and the message has to say what was missing rather than that something was wrong.
  it('says what it expected when given a bed rather than a volume', () => {
    expect(() => parseBuildVolume('250x210')).toThrow('expected <width>x<depth>x<height> in mm');
  });

  it.each([['250x210x220mm'], ['big'], ['']])('refuses %p', (text) => {
    expect(() => parseBuildVolume(text)).toThrow(UnreadableVolume);
  });
});

// AIDEV-NOTE: the shop is a CLIENT here, not a store - these commands go through the API like every
// other client, so what they are given is an interface and mocking it is mocking the door rather
// than the shop behind it. What the shop does with each call is JobStore's own suite.
describe('minding the printers', () => {
  const mockPrinters = jest.fn<Shop['printers']>();
  const mockAddPrinter = jest.fn<Shop['addPrinter']>();
  const mockRemovePrinter = jest.fn<Shop['removePrinter']>();
  const mockPause = jest.fn<Shop['pause']>();
  const mockResume = jest.fn<Shop['resume']>();
  const mockLoad = jest.fn<Shop['load']>();
  const mockShutDown = jest.fn<Shop['shutDown']>();

  const shop: Shop = {
    printers: mockPrinters,
    addPrinter: mockAddPrinter,
    removePrinter: mockRemovePrinter,
    pause: mockPause,
    resume: mockResume,
    load: mockLoad,
    shutDown: mockShutDown,
    jobs: jest.fn<Shop['jobs']>(),
    job: jest.fn<Shop['job']>(),
    submit: jest.fn<Shop['submit']>(),
    verdict: jest.fn<Shop['verdict']>(),
  };

  function printer(overrides: Partial<RegisteredPrinter> = {}): RegisteredPrinter {
    return {
      name: 'mk4',
      buildVolume: { x: 250, y: 210, z: 220 },
      api: 'octoprint',
      address: 'http://mk4',
      loaded: [],
      ...overrides,
    };
  }

  const added = (record: PrinterRecord, created: boolean): PrinterAdded => ({ printer: { ...record, loaded: [] }, created });

  beforeEach(() => {
    mockPrinters.mockResolvedValue([]);
    mockAddPrinter.mockImplementation(async (record) => added(record, true));
    mockRemovePrinter.mockResolvedValue(undefined);
    mockPause.mockImplementation(async (name, reason) => printer({ name, paused: { reason, since: new Date() } }));
    // The shop really does clear it, and reading the reason after that would find nothing - which is
    // why resumePrinter looks before it asks.
    mockResume.mockImplementation(async (name) => {
      mockPrinters.mockResolvedValue([printer({ name })]);

      return printer({ name });
    });
    mockLoad.mockImplementation(async (name, loaded) => printer({ name, loaded }));
    mockShutDown.mockResolvedValue(undefined);
  });

  describe('adding one', () => {
    it('adds a printer the shop did not have', async () => {
      expect(await addPrinter(shop, 'mk4', '250x210x220', 'http://mk4', 'octoprint')).toEqual([
        'added mk4, 250x210x220mm octoprint at http://mk4',
      ]);
      expect(mockAddPrinter).toHaveBeenCalledWith({
        name: 'mk4',
        buildVolume: { x: 250, y: 210, z: 220 },
        api: 'octoprint',
        address: 'http://mk4',
      });
    });

    // AIDEV-NOTE: adding a name that is already here silently replaces what the shop knew about it.
    // An operator fixing a typo in the NAME would otherwise read "added" and believe they had a
    // second printer. The shop answers 201 or 200; this is what that difference is for.
    it('says it changed a printer rather than added one', async () => {
      mockAddPrinter.mockImplementation(async (record) => added(record, false));

      expect(await addPrinter(shop, 'mk4', '250x210x270', 'http://mk4', 'octoprint')).toEqual([
        'mk4 is now a 250x210x270mm octoprint at http://mk4',
      ]);
    });

    it('refuses a volume it cannot read, before troubling the shop', async () => {
      await expect(addPrinter(shop, 'mk4', '250x210', 'http://mk4', 'octoprint')).rejects.toThrow(UnreadableVolume);
      expect(mockAddPrinter).not.toHaveBeenCalled();
    });
  });

  describe('listing them', () => {
    it('says there are none, and what to do about it', async () => {
      expect(await listPrinters(shop)).toEqual(['no printers - add one before anything can be printed']);
    });

    it('gives each printer, what is on it, and what it is doing', async () => {
      mockPrinters.mockResolvedValue([
        printer({ name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini' }),
        printer({ loaded: ['PLA-Red'], holding: { job: 7, phase: 'printing' } }),
      ]);

      expect(await listPrinters(shop)).toEqual([
        'mini  180x180x180mm  http://mini  nothing loaded  idle',
        'mk4  250x210x220mm  http://mk4  PLA-Red  printing job 7',
      ]);
    });

    // The operator is most often looking at this to find out why nothing is printing.
    it('says which are stopped, and why', async () => {
      mockPrinters.mockResolvedValue([printer({ paused: { reason: 'the door is open', since: new Date() } })]);

      expect(await listPrinters(shop)).toEqual(['mk4  250x210x220mm  http://mk4  nothing loaded  idle  STOPPED: the door is open']);
    });
  });

  describe('saying what is loaded', () => {
    it("takes the operator's word for what is on the machine", async () => {
      expect(await loadFilament(shop, 'mk4', ['PLA-Red'])).toEqual(['mk4 has PLA-Red loaded']);
      expect(mockLoad).toHaveBeenCalledWith('mk4', ['PLA-Red']);
    });

    // Naming none is how an operator says a machine has been emptied, not a mistake to refuse.
    it('takes no filament at all for a machine that has none', async () => {
      expect(await loadFilament(shop, 'mk4', [])).toEqual(['mk4 has nothing loaded']);
    });
  });

  // The shop answers before it stops, so what an operator is told is what it agreed to do.
  describe('closing the shop', () => {
    it('asks it to stop', async () => {
      expect(await shutDownShop(shop)).toEqual(['the shop is stopping']);
      expect(mockShutDown).toHaveBeenCalled();
    });
  });

  describe('taking one out', () => {
    it('removes a printer that is here', async () => {
      expect(await removePrinter(shop, 'mk4')).toEqual(['removed mk4']);
      expect(mockRemovePrinter).toHaveBeenCalledWith('mk4');
    });
  });

  // AIDEV-NOTE: the shop stops a printer itself when an upload fails, and nothing but this starts it
  // again - without it a shop that lost its printer for a moment stays stopped for good.
  describe('stopping and starting', () => {
    it('stops a printer, saying why', async () => {
      expect(await pausePrinter(shop, 'mk4', 'out of filament')).toEqual(['mk4 stopped: out of filament']);
      expect(mockPause).toHaveBeenCalledWith('mk4', 'out of filament');
    });

    it('starts it again, recalling what had stopped it', async () => {
      mockPrinters.mockResolvedValue([printer({ paused: { reason: 'out of filament', since: new Date() } })]);

      expect(await resumePrinter(shop, 'mk4')).toEqual(['mk4 running again, after out of filament']);
      expect(mockResume).toHaveBeenCalledWith('mk4');
    });

    // Rather than reporting a change it did not make.
    it('says a running printer was not stopped', async () => {
      mockPrinters.mockResolvedValue([printer()]);

      expect(await resumePrinter(shop, 'mk4')).toEqual(['mk4 was not stopped']);
    });
  });
});
