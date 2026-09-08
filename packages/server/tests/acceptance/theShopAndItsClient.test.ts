import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { HttpShop } from '@3d-print-shop/client';
import type { PrinterRecord } from '@3d-print-shop/client';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { serve } from '../../src/api';
import { JobStore } from '../../src/JobStore';

// AIDEV-NOTE: the two halves of the contract against each other - the client from
// @3d-print-shop/client, the real routes over a real socket. Neither side's own suite can catch the
// two disagreeing: the client's is against a stand-in, and the shop's is against fetch by hand.
// This is the only place both are true at once, which is what keeps a published client honest.
describe('the shop and its client', () => {
  let spool: string;
  let store: JobStore;
  let server: Server;
  let shop: HttpShop;

  const MK4: PrinterRecord = {
    name: 'mk4',
    buildVolume: { x: 250, y: 210, z: 220 },
    api: 'octoprint',
    address: 'http://octopi.local',
  };

  const gcode = (): Blob => new Blob(['G1 X100.000 Y100.000\n']);

  // The token is given to the client rather than read from the environment: what is under test is
  // the client putting one on the wire, and a suite that took whatever token the machine happened
  // to have would pass or fail on the machine rather than on the code.
  const TOKEN = 'dave-token';

  beforeEach(async () => {
    spool = await mkdtemp(path.join(tmpdir(), 'print-shop-contract-'));
    store = new JobStore(spool);

    server = await serve(store, 0, { callers: new Map([[TOKEN, { id: 'dave', name: 'dave', role: 'admin' }]]) });
    shop = new HttpShop(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, TOKEN);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(spool, { recursive: true, force: true });
  });

  describe('the printers', () => {
    it('adds one the shop did not have, and says it was new', async () => {
      const { printer, created } = await shop.addPrinter(MK4);

      expect(created).toBe(true);
      expect(printer).toEqual({ ...MK4, loaded: [] });
    });

    it('says it changed one the shop already had', async () => {
      await shop.addPrinter(MK4);

      expect((await shop.addPrinter({ ...MK4, buildVolume: { x: 250, y: 210, z: 270 } })).created).toBe(false);
    });

    it('lists what the shop has', async () => {
      await shop.addPrinter(MK4);

      expect(await shop.printers()).toEqual([{ ...MK4, loaded: [] }]);
    });

    it('takes one out again', async () => {
      await shop.addPrinter(MK4);
      await shop.removePrinter('mk4');

      expect(await shop.printers()).toEqual([]);
    });

    // The reason the client parses times rather than casting them: the shop writes an ISO string.
    it('reads back the time a printer stopped as a time', async () => {
      await shop.addPrinter(MK4);

      expect((await shop.pause('mk4', 'the door is open')).paused?.since).toBeInstanceOf(Date);
    });

    it('starts it again', async () => {
      await shop.addPrinter(MK4);
      await shop.pause('mk4', 'the door is open');

      expect(await shop.resume('mk4')).toEqual({ ...MK4, loaded: [] });
    });

    it('says what is loaded on a machine', async () => {
      await shop.addPrinter(MK4);

      expect(await shop.load('mk4', ['PLA-Red'])).toMatchObject({ loaded: ['PLA-Red'] });
    });

    it('minds a printer whose name has to be escaped to reach it', async () => {
      await shop.addPrinter({ ...MK4, name: 'mk4#2' });

      expect(await shop.load('mk4#2', ['PLA-Red'])).toMatchObject({ name: 'mk4#2', loaded: ['PLA-Red'] });
    });

    it('repeats what the shop said when it refuses', async () => {
      await expect(shop.removePrinter('ender')).rejects.toThrow('no printer called ender');
    });
  });

  describe('the jobs', () => {
    beforeEach(async () => {
      await shop.addPrinter(MK4);
    });

    it('takes a job in and hands back what the shop holds', async () => {
      const job = await shop.submit({ filaments: ['PLA-SpaceGray'], displayName: 'Player Box' }, gcode());

      expect(job).toMatchObject({ id: 1, displayName: 'Player Box', state: 'queued' });
      expect(job.submittedAt).toBeInstanceOf(Date);
    });

    it('lists what is outstanding, in the order the shop took it', async () => {
      await shop.submit({ filaments: ['PLA-SpaceGray'], displayName: 'Player Box' }, gcode());
      await shop.submit({ filaments: ['PLA-Red'] }, gcode());

      expect((await shop.jobs()).accessibleJobs.map((job) => job.displayName)).toEqual(['Player Box', 'Job 2']);
    });

    it('asks after one by id', async () => {
      const { id } = await shop.submit({ filaments: ['PLA-SpaceGray'] }, gcode());

      expect(await shop.job(id)).toMatchObject({ id });
    });

    it('refuses a job no printer here could take, in the words the shop used', async () => {
      const tooTall = { filaments: ['PLA-SpaceGray'], requiredBuildVolume: { x: 100, y: 100, z: 400 } };

      await expect(shop.submit(tooTall, gcode())).rejects.toThrow('nothing here has room for 100x100x400mm');
    });

    describe('once one has been printed', () => {
      let id: number;

      beforeEach(async () => {
        id = (await shop.submit({ filaments: ['PLA-SpaceGray'] }, gcode())).id;
        await store.startPrinting('mk4', id);
        await store.finishedPrinting('mk4', 'finished');
      });

      it('sends it back to the queue when a person rejects it', async () => {
        expect(await shop.verdict(id, 'rejected')).toMatchObject({ id, state: 'queued' });
      });

      // Approved work leaves the shop entirely, so there is nothing to answer with.
      it('answers with nothing when a person approves it', async () => {
        expect(await shop.verdict(id, 'approved')).toBeUndefined();
        expect(await shop.jobs()).toEqual({ accessibleJobs: [], totalJobs: 0 });
      });

      // The verdict is what frees the BED, not just the job.
      it('frees the printer that was holding it', async () => {
        await shop.verdict(id, 'approved');

        expect((await shop.printers())[0].holding).toBeUndefined();
      });
    });
  });
});
