import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createApi } from '../src/api';
import { CALLERS_FILE, callersIn } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { run } from '../src/cli';
import { aDataDirectory, parentOf } from './aDataDirectory';
import { drive } from './inProcess';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: `init` is the one operator command that is NOT a client of a running shop - until it
// has run there is nobody a shop would answer. What it WRITES is `writeFirstCaller`'s, unit tested
// in credentials.test.ts; what it SAYS is shopAdmin.test.ts; that two typed passwords must match is
// `askForANewPassword`'s, in callerAdmin.test.ts.
//
// What is here is the join, which none of those can make: a shop started over what init wrote
// answers the token it printed, and logs in the person whose password it took. Each of these was a
// spawned `init` and a spawned shop with a socket between them.
describe('setting a fresh machine up', () => {
  let machine: string;
  let etc: string;
  let where: DataLayout;
  let said: string[];

  const A_PASSWORD = 'a password of some length';

  const initialising = (ask: () => Promise<string> = () => Promise.resolve(A_PASSWORD)): Promise<number> =>
    run(['node', 'shop', 'init', 'dave', '--etc', etc], () => undefined, { say: (lines) => said.push(...lines), ask });

  // The shop an operator would start next, over the credentials init has just written.
  const shopOverWhatInitWrote = async (): Promise<ReturnType<typeof drive>> => {
    const known = await callersIn(etc);

    return drive(createApi(new JobStore(where), { callers: () => known }));
  };

  const tokenSaid = (): string => /\b[0-9a-f]{64}\b/.exec(said.join('\n'))?.[0] ?? '';

  beforeEach(async () => {
    machine = await mkdtemp(path.join(tmpdir(), 'print-shop-fresh-'));
    etc = path.join(machine, 'etc');
    where = await aDataDirectory('print-shop-fresh-data-');
    said = [];
  });

  afterEach(async () => {
    await rm(machine, { recursive: true, force: true });
    await rm(parentOf(where), { recursive: true, force: true });
  });

  it('writes the credentials where it was told to', async () => {
    expect(await initialising()).toBe(0);

    await expect(access(path.join(etc, CALLERS_FILE))).resolves.toBeUndefined();
  });

  // AIDEV-NOTE: what proves `init` worked is not the file it wrote but a shop started over it
  // ANSWERING the token it printed. The mode, the shape and the token are each something a file can
  // get wrong while still looking right, and each of them is a shop that will not start or answer.
  it('prints a token a shop over those credentials then answers', async () => {
    await initialising();
    const shop = await shopOverWhatInitWrote();

    expect(tokenSaid()).not.toBe('');
    expect((await shop('GET', '/jobs', { token: tokenSaid() })).status).toBe(200);
  });

  // The other half of what init writes, and the half a person uses.
  it('takes a password that then logs somebody in to the page', async () => {
    await initialising();
    const shop = await shopOverWhatInitWrote();

    const said = await shop('POST', '/sessions', { json: { id: 'dave', password: A_PASSWORD } });

    expect(said.status).toBe(201);
  });

  it('names them by the name it was given, and answers about them by it', async () => {
    await initialising();
    const shop = await shopOverWhatInitWrote();

    expect((await shop('GET', '/me', { token: tokenSaid() })).body).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
  });

  // AIDEV-NOTE: a password is typed twice because nobody can see what they typed the first time, and
  // a machine set up with a password nobody knows is a machine nobody can log in to. That the two
  // must match is `askForANewPassword`'s and is tested there; what is asked here is what `init` does
  // when it is refused one - which is nothing at all, rather than a half-made machine.
  describe('when it is not given a password', () => {
    const refused = (): Promise<string> => Promise.reject(new Error('those are not the same password, and nothing was changed'));

    it('sets nothing up', async () => {
      await initialising(refused);

      await expect(access(path.join(etc, CALLERS_FILE))).rejects.toThrow();
    });

    it('is a failure, so a script that ran it knows', async () => {
      expect(await initialising(refused)).toBe(1);
    });
  });
});
