import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  AlreadyHasCallers,
  CALLERS_FILE,
  ETC_ENV,
  PRINTER_KEYS_FILE,
  UnusableCredentials,
  callersIn,
  defaultEtc,
  printerKeysIn,
  rereadCallers,
  writeFirstCaller,
} from '../src/credentials';
import { toStdout } from '../src/log';
import type { Log } from '../src/log';

describe('the credentials a shop is given', () => {
  let etc: string;

  // The id is deliberately not the name: nothing may pass by treating the two as one field.
  const dave = { id: 'u-1', name: 'dave', role: 'admin', token: 'dave-token' };
  const slicer = { id: 'u-2', name: 'slicer', role: 'user', token: 'slicer-token' };

  async function write(file: string, contents: unknown, mode = 0o600): Promise<void> {
    await writeFile(path.join(etc, file), typeof contents === 'string' ? contents : JSON.stringify(contents), { mode });
  }

  beforeEach(async () => {
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-etc-'));
  });

  afterEach(async () => {
    await rm(etc, { recursive: true, force: true });
  });

  describe('who may call it', () => {
    it('knows each caller by the token they present', async () => {
      await write(CALLERS_FILE, [dave, slicer]);

      const callers = await callersIn(etc);

      expect(callers.get('dave-token')).toEqual({ id: 'u-1', name: 'dave', role: 'admin' });
      expect(callers.get('slicer-token')).toEqual({ id: 'u-2', name: 'slicer', role: 'user' });
    });

    it('knows nobody by a token it was not given', async () => {
      await write(CALLERS_FILE, [dave]);

      expect((await callersIn(etc)).get('some-other-token')).toBeUndefined();
    });

    it('takes a file naming nobody, which is a shop nobody may call', async () => {
      await write(CALLERS_FILE, []);

      expect((await callersIn(etc)).size).toBe(0);
    });

    // An id outlives the name beside it, so what one may look like is fixed before any job is
    // written with one - a rule this narrow can be relaxed later, and never the other way.
    it.each([['dave'], ['slicer-v3'], ['a.b_c-1'], ['7'], ['x'.repeat(64)]])('takes %j as an id', async (id) => {
      await write(CALLERS_FILE, [{ ...dave, id }]);

      expect((await callersIn(etc)).get('dave-token')?.id).toBe(id);
    });

    it.each([[''], ['-leading'], ['.leading'], ['has space'], ['slash/es'], ['\u00fcber'], ['x'.repeat(65)]])(
      'refuses %j as an id',
      async (id) => {
        await write(CALLERS_FILE, [{ ...dave, id }]);

        await expect(callersIn(etc)).rejects.toThrow('an id is up to 64');
      },
    );

    // Two callers on one id are one owner, and no later reading of the records could say which of
    // them meant any given job - the shop cannot rewrite one to find out.
    it('refuses two callers sharing an id, saying a job could not say which owns it', async () => {
      await write(CALLERS_FILE, [dave, { ...slicer, id: 'u-1' }]);

      await expect(callersIn(etc)).rejects.toThrow('gives the id u-1 to both dave and slicer');
    });

    // The audit trail is the point of a name, and two callers on one token would put one caller's
    // actions under the other's name - which is worse than having no name at all.
    it('refuses two callers sharing a token, saying it could not tell them apart', async () => {
      await write(CALLERS_FILE, [dave, { ...slicer, token: 'dave-token' }]);

      await expect(callersIn(etc)).rejects.toThrow('the same token, so neither could be told apart');
    });

    it.each([
      [[{ name: 'dave', role: 'admin', token: 't' }], 'the id undefined'],
      [[{ id: 'u-1', role: 'admin', token: 't' }], 'gives u-1 no name'],
      [[{ id: 'u-1', name: 'dave', token: 't' }], 'a role is "admin" or "user"'],
      [[{ id: 'u-1', name: 'dave', role: 'wheel', token: 't' }], 'a role is "admin" or "user"'],
      [[{ id: 'u-1', name: 'dave', role: 'admin' }], 'gives dave no token'],
      [{ dave: 'token' }, 'a list of callers'],
    ])('refuses %j', async (written, complaint) => {
      await write(CALLERS_FILE, written);

      await expect(callersIn(etc)).rejects.toThrow(complaint);
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
      ['a duplicate token', JSON.stringify([dave, { ...slicer, token: dave.token }]), 0o600],
      ['a mode anybody can read', JSON.stringify([dave]), 0o644],
    ])('is a refusal and not an empty shop when the file is there with %s', async (_why, contents, mode) => {
      await write(CALLERS_FILE, contents, mode);

      await expect(callersIn(etc)).rejects.toBeInstanceOf(UnusableCredentials);
    });
  });

  // AIDEV-NOTE: the way into a fresh machine. There is no anonymous mode, so a shop with no callers
  // answers nobody and refuses to start - which leaves writing the first one as the one thing that
  // cannot be done by asking the shop.
  // AIDEV-NOTE: what SIGHUP does. A token is added or revoked by editing the file the shop already
  // reads, so what matters is which of the two lists a running shop ends up with - the new one, or
  // the one it already had.
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

      expect((await rereadCallers(etc, before, log)).get('slicer-token')).toEqual({ id: 'u-2', name: 'slicer', role: 'user' });
    });

    it('no longer knows a caller the file has stopped naming', async () => {
      await write(CALLERS_FILE, [dave, slicer]);
      const before = await callersIn(etc);
      await write(CALLERS_FILE, [dave]);

      expect((await rereadCallers(etc, before, log)).get('slicer-token')).toBeUndefined();
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

      await rereadCallers(etc, new Map(), log);

      expect(lines.join('\n')).toContain('ERROR could not re-read the callers, so the shop keeps the ones it has');
      expect(lines.join('\n')).toContain('is not JSON');
    });

    // The line an operator looks for after signalling, to see that the shop did anything at all.
    it('says how many it re-read', async () => {
      await write(CALLERS_FILE, [dave, slicer]);

      await rereadCallers(etc, new Map(), log);

      expect(lines.join('\n')).toContain('INFO  callers re-read');
      expect(lines.join('\n')).toContain('callers=2');
    });
  });

  describe('the first caller a machine is given', () => {
    it('writes an admin the shop then knows by the token it answered with', async () => {
      const token = await writeFirstCaller(etc, 'u-1', 'dave');

      expect((await callersIn(etc)).get(token)).toEqual({ id: 'u-1', name: 'dave', role: 'admin' });
    });

    // Nothing reads it back out of the file, so the value answered here is the only copy there will
    // ever be - and it has to be unguessable, because it is the whole of what a caller presents.
    it('answers 32 random bytes, and different ones every time', async () => {
      const mine = await writeFirstCaller(etc, 'u-1', 'dave');
      const theirs = await writeFirstCaller(await mkdtemp(path.join(tmpdir(), 'print-shop-etc-')), 'u-1', 'dave');

      expect(mine).toMatch(/^[0-9a-f]{64}$/);
      expect(theirs).not.toBe(mine);
    });

    it('writes it 0600, which is the mode the shop refuses to read one without', async () => {
      await writeFirstCaller(etc, 'u-1', 'dave');

      expect((await stat(path.join(etc, CALLERS_FILE))).mode & 0o777).toBe(0o600);
    });

    // The credentials directory is what setting a machine up MEANS, so this makes it - unlike the
    // spool, which is the installer's because work put where nobody is looking is work lost.
    it('makes the directory when the machine has none', async () => {
      const never = path.join(etc, 'not-yet');

      const token = await writeFirstCaller(never, 'u-1', 'dave');

      expect((await callersIn(never)).get(token)?.name).toBe('dave');
    });

    // This file holds every token the shop knows, so writing over one revokes every caller at once
    // and orphans every job their ids own.
    it('refuses to write over callers already there, and leaves them exactly as they were', async () => {
      await write(CALLERS_FILE, [dave, slicer]);

      await expect(writeFirstCaller(etc, 'u-3', 'someone')).rejects.toBeInstanceOf(AlreadyHasCallers);
      expect(JSON.parse(await readFile(path.join(etc, CALLERS_FILE), 'utf-8'))).toEqual([dave, slicer]);
    });

    // Refused here rather than written and refused at the next start, when whoever typed it has
    // gone - and an id in particular can never be corrected once a job records it.
    it.each([
      ['has space', 'dave', 'is not an id'],
      ['-leading', 'dave', 'is not an id'],
      ['x'.repeat(65), 'dave', 'is not an id'],
      ['u-1', '  ', 'needs a name'],
    ])('refuses %j as an id and %j as a name', async (id, name, complaint) => {
      await expect(writeFirstCaller(etc, id, name)).rejects.toThrow(complaint);
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

      await expect(callersIn(etc)).resolves.toBeInstanceOf(Map);
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
});
