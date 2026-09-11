import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { TOKEN_ENV, defaultTokenFile } from '@3d-print-shop/client';
import { CALLERS_FILE, callersIn } from '../src/credentials';
import { initialiseShop } from '../src/shopAdmin';

describe('setting a fresh machine up', () => {
  let etc: string;

  const PASSWORD = 'a password of some length';

  const said = async (name: string): Promise<string> => (await initialiseShop(etc, name, PASSWORD)).join('\n');

  beforeEach(async () => {
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-etc-'));
  });

  afterEach(async () => {
    await rm(etc, { recursive: true, force: true });
  });

  // AIDEV-NOTE: the token is said ONCE, here, and stored as a digest - so the only way to check it
  // is the right one is to present it, which is what a client does.
  it('says a token the shop it wrote will answer to', async () => {
    const lines = await said('dave');
    const token = / {2}([0-9a-f]{64})/.exec(lines)?.[1] ?? '';

    expect((await callersIn(etc)).presenting(token)).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
  }, 10_000);

  // Both, because they are for two different things and a shop wants both from the first minute.
  it('says that the password just typed is what logs them in to the page', async () => {
    expect(await said('dave')).toContain('logs in to the page with the password you just set');
  }, 10_000);

  it('says neither the password nor anything it could be read back from', async () => {
    expect(await said('dave')).not.toContain(PASSWORD);
  }, 10_000);

  it('says which file it wrote, and who is now in it', async () => {
    expect(await said('dave')).toContain(`${path.join(etc, CALLERS_FILE)} now names one admin, dave`);
  }, 10_000);

  // The token is written nowhere else and nothing shows it again, so where to put it is the half of
  // this an operator has to be told while they can still act on it.
  it('says where a client will look for that token', async () => {
    const lines = await said('dave');

    expect(lines).toContain(TOKEN_ENV);
    expect(lines).toContain(defaultTokenFile());
  }, 10_000);

  // An admin: there is nothing an operator can do to a fresh shop as a user - not add a printer,
  // and not judge what comes off one.
  it('names them by the name it was given, and by that as their id', async () => {
    await initialiseShop(etc, 'slicer', PASSWORD);

    expect((await callersIn(etc)).all().map(({ caller }) => caller)).toEqual([{ id: 'slicer', name: 'slicer', role: 'admin' }]);
  }, 10_000);
});
