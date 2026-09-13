import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DataInUse, claimData } from '../src/dataLock';
import type { Claiming } from '../src/dataLock';

// AIDEV-NOTE: what the shop DOES when it is told a directory is taken - not whether the kernel tells
// it so. That a second listener on one path is refused, and that closing gives the path back, is
// node's and the kernel's, and is pinned in tests/assumptions/aListeningClaim.test.ts. Testing it
// here would be testing somebody else's code through ours.
describe('claiming a data directory', () => {
  let root: string;
  let claimed: string[];
  let cleared: string[];
  let letGo: number;
  let refuse: NodeJS.ErrnoException | undefined;
  let answering: boolean;

  const socket = (): string => path.join(root, 'running.sock');

  // AIDEV-NOTE: refuses ONCE and then gives way, which is the shape of the case that matters - a
  // path with a leftover on it is claimable the moment the leftover is gone.
  const how = (): Claiming => ({
    listen: jest.fn<Claiming['listen']>(async (at) => {
      if (refuse !== undefined && !cleared.includes(at)) {
        const failure = refuse;
        throw failure;
      }
      claimed.push(at);

      return () => {
        letGo += 1;
      };
    }),
    answers: jest.fn<Claiming['answers']>(() => Promise.resolve(answering)),
    clear: jest.fn<Claiming['clear']>(async (at) => {
      cleared.push(at);
    }),
  });

  const inUse = (): NodeJS.ErrnoException => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

  beforeEach(async () => {
    root = path.join(await mkdtemp(path.join(tmpdir(), 'print-shop-claim-')), 'run');
    claimed = [];
    cleared = [];
    letGo = 0;
    refuse = undefined;
    answering = false;
  });

  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  it('claims the socket the shop keeps in the directory it was given', async () => {
    await claimData(root, how());

    expect(claimed).toEqual([socket()]);
  });

  // The one directory the shop makes for itself: it is /var/run on an installed machine, emptied by
  // a boot, so nothing could have made it that would still be there.
  it('makes the directory it claims in, which nothing else would have', async () => {
    await claimData(root, how());

    await expect(stat(root)).resolves.toBeDefined();
  });

  it('answers with the way to let it go', async () => {
    (await claimData(root, how()))();

    expect(letGo).toBe(1);
  });

  describe('when something is already listening there', () => {
    beforeEach(() => {
      refuse = inUse();
      answering = true;
    });

    it('is refused, because two shops over one directory hand out the same job ids', async () => {
      await expect(claimData(root, how())).rejects.toThrow(DataInUse);
    });

    it('says which directory, and why only one may have it', async () => {
      await expect(claimData(root, how())).rejects.toThrow(`another shop is already serving ${root}`);
    });

    it('takes nothing away, because it belongs to whoever is answering', async () => {
      await claimData(root, how()).catch(() => undefined);

      expect(cleared).toEqual([]);
    });
  });

  // AIDEV-NOTE: the one thing a lock FILE gets wrong, and the reason this is a socket. The path
  // outlives a process that died, but the claim does not - so nobody answering is what makes the
  // leftover safe to clear away.
  describe('when a shop died and left its socket behind', () => {
    beforeEach(() => {
      refuse = inUse();
      answering = false;
    });

    it('clears the leftover away', async () => {
      await claimData(root, how());

      expect(cleared).toEqual([socket()]);
    });

    it('then claims it, so a machine is not stuck until somebody tidies up', async () => {
      await expect(claimData(root, how())).resolves.toBeDefined();
      expect(claimed).toEqual([socket()]);
    });
  });

  // AIDEV-NOTE: any other reason is not this function's to interpret. Answered as "somebody has it",
  // an operator goes looking for a process that is not there, and the thing actually wrong - a
  // directory nothing may be created in - is never mentioned.
  describe('when it could not listen for some other reason', () => {
    beforeEach(() => {
      refuse = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
      answering = false;
    });

    it('says what was wrong rather than blaming a shop that is not there', async () => {
      await expect(claimData(root, how())).rejects.toThrow('EACCES');
      await expect(claimData(root, how())).rejects.not.toThrow(DataInUse);
    });

    // The tidy-up is for a leftover, and a failure nobody read is no reason to remove anything.
    it('takes nothing away on the strength of a failure it never read', async () => {
      await claimData(root, how()).catch(() => undefined);

      expect(cleared).toEqual([]);
    });

    it('does not ask whether anybody is answering, because that was never the question', async () => {
      const asking = how();
      await claimData(root, asking).catch(() => undefined);

      expect(asking.answers).not.toHaveBeenCalled();
    });
  });
});
