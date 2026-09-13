import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { layTheFoundations } from '../src/foundations';
import { CALLERS_FILE, DataInUse, PRINTER_KEYS_FILE, claimData } from '../src';
import { digestOf } from '../src/secrets';
import { layoutUnder } from '../src/dataLayout';

// AIDEV-NOTE: every refusal a shop can make before it answers anything, asked directly. Each of
// these used to be a spawned process whose exit code was read back - which told you a broad thing
// broke and not which precondition said no.
describe('what a shop must have before it serves anything', () => {
  let root: string;
  let data: string;
  let etc: string;
  let letGo: (() => void)[];

  const laying = (over: { data?: string; etc?: string } = {}): Promise<unknown> =>
    layTheFoundations({ data, etc, ...over }).then((laid) => {
      letGo.push(laid.releaseData);

      return laid;
    });

  const namingSomebody = async (): Promise<void> => {
    await writeFile(
      path.join(etc, CALLERS_FILE),
      JSON.stringify([{ id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'token', hash: digestOf('a-token') }] }]),
      { mode: 0o600 }
    );
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'print-shop-foundations-'));
    data = path.join(root, 'data');
    etc = path.join(root, 'etc');
    // The data directory is made when the shop is INSTALLED and never by the shop itself.
    await mkdir(layoutUnder(data).jobs, { recursive: true, mode: 0o700 });
    await mkdir(layoutUnder(data).state, { recursive: true, mode: 0o700 });
    await mkdir(etc, { recursive: true });
    await chmod(etc, 0o700);
    await namingSomebody();
    letGo = [];
  });

  afterEach(async () => {
    letGo.forEach((release) => release());
    await rm(root, { recursive: true, force: true });
  });

  it('is laid when everything it needs is there', async () => {
    await expect(laying()).resolves.toMatchObject({ etc });
  });

  // AIDEV-NOTE: credentials FIRST, and a shop that has none does not start. Every route names its
  // caller, so there is nothing for a shop with no callers to answer - and reading a missing file as
  // "nobody configured yet" is how a fresh machine ends up serving anybody who reaches the port.
  describe('the callers it answers', () => {
    it('are refused when nobody has named any', async () => {
      await rm(path.join(etc, CALLERS_FILE));

      await expect(laying()).rejects.toThrow(CALLERS_FILE);
    });

    // A file that is THERE and wrong stops it for the same reason: answering a typo in the security
    // file by removing the security is the failure nobody notices.
    it('are refused when the file is there and unreadable', async () => {
      await writeFile(path.join(etc, CALLERS_FILE), 'not json at all', { mode: 0o600 });

      await expect(laying()).rejects.toThrow();
    });

    // Asked before the data directory is even looked at, because a shop nobody may call has no
    // business claiming one.
    it('are asked about before the data directory is', async () => {
      await rm(path.join(etc, CALLERS_FILE));

      await expect(laying({ data: path.join(root, 'never-made') })).rejects.toThrow(CALLERS_FILE);
    });
  });

  describe('the data directory it keeps work in', () => {
    it('is refused when it is not there, and says which one', async () => {
      const missing = path.join(root, 'never-made');

      await expect(laying({ data: missing })).rejects.toThrow(layoutUnder(missing).jobs);
    });

    // The shop sets 0700 on everything below it, and none of that survives a parent anybody can
    // write - a job directory could simply be renamed out from under it.
    it('is refused when somebody else could write it', async () => {
      await chmod(layoutUnder(data).jobs, 0o777);

      await expect(laying()).rejects.toThrow();
    });

    // AIDEV-NOTE: two shops over one data directory would both read `next-id` as 7, both write 8 and
    // both hand out 7 - the second overwriting the first job's gcode with no error anywhere. A
    // second `serve` on the same PORT already fails to listen; this is the case only the claim
    // catches.
    it('is refused when another shop is already serving it', async () => {
      const held = await claimData(layoutUnder(data).run);

      try {
        await expect(laying()).rejects.toThrow(DataInUse);
      } finally {
        held();
      }
    });

    it('is let go of again, so the next shop may have it', async () => {
      const laid = await layTheFoundations({ data, etc });
      laid.releaseData();

      await expect(laying()).resolves.toBeDefined();
    });
  });

  // AIDEV-NOTE: the log redacts every key this process HOLDS, and a key can arrive after the shop is
  // running - from a SIGHUP, or from a printer added over the API. `holding` is how one that arrived
  // late cannot reach a line written after it.
  describe('the keys its log keeps out of what it writes', () => {
    it('are the ones the shop was given at the start', async () => {
      await writeFile(path.join(etc, PRINTER_KEYS_FILE), JSON.stringify({ mk4: 'a-secret-key' }), { mode: 0o600 });

      await expect(laying()).resolves.toMatchObject({ printerKeys: new Map([['mk4', 'a-secret-key']]) });
    });

    it('are none at all for a shop nobody has given one', async () => {
      await expect(laying()).resolves.toMatchObject({ printerKeys: new Map() });
    });
  });
});
