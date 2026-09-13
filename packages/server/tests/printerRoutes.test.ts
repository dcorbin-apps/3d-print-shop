import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createApi } from '../src/api';
import { Callers } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { digestOf } from '../src/secrets';
import { aDataDirectory, parentOf } from './aDataDirectory';
import { drive } from './inProcess';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: what a body may SAY is `loadedIn`, `stoppedIn`, `printerIn` and `keyIn`, each a plain
// function over a value and each unit tested in tests/api.test.ts. What is here is what needs the
// STORE: a printer added and read back, one taken out, filament that survives the round trip, a stop
// an operator can see afterwards - and the hand-over of a key, which is the running shop's business.
//
// The app answers in-process. What that costs is a socket, which was never what any of this claimed.
describe('the printers, over the shop routes', () => {
  let where: DataLayout;
  let shop: JobStore;
  let asked: ReturnType<typeof drive>;
  let mockKeyGiven: jest.Mock<(printer: string, key: string) => Promise<void>>;

  const ADMIN = 'dave-token';
  const USER = 'slicer-token';
  const MK4 = { x: 250, y: 210, z: 220 };
  const MK4_ADDRESS = 'http://octopi.local';
  const asRegistered = {
    name: 'mk4',
    buildVolume: MK4,
    api: 'octoprint',
    address: MK4_ADDRESS,
    camera: `${MK4_ADDRESS}/webcam/?action=stream`,
    loaded: [],
  };

  const callers = new Callers([
    { caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] },
    { caller: { id: 'slicer', name: 'slicer', role: 'user' }, credentials: [{ kind: 'token', hash: digestOf(USER) }] },
  ]);

  const send = (method: string, path: string, json?: unknown): ReturnType<typeof asked> => asked(method, path, { token: ADMIN, json });
  const ask = (path: string): ReturnType<typeof asked> => asked('GET', path, { token: ADMIN });

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-printers-');
    shop = new JobStore(where);
    await shop.addPrinter({ name: 'mk4', buildVolume: MK4, api: 'octoprint', address: MK4_ADDRESS });

    mockKeyGiven = jest.fn<(printer: string, key: string) => Promise<void>>();
    mockKeyGiven.mockResolvedValue(undefined);
    asked = drive(createApi(shop, { callers: () => callers, keyGiven: mockKeyGiven }));
  });

  afterEach(async () => {
    await rm(parentOf(where), { recursive: true, force: true });
  });

  describe('one the shop is given', () => {
    const mini = { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini.local' };

    it('is added, and answered with what the shop now knows of it', async () => {
      const answer = await send('POST', '/printers', mini);

      expect(answer.status).toBe(201);
      expect(answer.body).toEqual({ ...mini, api: 'octoprint', camera: `${mini.address}/webcam/?action=stream`, loaded: [] });
    });

    // Adding one that is already here changes its build volume rather than failing, so the answer
    // has to say which of the two happened.
    it('is a change rather than an addition when the shop has it already', async () => {
      const taller = { x: 250, y: 210, z: 270 };

      const answer = await send('POST', '/printers', { name: 'mk4', buildVolume: taller, address: MK4_ADDRESS });

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ ...asRegistered, buildVolume: taller });
    });

    it('is refused when the body is not JSON at all', async () => {
      const answer = await asked('POST', '/printers', { token: ADMIN, body: Buffer.from('{ name: mini'), contentType: 'application/json' });

      expect(answer.status).toBe(400);
    });

    it('is taken out again when the operator says so', async () => {
      expect((await send('DELETE', '/printers/mk4')).status).toBe(204);
      expect((await ask('/printers')).body).toEqual([]);
    });

    it('is no such printer when the shop never had it', async () => {
      const answer = await send('DELETE', '/printers/ender');

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ error: 'no printer called ender - the operator adds one before it can print' });
    });
  });

  // AIDEV-NOTE: no printer here reports its own filament, so this is the operator's word and the
  // only record of what a machine can print right now.
  describe('what an operator says is loaded', () => {
    it('is kept in the order it was given', async () => {
      const answer = await send('PUT', '/printers/mk4/filament', { loaded: ['PLA-Red', 'PLA-Blue'] });

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ name: 'mk4', loaded: ['PLA-Red', 'PLA-Blue'] });
    });

    // Naming none is how an operator says a machine has been emptied.
    it('is nothing at all when the machine has been emptied', async () => {
      await send('PUT', '/printers/mk4/filament', { loaded: ['PLA-Red'] });

      expect((await send('PUT', '/printers/mk4/filament', { loaded: [] })).body).toMatchObject({ loaded: [] });
    });

    it('is refused for a printer the shop does not have', async () => {
      expect((await send('PUT', '/printers/ender/filament', { loaded: ['PLA-Red'] })).status).toBe(404);
    });
  });

  describe('stopping a printer and starting it', () => {
    it('is stopped with the reason an operator should see', async () => {
      const answer = await send('PUT', '/printers/mk4/status', { stopped: true, reason: 'door is open' });

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ name: 'mk4', paused: { reason: 'door is open' } });
    });

    it('is started again, with the trouble gone', async () => {
      await shop.pause(await shop.printerNamed('mk4'), 'door is open');

      expect((await send('PUT', '/printers/mk4/status', { stopped: false })).body).toEqual(asRegistered);
    });
  });

  // AIDEV-NOTE: the key arrives WITH the printer, in one call, because adding a machine is one act -
  // two would let a printer land without the key it is reached by. Where the key is KEPT is the
  // running shop's business rather than the store's, so what is asserted here is the hand-over.
  describe('the key a printer is reached by', () => {
    const mini = { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini' };
    const adding = (body: unknown, token = ADMIN): ReturnType<typeof asked> => asked('POST', '/printers', { token, json: body });

    it('is handed to whoever keeps the keys, in the call that adds the printer', async () => {
      expect((await adding({ ...mini, key: 'mini-key' })).status).toBe(201);
      expect(mockKeyGiven).toHaveBeenCalledWith('mini', 'mini-key');
    });

    // The printer is what the caller gets back - its trouble is the thing they are waiting to clear -
    // and the key is not in it. There is no reading one back at all.
    it('is not in what the shop answers with', async () => {
      const said = JSON.stringify((await adding({ ...mini, key: 'mini-key' })).body);

      expect(said).toContain('mini');
      expect(said).not.toContain('mini-key');
    });

    // AIDEV-NOTE: the record is built from the four fields a printer IS, so a key in the body cannot
    // follow it into printer.json - which is a working directory rather than a credential store.
    it('never reaches the printer the shop wrote down', async () => {
      await adding({ ...mini, key: 'mini-key' });

      expect(JSON.stringify((await ask('/printers')).body)).not.toContain('mini-key');
    });

    it('is not required, because a printer the shop already has a key for keeps it', async () => {
      expect((await adding(mini)).status).toBe(201);
      expect(mockKeyGiven).not.toHaveBeenCalled();
    });

    // `keyIn` refuses four kinds of non-key in tests/api.test.ts. What is left here is the half it
    // cannot reach: a refused key leaves no printer behind it either.
    it('refuses a key that is no key, and adds nothing', async () => {
      expect((await adding({ ...mini, key: '' })).status).toBe(400);
      expect(mockKeyGiven).not.toHaveBeenCalled();
      expect(JSON.stringify((await ask('/printers')).body)).not.toContain('mini');
    });

    // A key is an admin's, like every other thing about a printer.
    it('is refused to a user outright', async () => {
      expect((await adding({ ...mini, key: 'mini-key' }, USER)).status).toBe(403);
      expect(mockKeyGiven).not.toHaveBeenCalled();
    });

    // A shop given nowhere to keep one says so rather than taking the printer and losing the key,
    // which would be the half-added machine this route exists to avoid.
    it('is refused by a shop that was given nowhere to keep it', async () => {
      const nowhere = drive(createApi(shop, { callers: () => callers }));

      expect((await nowhere('POST', '/printers', { token: ADMIN, json: { ...mini, key: 'mini-key' } })).status).toBe(400);
      expect(JSON.stringify((await ask('/printers')).body)).not.toContain('mini');
    });
  });

  // AIDEV-NOTE: `addressIn` decides what an address may be and is unit tested over about twenty of
  // them in tests/api.test.ts. What is left is that the route puts a body through it, and that a
  // refusal comes back as a client's mistake rather than the shop's.
  describe('where a printer may be pointed', () => {
    it('puts the address in a body through the rule, and refuses it as a client error', async () => {
      const answer = await send('POST', '/printers', { name: 'mini', buildVolume: MK4, address: 'file:///etc/passwd' });

      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ error: expect.stringContaining('this shop speaks http and https') as unknown });
    });

    it('takes one it can reach a printer at', async () => {
      expect((await send('POST', '/printers', { name: 'mini', buildVolume: MK4, address: 'http://octopi.local' })).status).toBe(201);
    });
  });

  // AIDEV-NOTE: one per way a name ARRIVES, and no more. What `requireUsablePrinterName` does with a
  // string is a plain function, unit tested over about twenty of them in tests/api.test.ts. What is
  // left is whether each arrival reaches the rule - a path, a body and a query - and every bug this
  // block has ever caught was one of those not doing so.
  describe('what a client may call a printer', () => {
    // Creating is the one thing with no printer to look the name up among, so the shape of it is
    // checked - and a BODY is the only way `..` reaches the shop at all.
    it('refuses a name a directory cannot be given, which only a body can ask for', async () => {
      const answer = await send('POST', '/printers', { name: '..', buildVolume: MK4, address: 'http://x' });

      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ error: expect.stringContaining('is not a name a printer can have') as unknown });
    });

    // AIDEV-NOTE: the arrival that had the hole, and the one place here worth standing a printer.json
    // up outside the printers directory to prove it is shut. `..` is a real climb out of it - and a
    // query string is the only way one reaches a route, because express normalises a path's away.
    // What the shop used to answer was the file: one that parsed 200, one absent 404, one not JSON 500.
    it('answers for no printer when a query string climbs out onto a printer.json that is there', async () => {
      await writeFile(path.join(where.state, 'printer.json'), JSON.stringify({ name: 'up-the-tree', buildVolume: MK4 }));

      const answer = await ask('/filaments?printer=..');

      expect(answer.status).toBe(404);
      expect(answer.body).toMatchObject({ error: expect.stringContaining('no printer called') as unknown });
    });

    it('still takes an ordinary name', async () => {
      expect((await send('PUT', '/printers/mk4/filament', { loaded: ['PLA'] })).status).toBe(200);
    });

    // A name with a space or a '#' in it is legal and reaches the shop encoded; refusing those would
    // be the guard overreaching.
    it.each([['Prusa%20MK4'], ['mk4%23two']])('takes %s, which is only a name that needed encoding', async (name) => {
      await send('POST', '/printers', { name: decodeURIComponent(name), buildVolume: MK4, address: 'http://x' });

      expect((await send('PUT', `/printers/${name}/filament`, { loaded: ['PLA'] })).status).toBe(200);
    });
  });
});
