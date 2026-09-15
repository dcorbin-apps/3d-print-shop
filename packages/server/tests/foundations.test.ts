import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { layTheFoundations, sessionsKeptIn } from '../src/foundations';
import type { Foundations } from '../src/foundations';
import { CALLERS_FILE, DataInUse, PRINTER_KEYS_FILE, claimData } from '../src';
import { SESSIONS_FILE } from '../src/sessions';
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
  let said: string[];

  const laying = (over: { data?: string; etc?: string } = {}): Promise<Foundations> =>
    layTheFoundations({ data, etc, writing: (line) => said.push(line), ...over }).then((laid) => {
      letGo.push(laid.releaseData);

      return laid;
    });

  const namingSomebody = async (): Promise<void> => {
    await writeFile(
      path.join(etc, CALLERS_FILE),
      JSON.stringify([{ id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'token', hash: digestOf('a-token') }] }]),
      { mode: 0o600 },
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
    said = [];
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

    // AIDEV-NOTE: what a leak actually looks like - not the shop printing a key on purpose, but a
    // reason, a failure or a header with one quoted inside it. The redactor is the only thing
    // standing in the way, and `redacting` is unit tested in log.test.ts; what is asked here is that
    // the log a running shop is GIVEN was built with it, over the keys that shop holds.
    it('are kept out of a line that quotes one back', async () => {
      await writeFile(path.join(etc, PRINTER_KEYS_FILE), JSON.stringify({ mk4: 'a-secret-key' }), { mode: 0o600 });
      const { log } = (await laying()) as Foundations;

      log.info('printer stopped', { printer: 'mk4', reason: 'the key is a-secret-key' });

      expect(said.join('\n')).not.toContain('a-secret-key');
      expect(said.join('\n')).toContain('printer stopped');
    });

    // AIDEV-NOTE: a key can arrive while the shop RUNS - from a SIGHUP, or from a printer added over
    // the API - and the log has to keep it out of every line written afterwards. It reads what it
    // was last told rather than what it was built with, which is what `holding` is.
    it('are kept out once a key that arrived later has been declared', async () => {
      const { log, holding } = (await laying()) as Foundations;

      holding(new Map([['mini', 'a-key-from-a-browser']]));
      log.info('printer stopped', { printer: 'mini', reason: 'the key is a-key-from-a-browser' });

      expect(said.join('\n')).not.toContain('a-key-from-a-browser');
    });
  });

  // AIDEV-NOTE: a restart is what this is FOR - an update at 2am should not be a wall display asking
  // to be logged in to in the morning. `Sessions` answers for itself across a restart in
  // sessions.test.ts; what is here is where a running shop puts the file, which is the half that
  // decides whether a restart finds it at all.
  describe('who was logged in last time', () => {
    // AIDEV-NOTE: every sessions object made here is SETTLED before the test ends, including the ones
    // whose answer is all the test wanted. Picking up sweeps what has expired and writes the rest
    // back, so one left unsettled is still writing when the teardown removes the directory - which
    // surfaced as `ENOTEMPTY` from rmdir, in whichever test was unlucky, about one run in eight.
    it('is nobody on a machine that has never had one', async () => {
      const { log } = await laying();

      const fresh = await sessionsKeptIn(layoutUnder(data), log);

      expect(fresh).toMatchObject({ pickedUp: 0 });
      await fresh.sessions.settled();
    });

    it('is still logged in after the shop has been stopped and started again', async () => {
      const { log } = await laying();
      const first = await sessionsKeptIn(layoutUnder(data), log);
      const secret = first.sessions.begin('dave');
      await first.sessions.settled();

      const again = await sessionsKeptIn(layoutUnder(data), log);

      expect(again.sessions.whose(secret)).toBe('dave');
      expect(again.pickedUp).toBe(1);
      await again.sessions.settled();
    });

    it('is not logged in again by a restart after logging out', async () => {
      const { log } = await laying();
      const first = await sessionsKeptIn(layoutUnder(data), log);
      const secret = first.sessions.begin('dave');
      first.sessions.end(secret);
      await first.sessions.settled();

      const again = await sessionsKeptIn(layoutUnder(data), log);

      expect(again.sessions.whose(secret)).toBeUndefined();
      await again.sessions.settled();
    });

    // AIDEV-NOTE: with the STATE, because the jobs directory is one directory per job and the store
    // reads every name in it. A file of its own there is something the shop would have to know not
    // to read, for ever.
    it('is kept with the state, and not among the jobs', async () => {
      const { log } = await laying();
      const { sessions } = await sessionsKeptIn(layoutUnder(data), log);
      sessions.begin('dave');
      await sessions.settled();

      await expect(readdir(layoutUnder(data).state)).resolves.toContain(SESSIONS_FILE);
      await expect(readdir(layoutUnder(data).jobs)).resolves.toEqual([]);
    });
  });

  // Named a place, everything goes under it - so what the store keeps work in is what was asked for.
  describe('what it was told on the command line', () => {
    it('keeps its work under the data directory it was pointed at', async () => {
      const laid = (await laying()) as Foundations;

      expect(laid.where.jobs).toBe(layoutUnder(data).jobs);
    });

    // The cap belongs to the operator: a slicer that outgrows the default has to be able to say so,
    // and the shop keeps that much room spare in the data directory for every job it accepts.
    it('takes gcode up to the size --max-gcode named, and no more', async () => {
      const laid = await layTheFoundations({ data, etc, maxGcode: 64 });
      letGo.push(laid.releaseData);

      await laid.store.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://mk4' });
      const asBigAsItTakes = await laid.store.submit({ filaments: ['PLA'] }, Readable.from(['G'.repeat(64)]), 'dave');

      expect(asBigAsItTakes.gcodeBytes).toBe(64);
      await expect(laid.store.submit({ filaments: ['PLA'] }, Readable.from(['G'.repeat(65)]), 'dave')).rejects.toThrow('64 bytes');
    });
  });
});
