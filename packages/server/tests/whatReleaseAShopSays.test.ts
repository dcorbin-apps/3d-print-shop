import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Express } from 'express';
import { createApi } from '../src/api';
import type { StartListening } from '../src/api';
import { run } from '../src/cli';
import { CALLERS_FILE, Callers } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { digestOf } from '../src/secrets';
import { aDataDirectory, parentOf } from './aDataDirectory';
import { drive } from './inProcess';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: (UT) the page is installed as a package of its own beside the server, so the two can
// come from different releases - and the page asks this to find out. Asked here as a USER, because
// the page of somebody who is not an admin drifts exactly as an admin's does, and a route nobody
// classified is an admin's.
describe('which release a shop says it is', () => {
  let where: DataLayout;
  let shop: JobStore;
  const TOKEN = 'slicer-token';
  const aUser = new Callers([
    { caller: { id: 'slicer', name: 'slicer', role: 'user' }, credentials: [{ kind: 'token', hash: digestOf(TOKEN) }] },
  ]);

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-version-');
    shop = new JobStore(where);
  });

  afterEach(async () => {
    await rm(parentOf(where), { recursive: true, force: true });
  });

  it('answers any caller with the release it was told it is', async () => {
    const asked = drive(createApi(shop, { callers: () => aUser, version: '1.2.3' }));

    const answer = await asked('GET', '/version', { token: TOKEN });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ version: '1.2.3' });
  });

  // Nothing made up in its place: a page cannot say what differs from a version that was invented.
  it('says none when it was never told, rather than guessing one', async () => {
    const asked = drive(createApi(shop, { callers: () => aUser }));

    expect((await asked('GET', '/version', { token: TOKEN })).body).toEqual({});
  });
});

// AIDEV-NOTE: (UT) the release has to travel from the entry point, through the `serve` command, into
// the API - and deleting the one line that hands it to `serve` left every test green, because the
// command was only ever reached over a real socket. So the listener is handed in and binds nothing:
// the app the command built is kept and asked in-process, which is the command's wiring and not a
// model of it. It is stopped the same way, so nothing it started outlives the test.
describe('the release a served shop is told', () => {
  let where: DataLayout;
  let etc: string;
  let said: string[];
  let served: Express | undefined;
  const ADMIN = 'dave-token';

  // Enough of a server for the command to read an address off and close. Nothing binds.
  const noSocket: StartListening = (api: Express, _port: number, _address: string, ready: () => void): Server => {
    served = api;
    setImmediate(ready);

    return {
      on: () => undefined,
      address: () => ({ address: '127.0.0.1', port: 7373, family: 'IPv4' }),
      close: () => undefined,
    } as unknown as Server;
  };

  const stopped = async (): Promise<void> => {
    while (!said.includes('3d-print-shop has stopped')) await new Promise((done) => setTimeout(done, 10));
  };

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-release-');
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-release-etc-'));
    await chmod(etc, 0o700);
    await writeFile(
      path.join(etc, CALLERS_FILE),
      JSON.stringify([{ id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] }]),
      { mode: 0o600 },
    );
    said = [];
    served = undefined;
  });

  afterEach(async () => {
    if (served !== undefined) {
      await drive(served)('POST', '/shutdown', { token: ADMIN });
      await stopped();
    }
    await rm(etc, { recursive: true, force: true });
    await rm(parentOf(where), { recursive: true, force: true });
  });

  it('answers with the release the command was handed', async () => {
    await run(['node', 'shop', 'serve', '--data', parentOf(where), '--etc', etc], () => undefined, {
      version: '9.9.9',
      startListening: noSocket,
      say: (lines) => said.push(...lines),
      writing: () => undefined,
    });

    if (served === undefined) throw new Error(`the command never served anything: ${said.join('\n')}`);

    expect((await drive(served)('GET', '/version', { token: ADMIN })).body).toEqual({ version: '9.9.9' });
  }, 15_000);
});
