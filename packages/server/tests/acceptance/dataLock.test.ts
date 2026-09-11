import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DataInUse, claimData } from '../../src/dataLock';

// AIDEV-NOTE: real sockets on a real directory - the whole point is what the KERNEL will and will
// not allow, which nothing else can stand in for.
describe('holding a data directory', () => {
  let dataRoot: string;
  let held: (() => void)[];

  const socket = (): string => path.join(dataRoot, 'running.sock');

  async function claim(): Promise<() => void> {
    const release = await claimData(dataRoot);
    held.push(release);

    return release;
  }

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'print-shop-lock-'));
    held = [];
  });

  afterEach(async () => {
    held.forEach((release) => release());
    await rm(dataRoot, { recursive: true, force: true });
  });

  // Two shops over one data directory would both read `next-id` as 7, both write 8, and both hand out 7.
  it('lets a second shop nowhere near a data directory that is already served', async () => {
    await claim();

    await expect(claimData(dataRoot)).rejects.toThrow(DataInUse);
  });

  it('says which dataRoot, and why only one may have it', async () => {
    await claim();

    await expect(claimData(dataRoot)).rejects.toThrow(`another shop is already serving ${dataRoot}`);
  });

  // Two directories, because refusing every second claim would satisfy the test above.
  it('lets a shop have a data directory nobody else is serving', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'print-shop-lock-other-'));
    await claim();

    try {
      // Released here rather than in the teardown: a claim left holding a socket is an open handle
      // that keeps the whole run from ending.
      (await claimData(other))();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('hands the data directory on once the first shop lets go', async () => {
    (await claim())();

    await expect(claim()).resolves.toBeDefined();
  });

  // AIDEV-NOTE: the one thing a lock FILE gets wrong, and the reason this is a socket. The path
  // outlives a process that died, but the claim does not - so nobody answering on it is what makes
  // the leftover safe to clear away.
  it('takes a data directory whose last shop died without tidying up', async () => {
    await writeFile(socket(), 'left behind');

    await expect(claim()).resolves.toBeDefined();
  });

  it('leaves nothing behind that the next shop has to reason about', async () => {
    (await claim())();

    await expect(stat(socket())).rejects.toThrow();
  });
});
