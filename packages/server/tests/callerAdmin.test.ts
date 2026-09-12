import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { CALLERS_FILE, callersIn } from '../src/credentials';
import { addSomebody, askForANewPassword, changePassword, giveAToken, listCallers, migrateTheCallers } from '../src/callerAdmin';
import { digestOf } from '../src/secrets';

// AIDEV-NOTE: nothing is mocked but the one thing that cannot be real in a test - a person typing a
// password - and that arrives as a collaborator rather than as a mocked module, which is how
// everything else hard to stand up is handed over here. The FILE is real and is read back with
// `callersIn`, so what is asserted is what was written rather than that a writer was called.

describe('the operator saying who this shop answers', () => {
  let etc: string;

  const PASSWORD = 'a password of some length';
  const tokenIn = (lines: string[]): string => / {2}([0-9a-f]{64})/.exec(lines.join('\n'))?.[1] ?? '';
  const written = async (): Promise<string> => readFile(path.join(etc, CALLERS_FILE), 'utf-8');

  const asking = jest.fn<() => Promise<string>>();

  // Two lines on a stream that ends, which is the path `askSecretlyTwice` takes when there is no
  // terminal - a pipe, a script, or this.
  const typedTwice = (said: string, confirmed = said): PassThrough => {
    const input = new PassThrough();
    input.end(`${said}\n${confirmed}\n`);

    return input;
  };

  // AIDEV-NOTE: a shop that already has somebody, because none of these can make the first one -
  // `changeCallers` reads the file before it writes it, and a shop cannot be asked to let somebody in
  // that it does not yet answer. Writing the first is `init`, and is tested in shopAdmin.test.ts.
  // Seeded by hand rather than with `writeFirstCaller` so that 26 tests do not each cost a scrypt.
  const aShopWithSomebodyIn = async (): Promise<void> => {
    const root = [{ id: 'root', name: 'root', role: 'admin', credentials: [{ kind: 'token', hash: digestOf('r'.repeat(64)) }] }];

    await writeFile(path.join(etc, CALLERS_FILE), `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  };

  beforeEach(async () => {
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-callers-'));
    await aShopWithSomebodyIn();
    asking.mockResolvedValue(PASSWORD);
  });

  afterEach(async () => {
    await rm(etc, { recursive: true, force: true });
  });

  describe('asking for a new password', () => {
    it('answers with it when it was typed the same twice', async () => {
      await expect(askForANewPassword('one: ', 'two: ', typedTwice('the same thing'), new PassThrough())).resolves.toBe('the same thing');
    });

    // Nothing is changed rather than the first one being taken: somebody who mistyped the second
    // does not know which of the two the shop kept.
    it('changes nothing when the two do not match', async () => {
      const asked = askForANewPassword('one: ', 'two: ', typedTwice('one thing', 'another'), new PassThrough());

      await expect(asked).rejects.toThrow('those are not the same password, and nothing was changed');
    });
  });

  describe('adding somebody', () => {
    it('adds a person the shop then knows by the password they were given', async () => {
      await addSomebody(etc, 'ada', 'Ada', 'admin', false, asking);

      expect((await callersIn(etc)).named('ada')?.caller).toEqual({ id: 'ada', name: 'Ada', role: 'admin' });
    }, 15_000);

    it('says that a person logs in with the password just set, and says no token', async () => {
      const lines = await addSomebody(etc, 'ada', 'Ada', 'admin', false, asking);

      expect(lines.join('\n')).toContain('logs in with the password you just set');
      expect(tokenIn(lines)).toBe('');
    }, 15_000);

    // A program has no browser to log in with, so it gets a token and no password.
    it('gives a machine a token the shop answers, and no password', async () => {
      const token = tokenIn(await addSomebody(etc, 'slicer', 'slicer', 'user', true, asking));
      const callers = await callersIn(etc);

      expect(callers.presenting(token)).toEqual({ id: 'slicer', name: 'slicer', role: 'user' });
      expect(callers.named('slicer')?.password).toBeUndefined();
    });

    it('never asks a machine for a password', async () => {
      await addSomebody(etc, 'slicer', 'slicer', 'user', true, asking);

      expect(asking).not.toHaveBeenCalled();
    });

    // The file is what a running shop re-reads, so every one of these ends by saying so.
    it('says how a shop that is already running is told', async () => {
      expect((await addSomebody(etc, 'slicer', 'slicer', 'user', true, asking)).join('\n')).toContain('SIGHUP');
    });

    it('writes neither the password nor the token as it was given', async () => {
      const token = tokenIn(await addSomebody(etc, 'slicer', 'slicer', 'user', true, asking));

      expect(await written()).not.toContain(token);
      expect(await written()).toContain(digestOf(token));
    });

    // Two callers on one id are one owner, and every job either submits belongs to both of them -
    // which is not something the shop can untangle afterwards.
    it('refuses an id the shop already answers', async () => {
      await addSomebody(etc, 'ada', 'Ada', 'admin', true, asking);

      await expect(addSomebody(etc, 'ada', 'Someone Else', 'user', true, asking)).rejects.toThrow('already somebody this shop knows');
    });
  });

  describe('setting what somebody logs in with', () => {
    beforeEach(async () => {
      await addSomebody(etc, 'ada', 'Ada', 'admin', true, asking);
    });

    it('gives them a password the shop then knows them by', async () => {
      asking.mockResolvedValue('a brand new password');
      await changePassword(etc, 'ada', asking);

      expect((await callersIn(etc)).named('ada')?.password).toMatch(/^scrypt\$/);
    }, 15_000);

    // A password is a person's and a token is a machine's, so changing one is not a reason to go
    // round every machine they slice with.
    it('leaves the tokens they already had alone', async () => {
      const token = tokenIn(await giveAToken(etc, 'ada'));

      asking.mockResolvedValue('a brand new password');
      await changePassword(etc, 'ada', asking);

      expect((await callersIn(etc)).presenting(token)?.id).toBe('ada');
    }, 15_000);

    it('says that every browser logged in as them is logged out by it', async () => {
      expect((await changePassword(etc, 'ada', asking)).join('\n')).toContain('logged out');
    }, 15_000);

    it('refuses somebody this shop does not answer', async () => {
      await expect(changePassword(etc, 'nobody', asking)).rejects.toThrow('nobody this shop knows');
    }, 15_000);
  });

  describe('issuing another token', () => {
    beforeEach(async () => {
      await addSomebody(etc, 'ada', 'Ada', 'admin', true, asking);
    });

    // Another, not a replacement: losing a laptop should cost that laptop's token rather than
    // everything the person can reach.
    it('leaves the one they already had working', async () => {
      const first = tokenIn(await addSomebody(etc, 'slicer', 'slicer', 'user', true, asking));

      const second = tokenIn(await giveAToken(etc, 'slicer'));
      const callers = await callersIn(etc);

      expect(callers.presenting(first)?.id).toBe('slicer');
      expect(callers.presenting(second)?.id).toBe('slicer');
    });

    it('says where a client looks for it', async () => {
      expect((await giveAToken(etc, 'ada')).join('\n')).toContain('PRINT_SHOP_TOKEN');
    });

    it('refuses somebody this shop does not answer', async () => {
      await expect(giveAToken(etc, 'nobody')).rejects.toThrow('nobody this shop knows');
    });
  });

  // What a caller HAS rather than what it is, because "can this person log in" is the question an
  // operator is actually asking - and the answer is not in a file they can read the secrets out of.
  describe('listing who the shop answers', () => {
    it('says nobody, and that such a shop would not start', async () => {
      await writeFile(path.join(etc, CALLERS_FILE), '[]\n', { mode: 0o600 });

      expect((await listCallers(etc)).join('\n')).toContain('would refuse to start');
    });

    it('says what each of them has rather than what it is', async () => {
      await addSomebody(etc, 'slicer', 'slicer', 'user', true, asking);
      await giveAToken(etc, 'slicer');

      expect((await listCallers(etc)).join('\n')).toContain('no password, 2 tokens');
    });

    it('counts one token as one', async () => {
      await addSomebody(etc, 'slicer', 'slicer', 'user', true, asking);

      expect((await listCallers(etc)).join('\n')).toContain('1 token');
    });

    it('says a person has a password', async () => {
      await addSomebody(etc, 'ada', 'Ada', 'admin', false, asking);

      expect((await listCallers(etc)).join('\n')).toContain('a password');
    }, 15_000);

    it('says nothing a secret could be read back from', async () => {
      const token = tokenIn(await addSomebody(etc, 'slicer', 'slicer', 'user', true, asking));

      const said = (await listCallers(etc)).join('\n');

      expect(said).not.toContain(token);
      expect(said).not.toContain(digestOf(token));
    });
  });

  // The one thing that reads the OLD shape - a token in the clear - and the only thing that can see
  // one. It hashes what is there so every token goes on working and nothing is reissued to anybody.
  describe('migrating a file that still holds tokens in the clear', () => {
    const plainly = async (token: string): Promise<void> =>
      writeFile(path.join(etc, CALLERS_FILE), `${JSON.stringify([{ id: 'old', name: 'old', role: 'admin', token }])}\n`, { mode: 0o600 });

    it('keeps every token working, without anything being reissued', async () => {
      await plainly('a'.repeat(64));

      await migrateTheCallers(etc);

      expect((await callersIn(etc)).presenting('a'.repeat(64))?.id).toBe('old');
    });

    it('leaves the file holding the digest and not the token', async () => {
      await plainly('a'.repeat(64));

      await migrateTheCallers(etc);

      expect(await written()).not.toContain('a'.repeat(64));
      expect(await written()).toContain(digestOf('a'.repeat(64)));
    });

    it('says how many it hashed', async () => {
      await plainly('a'.repeat(64));

      expect((await migrateTheCallers(etc)).join('\n')).toContain('1 token is');
    });

    it('says there was nothing to do when none of them is in the clear', async () => {
      await addSomebody(etc, 'slicer', 'slicer', 'user', true, asking);

      expect((await migrateTheCallers(etc)).join('\n')).toContain('nothing to migrate');
    });

    // Migrating gives nobody a password: that is still an operator's to set afterwards.
    it('says that nobody has a password yet', async () => {
      await plainly('a'.repeat(64));

      expect((await migrateTheCallers(etc)).join('\n')).toContain('nobody has a password yet');
    });
  });
});
