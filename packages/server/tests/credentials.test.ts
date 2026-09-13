import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AlreadyHasCallers, CALLERS_FILE, ETC_ENV, PRINTER_KEYS_FILE, UnusableCredentials, callersIn, defaultEtc, printerKeysIn, rereadCallers, rereadPrinterKeys, writeFirstCaller, writePrinterKey, Callers, addCaller, issueToken, migrateCallers, scratchBeside, setPassword, whosePasswordChanged } from '../src/credentials';
import { digestOf, hashPassword, isThePassword } from '../src/secrets';
import { toStdout } from '../src/log';
import type { Log } from '../src/log';

describe('the credentials a shop is given', () => {
  let etc: string;

  // The id is deliberately not the name: nothing may pass by treating the two as one field.
  const DAVE_TOKEN = 'dave-token';
  const SLICER_TOKEN = 'slicer-token';
  const PASSWORD = 'a password of some length';

  const holding = (id: string, name: string, role: string, ...credentials: { kind: string; hash: string }[]): object => ({
    id,
    name,
    role,
    credentials,
  });

  const carrying = (token: string): { kind: string; hash: string } => ({ kind: 'token', hash: digestOf(token) });

  const dave = holding('u-1', 'dave', 'admin', carrying(DAVE_TOKEN));
  const slicer = holding('u-2', 'slicer', 'user', carrying(SLICER_TOKEN));

  async function write(file: string, contents: unknown, mode = 0o600): Promise<void> {
    await writeFile(path.join(etc, file), typeof contents === 'string' ? contents : JSON.stringify(contents), { mode });
  }

  beforeEach(async () => {
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-etc-'));
  });

  afterEach(async () => {
    await rm(etc, { recursive: true, force: true });
  });

  // AIDEV-NOTE: a credential HANGS OFF an identity rather than being one. That is the whole of what
  // changed: a token used to BE the caller, so a person with two machines was two people and the
  // jobs one of them submitted were a stranger's to the other.
  describe('who may call it', () => {
    it('knows each caller by the token they present', async () => {
      await write(CALLERS_FILE, [dave, slicer]);

      const callers = await callersIn(etc);

      expect(callers.presenting(DAVE_TOKEN)).toEqual({ id: 'u-1', name: 'dave', role: 'admin' });
      expect(callers.presenting(SLICER_TOKEN)).toEqual({ id: 'u-2', name: 'slicer', role: 'user' });
    });

    it('knows nobody by a token it was not given', async () => {
      await write(CALLERS_FILE, [dave]);

      expect((await callersIn(etc)).presenting('made-up')).toBeUndefined();
    });

    // The point of a list: one person, one id, and a token per machine they slice from - so losing
    // a laptop costs that laptop's token rather than everything they can reach.
    it('knows one caller by any of the tokens they hold', async () => {
      await write(CALLERS_FILE, [holding('u-1', 'dave', 'admin', carrying('at-the-bench'), carrying('at-the-desk'))]);

      const callers = await callersIn(etc);

      expect(callers.presenting('at-the-bench')).toEqual(callers.presenting('at-the-desk'));
    });

    // Nothing in the file is what was presented: a stolen copy is not a set of working credentials.
    it('holds no token as it was given', async () => {
      await write(CALLERS_FILE, [dave]);

      expect(await readFile(path.join(etc, CALLERS_FILE), 'utf-8')).not.toContain(DAVE_TOKEN);
    });

    it('finds the password a caller would be recognised by', async () => {
      const hash = await hashPassword(PASSWORD);
      await write(CALLERS_FILE, [holding('u-1', 'dave', 'admin', { kind: 'password', hash })]);

      expect((await callersIn(etc)).named('u-1')?.password).toBe(hash);
    });

    // Somebody who exists and cannot get in: their jobs still say who owns them, which is the whole
    // reason an id is not a credential.
    it('knows a caller with no password as one who cannot log in', async () => {
      await write(CALLERS_FILE, [dave]);

      expect((await callersIn(etc)).named('u-1')).toEqual({ caller: { id: 'u-1', name: 'dave', role: 'admin' }, password: undefined });
    });

    it('knows nobody by a name it was not given', async () => {
      await write(CALLERS_FILE, [dave]);

      expect((await callersIn(etc)).named('nobody')).toBeUndefined();
    });

    it('counts the callers rather than the credentials', async () => {
      await write(CALLERS_FILE, [holding('u-1', 'dave', 'admin', carrying('one'), carrying('two')), slicer]);

      expect((await callersIn(etc)).size).toBe(2);
    });

    it.each([
      [[{ id: 'dave' }], 'no name'],
      [[{ id: 'dave', name: 'dave' }], 'the role'],
      [[{ id: 'has space', name: 'dave', role: 'admin', credentials: [] }], 'an id is up to 64'],
      [[{ id: 'dave', name: 'dave', role: 'root', credentials: [] }], 'a role is'],
      [[{ id: 'dave', name: 'dave', role: 'admin' }], 'no credentials'],
      [[{ id: 'dave', name: 'dave', role: 'admin', credentials: 'a-token' }], 'no credentials'],
      [[{ id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'fingerprint', hash: 'x' }] }], 'a kind is'],
      [[{ id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'token' }] }], 'with nothing stored for it'],
      [[{ id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'token', hash: '  ' }] }], 'with nothing stored for it'],
      [{ dave: 'token' }, 'a list of callers'],
    ])('refuses %j', async (written, complaint) => {
      await write(CALLERS_FILE, written);

      await expect(callersIn(etc)).rejects.toThrow(complaint);
    });

    // Either might let somebody in, which is one more way in than anybody meant to leave open.
    it('refuses a caller with two passwords', async () => {
      const two = [{ kind: 'password', hash: 'one' }, { kind: 'password', hash: 'other' }];
      await write(CALLERS_FILE, [{ id: 'u-1', name: 'dave', role: 'admin', credentials: two }]);

      await expect(callersIn(etc)).rejects.toThrow('two passwords');
    });

    it('refuses a file that is not JSON at all', async () => {
      await write(CALLERS_FILE, 'dave: admin');

      await expect(callersIn(etc)).rejects.toThrow('is not JSON');
    });

    // AIDEV-NOTE: a fresh machine is where this matters. Every route names its caller, so reading a
    // file that is not there as "nobody configured yet" would put a shop anybody may call on the
    // first machine it was installed on - the one place nobody is watching for it.
    it('is a refusal when the file is not there, rather than a shop anyone may call', async () => {
      await expect(callersIn(etc)).rejects.toThrow('every route names its caller');
    });

    it.each([
      ['not JSON', 'dave: admin', 0o600],
      ['a duplicate token', JSON.stringify([dave, holding('u-3', 'else', 'user', carrying(DAVE_TOKEN))]), 0o600],
      ['a mode anybody can read', JSON.stringify([dave]), 0o644],
    ])('is a refusal and not an empty shop when the file is there with %s', async (_why, contents, mode) => {
      await write(CALLERS_FILE, contents, mode);

      await expect(callersIn(etc)).rejects.toBeInstanceOf(UnusableCredentials);
    });

    // AIDEV-NOTE: the old shape, refused rather than quietly read. A shop that went on accepting a
    // token in the clear would keep every install that has ever run on plaintext for ever.
    describe('a file still holding a token in the clear', () => {
      const asItWas = [{ id: 'u-1', name: 'dave', role: 'admin', token: DAVE_TOKEN }];

      it('is refused rather than read', async () => {
        await write(CALLERS_FILE, asItWas);

        await expect(callersIn(etc)).rejects.toThrow('in the clear');
      });

      // A refusal that stops a shop from starting has to say what to type next.
      it('says what fixes it', async () => {
        await write(CALLERS_FILE, asItWas);

        await expect(callersIn(etc)).rejects.toThrow('callers migrate');
      });

      it('is read again once it has been migrated', async () => {
        await write(CALLERS_FILE, asItWas);

        expect(await migrateCallers(etc)).toBe(1);
        expect((await callersIn(etc)).presenting(DAVE_TOKEN)).toEqual({ id: 'u-1', name: 'dave', role: 'admin' });
      });

      // The whole point of migrating rather than reissuing: nobody has to go round the machines.
      it('leaves every token that was in it working', async () => {
        await write(CALLERS_FILE, [
          { id: 'u-1', name: 'dave', role: 'admin', token: DAVE_TOKEN },
          { id: 'u-2', name: 'slicer', role: 'user', token: SLICER_TOKEN },
        ]);

        expect(await migrateCallers(etc)).toBe(2);
        const callers = await callersIn(etc);

        expect(callers.presenting(DAVE_TOKEN)?.name).toBe('dave');
        expect(callers.presenting(SLICER_TOKEN)?.name).toBe('slicer');
      });

      it('leaves nothing in the clear behind it', async () => {
        await write(CALLERS_FILE, asItWas);
        await migrateCallers(etc);

        expect(await readFile(path.join(etc, CALLERS_FILE), 'utf-8')).not.toContain(DAVE_TOKEN);
      });

      it('has nothing to do to a file that is already hashed', async () => {
        await write(CALLERS_FILE, [dave]);

        expect(await migrateCallers(etc)).toBe(0);
        expect((await callersIn(etc)).presenting(DAVE_TOKEN)?.name).toBe('dave');
      });
    });
  });

  // AIDEV-NOTE: what SIGHUP does. A credential is added or revoked by editing the file the shop
  // already reads, so what matters is which of the two lists a running shop ends up with.
  describe('reading the callers again while the shop is running', () => {
    let lines: string[];
    let log: Log;

    beforeEach(() => {
      lines = [];
      log = toStdout(() => new Date(), (line) => lines.push(line));
    });

    it('knows a caller the file has since been given', async () => {
      await write(CALLERS_FILE, [dave]);
      const before = await callersIn(etc);
      await write(CALLERS_FILE, [dave, slicer]);

      expect((await rereadCallers(etc, before, log)).presenting(SLICER_TOKEN)).toEqual({ id: 'u-2', name: 'slicer', role: 'user' });
    });

    it('no longer knows a caller the file has stopped naming', async () => {
      await write(CALLERS_FILE, [dave, slicer]);
      const before = await callersIn(etc);
      await write(CALLERS_FILE, [dave]);

      expect((await rereadCallers(etc, before, log)).presenting(SLICER_TOKEN)).toBeUndefined();
    });

    // A stray comma, or a file caught halfway through being replaced: read as "nobody may call this
    // shop" it would revoke every caller at once, the operator who has to fix it among them.
    it.each([
      ['is not JSON', (): Promise<void> => write(CALLERS_FILE, '{ not json')],
      ['is not there at all', (): Promise<void> => rm(path.join(etc, CALLERS_FILE))],
    ])('keeps the callers it has when the file %s', async (_what, spoil) => {
      await write(CALLERS_FILE, [dave]);
      const before = await callersIn(etc);
      await spoil();

      expect(await rereadCallers(etc, before, log)).toBe(before);
    });

    it('says it kept them, and what was wrong with the file', async () => {
      await write(CALLERS_FILE, '{ not json');

      await rereadCallers(etc, new Callers([]), log);

      expect(lines.join('\n')).toContain('ERROR could not re-read the callers, so the shop keeps the ones it has');
      expect(lines.join('\n')).toContain('is not JSON');
    });

    // The line an operator looks for after signalling, to see that the shop did anything at all.
    it('says how many it re-read', async () => {
      await write(CALLERS_FILE, [dave, slicer]);

      await rereadCallers(etc, new Callers([]), log);

      expect(lines.join('\n')).toContain('INFO  callers re-read');
      expect(lines.join('\n')).toContain('callers=2');
    });
  });

  // AIDEV-NOTE: what makes `caller password`'s promise true - the shop ends the sessions of whoever
  // this names, and it is asked once per re-read, so naming somebody it should not logs a person out
  // of a screen they are standing in front of.
  describe('who a re-read changed the password of', () => {
    const knowing = (...held: { id: string; password?: string }[]): Callers =>
      new Callers(
        held.map(({ id, password }) => ({
          caller: { id, name: id, role: 'user' as const },
          credentials: password === undefined ? [] : [{ kind: 'password' as const, hash: password }],
        })),
      );

    it('is nobody when the file says what it said before', () => {
      const same = (): Callers => knowing({ id: 'u-1', password: 'one' }, { id: 'u-2', password: 'two' });

      expect(whosePasswordChanged(same(), same())).toEqual([]);
    });

    it('is whoever the file now hashes differently, and nobody beside them', () => {
      const before = knowing({ id: 'u-1', password: 'one' }, { id: 'u-2', password: 'two' });
      const after = knowing({ id: 'u-1', password: 'one' }, { id: 'u-2', password: 'something else' });

      expect(whosePasswordChanged(before, after)).toEqual(['u-2']);
    });

    // Revoked and "no longer has a password" are the same thing from here: either way, what the
    // browser was let in by is gone.
    it.each([
      ['is no longer named at all', (): Callers => knowing({ id: 'u-1', password: 'one' })],
      ['has had their password taken away', (): Callers => knowing({ id: 'u-1', password: 'one' }, { id: 'u-2' })],
    ])('names somebody who %s', (_what, after) => {
      const before = knowing({ id: 'u-1', password: 'one' }, { id: 'u-2', password: 'two' });

      expect(whosePasswordChanged(before, after())).toEqual(['u-2']);
    });

    it('is nobody for a caller the file has only just been given', () => {
      const before = knowing({ id: 'u-1', password: 'one' });

      expect(whosePasswordChanged(before, knowing({ id: 'u-1', password: 'one' }, { id: 'u-2', password: 'two' }))).toEqual([]);
    });
  });

  describe('the first caller a machine is given', () => {
    it('writes an admin the shop then knows by the token it answered with', async () => {
      const token = await writeFirstCaller(etc, 'u-1', 'dave', PASSWORD);

      expect((await callersIn(etc)).presenting(token)).toEqual({ id: 'u-1', name: 'dave', role: 'admin' });
    }, 10_000);

    // Both, because they are two different things: the password logs a person in to the page, and
    // the token is how a program calls a shop it has no browser for.
    it('gives them a password to log in with as well as a token to call with', async () => {
      await writeFirstCaller(etc, 'u-1', 'dave', PASSWORD);

      const found = (await callersIn(etc)).named('u-1');

      expect(await isThePassword(PASSWORD, found?.password ?? '')).toBe(true);
    }, 10_000);

    // Nothing reads it back out of the file, so the value answered here is the only copy there will
    // ever be - and it has to be unguessable, because it is the whole of what a caller presents.
    it('answers 32 random bytes, and different ones every time', async () => {
      const mine = await writeFirstCaller(etc, 'u-1', 'dave', PASSWORD);
      const theirs = await writeFirstCaller(await mkdtemp(path.join(tmpdir(), 'print-shop-etc-')), 'u-1', 'dave', PASSWORD);

      expect(mine).toMatch(/^[0-9a-f]{64}$/);
      expect(theirs).not.toBe(mine);
    }, 15_000);

    it('writes neither the token nor the password as it was given', async () => {
      const token = await writeFirstCaller(etc, 'u-1', 'dave', PASSWORD);
      const written = await readFile(path.join(etc, CALLERS_FILE), 'utf-8');

      expect(written).not.toContain(token);
      expect(written).not.toContain(PASSWORD);
    }, 10_000);

    it('writes it 0600, which is the mode the shop refuses to read one without', async () => {
      await writeFirstCaller(etc, 'u-1', 'dave', PASSWORD);

      expect((await stat(path.join(etc, CALLERS_FILE))).mode & 0o777).toBe(0o600);
    }, 10_000);

    // The credentials directory is what setting a machine up MEANS, so this makes it - unlike the
    // dataRoot, which is the installer's because work put where nobody is looking is work lost.
    it('makes the directory when the machine has none', async () => {
      const never = path.join(etc, 'not-yet');

      const token = await writeFirstCaller(never, 'u-1', 'dave', PASSWORD);

      expect((await callersIn(never)).presenting(token)?.name).toBe('dave');
    }, 10_000);

    // This file holds every credential the shop knows, so writing over one revokes every caller at
    // once and orphans every job their ids own.
    it('refuses to write over callers already there, and leaves them exactly as they were', async () => {
      await write(CALLERS_FILE, [dave, slicer]);

      await expect(writeFirstCaller(etc, 'u-3', 'someone', PASSWORD)).rejects.toBeInstanceOf(AlreadyHasCallers);
      expect(JSON.parse(await readFile(path.join(etc, CALLERS_FILE), 'utf-8'))).toEqual([dave, slicer]);
    }, 10_000);

    // Refused here rather than written and refused at the next start, when whoever typed it has
    // gone - and an id in particular can never be corrected once a job records it.
    it.each([
      ['has space', 'dave', PASSWORD, 'is not an id'],
      ['-leading', 'dave', PASSWORD, 'is not an id'],
      ['x'.repeat(65), 'dave', PASSWORD, 'is not an id'],
      ['u-1', '  ', PASSWORD, 'needs a name'],
      ['u-1', 'dave', 'short', 'at least 12 characters'],
    ])('refuses %j as an id, %j as a name and %j as a password', async (id, name, password, complaint) => {
      await expect(writeFirstCaller(etc, id, name, password)).rejects.toThrow(complaint);
    });
  });

  // AIDEV-NOTE: the commands that change who this shop answers. They write the file rather than
  // asking a running shop, because a shop cannot be asked to let in somebody it does not yet answer.
  describe('changing who the shop answers', () => {
    beforeEach(async () => {
      await write(CALLERS_FILE, [dave]);
    });

    describe('adding somebody', () => {
      it('adds a person with the password they will log in with, and no token', async () => {
        expect(await addCaller(etc, 'u-2', 'ada', 'user', PASSWORD)).toBeUndefined();

        const added = (await callersIn(etc)).named('u-2');

        expect(added?.caller).toEqual({ id: 'u-2', name: 'ada', role: 'user' });
        expect(await isThePassword(PASSWORD, added?.password ?? '')).toBe(true);
      }, 10_000);

      // A program has no browser to log in with, so what it gets is a token and no password.
      it('adds a machine with a token it answers with, and no password', async () => {
        const token = await addCaller(etc, 'u-2', 'slicer', 'user');

        expect((await callersIn(etc)).presenting(token ?? '')?.name).toBe('slicer');
        expect((await callersIn(etc)).named('u-2')?.password).toBeUndefined();
      });

      it('leaves everybody already there exactly as they were', async () => {
        await addCaller(etc, 'u-2', 'ada', 'user', PASSWORD);

        expect((await callersIn(etc)).presenting(DAVE_TOKEN)?.name).toBe('dave');
      }, 10_000);

      // Two callers on one id are one owner, and no job could say which of them meant it.
      it('refuses an id the shop already knows', async () => {
        await expect(addCaller(etc, 'u-1', 'somebody else', 'user', PASSWORD)).rejects.toThrow('already somebody this shop knows');
      }, 10_000);

      it.each([['has space'], ['-leading']])('refuses %p as an id', async (id) => {
        await expect(addCaller(etc, id, 'ada', 'user', PASSWORD)).rejects.toThrow('is not an id');
      });

      it('refuses a password too short to be one', async () => {
        await expect(addCaller(etc, 'u-2', 'ada', 'user', 'short')).rejects.toThrow('at least 12 characters');
      });
    });

    describe('changing a password', () => {
      it('is what they are recognised by afterwards', async () => {
        await addCaller(etc, 'u-2', 'ada', 'user', PASSWORD);
        await setPassword(etc, 'u-2', 'a different password');

        expect(await isThePassword('a different password', (await callersIn(etc)).named('u-2')?.password ?? '')).toBe(true);
      }, 20_000);

      it('is the only one they have afterwards', async () => {
        await addCaller(etc, 'u-2', 'ada', 'user', PASSWORD);
        await setPassword(etc, 'u-2', 'a different password');

        expect(await isThePassword(PASSWORD, (await callersIn(etc)).named('u-2')?.password ?? '')).toBe(false);
      }, 20_000);

      // A password is a person's and a token is a machine's: changing one is not a reason to go
      // round every machine they slice with.
      it('leaves their tokens alone', async () => {
        await setPassword(etc, 'u-1', PASSWORD);

        expect((await callersIn(etc)).presenting(DAVE_TOKEN)?.name).toBe('dave');
      }, 10_000);

      it('refuses somebody the shop does not know', async () => {
        await expect(setPassword(etc, 'nobody', PASSWORD)).rejects.toThrow('nobody this shop knows');
      }, 10_000);
    });

    describe('issuing another token', () => {
      it('is another way in for the same caller', async () => {
        const token = await issueToken(etc, 'u-1');

        expect((await callersIn(etc)).presenting(token)).toEqual({ id: 'u-1', name: 'dave', role: 'admin' });
      });

      // Another, not a replacement: one per machine is the point of a list.
      it('leaves the ones they already had working', async () => {
        await issueToken(etc, 'u-1');

        expect((await callersIn(etc)).presenting(DAVE_TOKEN)?.name).toBe('dave');
      });

      it('is a different token every time', async () => {
        expect(await issueToken(etc, 'u-1')).not.toBe(await issueToken(etc, 'u-1'));
      });

      it('refuses somebody the shop does not know', async () => {
        await expect(issueToken(etc, 'nobody')).rejects.toThrow('nobody this shop knows');
      });
    });

    // Written beside and renamed over: a crash part way through would otherwise leave a shop with a
    // file naming nobody, which is a shop that will not start.
    it('leaves nothing behind it', async () => {
      await issueToken(etc, 'u-1');

      expect(await readdir(etc)).toEqual([CALLERS_FILE]);
    });

    it('keeps the file only its owner can read', async () => {
      await issueToken(etc, 'u-1');

      expect((await stat(path.join(etc, CALLERS_FILE))).mode & 0o077).toBe(0);
    });
  });

  describe('how it reaches each printer', () => {
    it('knows each key by the printer name on the record', async () => {
      await write(PRINTER_KEYS_FILE, { mk4: 'mk4-key', 'mini-2': 'mini-key' });

      const keys = await printerKeysIn(etc);

      expect(keys.get('mk4')).toBe('mk4-key');
      expect(keys.get('mini-2')).toBe('mini-key');
    });

    it.each([
      [{ mk4: '' }, 'gives mk4 no key'],
      [{ mk4: 7 }, 'gives mk4 no key'],
      [[{ mk4: 'k' }], 'names a key per printer'],
    ])('refuses %j', async (written, complaint) => {
      await write(PRINTER_KEYS_FILE, written);

      await expect(printerKeysIn(etc)).rejects.toThrow(complaint);
    });
  });

  // AIDEV-NOTE: what SIGHUP does to the other file. A key is corrected by editing the file the shop
  // already reads, so what matters is which of the two sets a running shop ends up with - and a key
  // it was never going to be able to use is exactly the sort a shop is running with while it waits.
  describe('reading the printer keys again while the shop is running', () => {
    let lines: string[];
    let log: Log;

    beforeEach(() => {
      lines = [];
      log = toStdout(() => new Date(), (line) => lines.push(line));
    });

    it('knows the key the file has since been corrected to', async () => {
      await write(PRINTER_KEYS_FILE, { mk4: 'was-wrong' });
      const before = await printerKeysIn(etc);
      await write(PRINTER_KEYS_FILE, { mk4: 'is-right' });

      expect((await rereadPrinterKeys(etc, before, log)).get('mk4')).toBe('is-right');
    });

    // Caught halfway through being replaced, read as "no keys at all", would put every machine in
    // the shop out of reach at once - and the operator's own is the one they are in the middle of.
    it('keeps the keys it has when the file it is told to re-read is unusable', async () => {
      await write(PRINTER_KEYS_FILE, { mk4: 'mk4-key' });
      const before = await printerKeysIn(etc);
      await write(PRINTER_KEYS_FILE, '{ not json');

      expect(await rereadPrinterKeys(etc, before, log)).toBe(before);
    });

    it('says it kept them, and what was wrong with the file', async () => {
      await write(PRINTER_KEYS_FILE, '{ not json');

      await rereadPrinterKeys(etc, new Map(), log);

      expect(lines.join('\n')).toContain('ERROR could not re-read the printer keys, so the shop keeps the ones it has');
      expect(lines.join('\n')).toContain('is not JSON');
    });

    // The line an operator looks for after signalling, to see that the shop did anything at all.
    it('says how many it re-read', async () => {
      await write(PRINTER_KEYS_FILE, { mk4: 'mk4-key', mini: 'mini-key' });

      await rereadPrinterKeys(etc, new Map(), log);

      expect(lines.join('\n')).toContain('INFO  printer keys re-read');
      expect(lines.join('\n')).toContain('printers=2');
    });
  });

  // AIDEV-NOTE: the one thing the running shop writes into its own credentials directory - which is
  // what lets a printer be given its key from somewhere other than a text editor, and take effect
  // without a signal. The whole map is answered because the caller is holding the keys in use.
  describe('giving a printer its key', () => {
    it('writes one where the shop reads them', async () => {
      await writePrinterKey(etc, 'mk4', 'mk4-key');

      expect((await printerKeysIn(etc)).get('mk4')).toBe('mk4-key');
    });

    it('answers with every key the shop now holds, so a running one can be told', async () => {
      await write(PRINTER_KEYS_FILE, { mini: 'mini-key' });

      expect([...(await writePrinterKey(etc, 'mk4', 'mk4-key')).entries()]).toEqual([
        ['mini', 'mini-key'],
        ['mk4', 'mk4-key'],
      ]);
    });

    // A file holding every machine's key, rewritten whole: losing the others would take the shop
    // away from every printer but the one somebody was correcting.
    it('keeps the keys of every other printer', async () => {
      await write(PRINTER_KEYS_FILE, { mini: 'mini-key', xl: 'xl-key' });
      await writePrinterKey(etc, 'mk4', 'mk4-key');

      expect(await printerKeysIn(etc)).toEqual(new Map([['mini', 'mini-key'], ['xl', 'xl-key'], ['mk4', 'mk4-key']]));
    });

    it('replaces the key a printer already had', async () => {
      await write(PRINTER_KEYS_FILE, { mk4: 'was-wrong' });
      await writePrinterKey(etc, 'mk4', 'is-right');

      expect((await printerKeysIn(etc)).get('mk4')).toBe('is-right');
    });

    // The mode is the whole of the protection, and a file the shop wrote has to pass the check the
    // shop applies to one a person wrote.
    it('writes it only its owner can read', async () => {
      await writePrinterKey(etc, 'mk4', 'mk4-key');

      expect((await stat(path.join(etc, PRINTER_KEYS_FILE))).mode & 0o077).toBe(0);
    });

    it('leaves nothing behind it', async () => {
      await writePrinterKey(etc, 'mk4', 'mk4-key');

      expect(await readdir(etc)).toEqual([PRINTER_KEYS_FILE]);
    });

    it('refuses a key that is no key at all', async () => {
      await expect(writePrinterKey(etc, 'mk4', '  ')).rejects.toThrow('cannot be given an empty key');
    });
  });

  // The whole of the protection is that nobody else can read the file, and an install that got the
  // mode wrong would work perfectly while protecting nothing - so it is checked rather than assumed.
  describe('a file somebody else could read', () => {
    it.each([[0o640], [0o604], [0o644], [0o666]])('is refused at mode %s', async (mode) => {
      await write(CALLERS_FILE, [dave]);
      await chmod(path.join(etc, CALLERS_FILE), mode);

      await expect(callersIn(etc)).rejects.toThrow('must be 0600');
    });

    it.each([[0o600], [0o400]])('is read at mode %s, where only its owner can', async (mode) => {
      await write(CALLERS_FILE, [dave]);
      await chmod(path.join(etc, CALLERS_FILE), mode);

      await expect(callersIn(etc)).resolves.toBeInstanceOf(Callers);
    });

    it('is checked for the printer keys too, which open the machines directly', async () => {
      await write(PRINTER_KEYS_FILE, { mk4: 'k' }, 0o644);

      await expect(printerKeysIn(etc)).rejects.toThrow('must be 0600');
    });
  });

  describe('where they are kept', () => {
    const wasSaid = process.env[ETC_ENV];

    afterEach(() => {
      if (wasSaid === undefined) delete process.env[ETC_ENV];
      else process.env[ETC_ENV] = wasSaid;
    });

    it('is /etc, where a service keeps what it only ever reads', () => {
      delete process.env[ETC_ENV];
      expect(defaultEtc()).toBe('/etc/3d-print-shop');
    });

    it('is what the environment says instead', () => {
      process.env[ETC_ENV] = '/somewhere/else';
      expect(defaultEtc()).toBe('/somewhere/else');
    });
  });

  // AIDEV-NOTE: two writers, one file, and the two things that went wrong with it. The SCRATCH path
  // was shared, so two writes truncating and filling it left one's bytes under the other's tail -
  // not JSON, renamed over every credential this shop knows, and a shop that will not start next
  // time. And the read-modify-write was not serialised, so two changes in one process both read the
  // same list and the second wrote the first one away.
  describe('two changes at the same moment', () => {
    it('gives each write a scratch of its own, beside the file it is for', () => {
      const file = path.join(etc, CALLERS_FILE);

      expect(scratchBeside(file)).not.toBe(scratchBeside(file));
      expect(path.dirname(scratchBeside(file))).toBe(etc);
      expect(path.basename(scratchBeside(file)).startsWith(CALLERS_FILE)).toBe(true);
    });

    it('keeps both callers when two are added at once', async () => {
      await writeFirstCaller(etc, 'dave', 'dave', PASSWORD);

      await Promise.all([addCaller(etc, 'ada', 'ada', 'user'), addCaller(etc, 'grace', 'grace', 'user')]);

      const known = await callersIn(etc);
      expect([...known.all()].map(({ caller }) => caller.id).sort()).toEqual(['ada', 'dave', 'grace']);
    });

    it('keeps both keys when two printers are given one at once', async () => {
      await Promise.all([writePrinterKey(etc, 'mk4', 'one-key'), writePrinterKey(etc, 'mini', 'another')]);

      await expect(printerKeysIn(etc)).resolves.toEqual(
        new Map([
          ['mk4', 'one-key'],
          ['mini', 'another'],
        ])
      );
    });

    // Nothing is left beside the file for the next writer to wonder about, or to be published by
    // mistake. A rename consumes the one it made; a failure takes it away again.
    it('leaves no scratch behind it', async () => {
      await writeFirstCaller(etc, 'dave', 'dave', PASSWORD);
      await addCaller(etc, 'ada', 'ada', 'user');
      await writePrinterKey(etc, 'mk4', 'a-key');

      expect((await readdir(etc)).sort()).toEqual([CALLERS_FILE, PRINTER_KEYS_FILE]);
    });
  });
});
