import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CALLERS_FILE, ETC_ENV, PRINTER_KEYS_FILE, UnusableCredentials, callersIn, defaultEtc, printerKeysIn } from '../src/credentials';

describe('the credentials a shop is given', () => {
  let etc: string;

  const dave = { name: 'dave', role: 'admin', token: 'dave-token' };
  const gamebox = { name: 'gamebox', role: 'user', token: 'gamebox-token' };

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
      await write(CALLERS_FILE, [dave, gamebox]);

      const callers = await callersIn(etc);

      expect(callers?.get('dave-token')).toEqual({ name: 'dave', role: 'admin' });
      expect(callers?.get('gamebox-token')).toEqual({ name: 'gamebox', role: 'user' });
    });

    it('knows nobody by a token it was not given', async () => {
      await write(CALLERS_FILE, [dave]);

      expect((await callersIn(etc))?.get('some-other-token')).toBeUndefined();
    });

    it('takes a file naming nobody, which is a shop nobody may call', async () => {
      await write(CALLERS_FILE, []);

      expect((await callersIn(etc))?.size).toBe(0);
    });

    // The audit trail is the point of a name, and two callers on one token would put one caller's
    // actions under the other's name - which is worse than having no name at all.
    it('refuses two callers sharing a token, saying it could not tell them apart', async () => {
      await write(CALLERS_FILE, [dave, { ...gamebox, token: 'dave-token' }]);

      await expect(callersIn(etc)).rejects.toThrow('the same token, so neither could be told apart');
    });

    it.each([
      [[{ role: 'admin', token: 't' }], 'a caller with no name'],
      [[{ name: 'dave', token: 't' }], 'a role is "admin" or "user"'],
      [[{ name: 'dave', role: 'wheel', token: 't' }], 'a role is "admin" or "user"'],
      [[{ name: 'dave', role: 'admin' }], 'gives dave no token'],
      [{ dave: 'token' }, 'a list of callers'],
    ])('refuses %j', async (written, complaint) => {
      await write(CALLERS_FILE, written);

      await expect(callersIn(etc)).rejects.toThrow(complaint);
    });

    it('refuses a file that is not JSON at all', async () => {
      await write(CALLERS_FILE, 'dave: admin');

      await expect(callersIn(etc)).rejects.toThrow('is not JSON');
    });

    // AIDEV-NOTE: absent and wrong are different answers on purpose. Absent is a machine nobody has
    // set up, which runs on loopback with nothing refused; wrong must stop the shop, because reading
    // a typo in the security file as "nobody configured" would answer it by removing the security.
    it('is nobody at all when the file is not there, which a fresh machine is', async () => {
      await expect(callersIn(etc)).resolves.toBeUndefined();
    });

    it.each([
      ['not JSON', 'dave: admin', 0o600],
      ['a duplicate token', JSON.stringify([dave, { ...gamebox, token: dave.token }]), 0o600],
      ['a mode anybody can read', JSON.stringify([dave]), 0o644],
    ])('is a refusal and not an empty shop when the file is there with %s', async (_why, contents, mode) => {
      await write(CALLERS_FILE, contents, mode);

      await expect(callersIn(etc)).rejects.toBeInstanceOf(UnusableCredentials);
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
