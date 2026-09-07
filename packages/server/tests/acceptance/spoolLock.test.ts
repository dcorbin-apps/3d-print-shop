import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SpoolInUse, claimSpool } from '../../src/spoolLock';

// AIDEV-NOTE: real sockets on a real directory - the whole point is what the KERNEL will and will
// not allow, which nothing else can stand in for.
describe('holding a spool', () => {
  let spool: string;
  let held: (() => void)[];

  const socket = (): string => path.join(spool, 'running.sock');

  async function claim(): Promise<() => void> {
    const release = await claimSpool(spool);
    held.push(release);

    return release;
  }

  beforeEach(async () => {
    spool = await mkdtemp(path.join(tmpdir(), 'print-shop-lock-'));
    held = [];
  });

  afterEach(async () => {
    held.forEach((release) => release());
    await rm(spool, { recursive: true, force: true });
  });

  // Two shops over one spool would both read `next-id` as 7, both write 8, and both hand out 7.
  it('lets a second shop nowhere near a spool that is already served', async () => {
    await claim();

    await expect(claimSpool(spool)).rejects.toThrow(SpoolInUse);
  });

  it('says which spool, and why only one may have it', async () => {
    await claim();

    await expect(claimSpool(spool)).rejects.toThrow(`another shop is already serving ${spool}`);
  });

  // Two spools, because refusing every second claim would satisfy the test above.
  it('lets a shop have a spool nobody else is serving', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'print-shop-lock-other-'));
    await claim();

    try {
      // Released here rather than in the teardown: a claim left holding a socket is an open handle
      // that keeps the whole run from ending.
      (await claimSpool(other))();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('hands the spool on once the first shop lets go', async () => {
    (await claim())();

    await expect(claim()).resolves.toBeDefined();
  });

  // AIDEV-NOTE: the one thing a lock FILE gets wrong, and the reason this is a socket. The path
  // outlives a process that died, but the claim does not - so nobody answering on it is what makes
  // the leftover safe to clear away.
  it('takes a spool whose last shop died without tidying up', async () => {
    await writeFile(socket(), 'left behind');

    await expect(claim()).resolves.toBeDefined();
  });

  it('leaves nothing behind that the next shop has to reason about', async () => {
    (await claim())();

    await expect(stat(socket())).rejects.toThrow();
  });
});
