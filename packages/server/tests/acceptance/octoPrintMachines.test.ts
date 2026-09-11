import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { rm } from 'node:fs/promises';
import { startOctoPrintServer } from '@3d-print-shop/octoprint-sim';
import type { OctoPrintServer } from '@3d-print-shop/octoprint-sim';
import { JobStore } from '../../src/JobStore';
import { OctoPrintMachines } from '../../src/OctoPrintMachines';
import type { OctoPrint } from '../../src/OctoPrint';
import { aDataDirectory, parentOf } from '../aDataDirectory';
import type { DataLayout } from '../../src/dataLayout';

// AIDEV-NOTE: a real socket to a real stand-in OctoPrint, because both claims here are about the
// CONNECTION and neither is visible from a mock: that reaching a printer opens one before anything
// is sent, and that reaching the same printer twice does not open a second.
describe('reaching a printer', () => {
  let server: OctoPrintServer | undefined;
  let where: DataLayout;
  let shop: JobStore;
  let machines: OctoPrintMachines;
  let keys: Map<string, string>;

  async function addPrinter(name: string, address: string): Promise<void> {
    await shop.addPrinter({ name, buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address });
  }

  beforeEach(async () => {
    keys = new Map([['mk4', 'a-key']]);
    where = await aDataDirectory('print-shop-machines-');
    shop = new JobStore(where);
    machines = new OctoPrintMachines(() => keys);

    server = await startOctoPrintServer(0, () => undefined);
    await addPrinter('mk4', `http://127.0.0.1:${server.port}`);
  });

  // AIDEV-NOTE: a client left connected reconnects for ever - by design, since an in-flight print
  // has no other way to learn its outcome - and those timers keep the event loop alive, so jest
  // never exits. One failing assertion would otherwise hang the whole suite.
  afterEach(async () => {
    for (const printer of await shop.printers()) {
      ((await machines.reach(printer).catch(() => undefined)) as OctoPrint | undefined)?.disconnect();
    }

    await server?.close();
    server = undefined;
    await rm(parentOf(where), { recursive: true, force: true });
  });

  // After a restart the first thing that happens to a printer already printing is being WATCHED,
  // and nothing sends it anything - so a client connected lazily on first send never connects.
  it('opens the connection before anything is sent', async () => {
    await machines.reach(await shop.printerNamed('mk4'));

    expect(server!.connectionsAccepted()).toBe(1);
  });

  // awaitOutcome resolves on the socket its own client holds open, so a watcher handed a fresh
  // client would wait on a machine nobody was listening to.
  it('answers with the same client for the same printer', async () => {
    const first = await machines.reach(await shop.printerNamed('mk4'));

    expect(await machines.reach(await shop.printerNamed('mk4'))).toBe(first);
    expect(server!.connectionsAccepted()).toBe(1);
  });

  // The operator moved the machine. The old client is talking to the wrong address.
  it('answers with a new client when the printer has moved', async () => {
    const first = await machines.reach(await shop.printerNamed('mk4'));
    const moved = await startOctoPrintServer(0, () => undefined);
    await addPrinter('mk4', `http://127.0.0.1:${moved.port}`);

    try {
      expect(await machines.reach(await shop.printerNamed('mk4'))).not.toBe(first);
      expect(moved.connectionsAccepted()).toBe(1);
    } finally {
      ((await machines.reach(await shop.printerNamed('mk4'))) as OctoPrint).disconnect();
      await moved.close();
    }
  });

  // An empty variable is a machine somebody meant to configure and did not, which is worth the same
  // message as one nobody set at all.
  // AIDEV-NOTE: nothing lets go on its own - a client left connected reconnects for as long as the
  // process lives, by design, since an in-flight print has no other way to report its outcome. What
  // proves the machine really was let go is a caller waiting on it being told so.
  it('lets go of every machine when the shop closes', async () => {
    const machine = await machines.reach(await shop.printerNamed('mk4'));
    const waiting = machine.awaitOutcome('plates/job-1.gcode');

    machines.closeAll();

    await expect(waiting).rejects.toThrow('closed');
  });

  it('reaches a new client once it has let go of the old one', async () => {
    const first = await machines.reach(await shop.printerNamed('mk4'));
    machines.closeAll();

    expect(await machines.reach(await shop.printerNamed('mk4'))).not.toBe(first);
  });

  // The operator corrected a key that was wrong. The old client is talking to the right machine with
  // a key it will not accept, and nothing else in the shop would ever notice.
  it('answers with a new client carrying a key that has been corrected', async () => {
    const first = await machines.reach(await shop.printerNamed('mk4'));
    keys.set('mk4', 'a-corrected-key');

    expect(await machines.reach(await shop.printerNamed('mk4'))).not.toBe(first);
    expect(server!.keysPresented()).toEqual(['a-key', 'a-corrected-key']);
  });

  it('refuses a printer whose key was left blank', async () => {
    keys.set('mk4', '  ');

    await expect(machines.reach(await shop.printerNamed('mk4'))).rejects.toThrow('no API key for mk4');
  });

  // Named rather than numbered, so an operator is told which file to put it in and under what.
  it('refuses a printer nobody has given a key, saying where one goes', async () => {
    await addPrinter('mini', `http://127.0.0.1:${server!.port}`);

    await expect(machines.reach(await shop.printerNamed('mini'))).rejects.toThrow('no API key for mini - the shop reads it from printer-keys.json');
  });
});
