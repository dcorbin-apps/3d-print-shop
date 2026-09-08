import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { TOKEN_ENV, defaultTokenFile } from '@3d-print-shop/client';
import { CALLERS_FILE, callersIn } from '../src/credentials';
import { initialiseShop } from '../src/shopAdmin';

describe('setting a fresh machine up', () => {
  let etc: string;

  const said = async (name: string): Promise<string> => (await initialiseShop(etc, name)).join('\n');

  beforeEach(async () => {
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-etc-'));
  });

  afterEach(async () => {
    await rm(etc, { recursive: true, force: true });
  });

  it('says the token, which is the one the shop it wrote will answer to', async () => {
    const lines = await said('dave');
    const [written] = [...(await callersIn(etc)).keys()];

    expect(lines).toContain(written);
  });

  it('says which file it wrote, and who is now in it', async () => {
    expect(await said('dave')).toContain(`${path.join(etc, CALLERS_FILE)} now names one admin, dave`);
  });

  // The token is written nowhere else and nothing shows it again, so where to put it is the half of
  // this an operator has to be told while they can still act on it.
  it('says where a client will look for that token', async () => {
    const lines = await said('dave');

    expect(lines).toContain(TOKEN_ENV);
    expect(lines).toContain(defaultTokenFile());
  });

  // An admin: there is nothing an operator can do to a fresh shop as a user - not add a printer,
  // and not judge what comes off one.
  it('names them by the name it was given, and by that as their id', async () => {
    await initialiseShop(etc, 'gamebox');

    expect([...(await callersIn(etc)).values()]).toEqual([{ id: 'gamebox', name: 'gamebox', role: 'admin' }]);
  });
});
