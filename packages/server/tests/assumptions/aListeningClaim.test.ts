import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { overASocket } from '../../src/dataLock';

// AIDEV-NOTE: what node and the kernel do with a unix socket, which is what `claimData` is built on
// and is not `claimData`'s to prove. Held apart for the reason every assumption test is: none of it
// can change because somebody edited this repository, and a red one here says the world moved.
//
// The shop's own answer to each of these - refuse, clear, retry - is asked without a socket at all,
// in tests/dataLock.test.ts. This is only the half underneath.
describe('what a listening claim on a path actually does', () => {
  let root: string;
  let held: (() => void)[];

  const socket = (): string => path.join(root, 'running.sock');

  const claiming = async (): Promise<() => void> => {
    const release = await overASocket.listen(socket());
    held.push(release);

    return release;
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'print-shop-claim-real-'));
    held = [];
  });

  afterEach(async () => {
    held.forEach((release) => release());
    await rm(root, { recursive: true, force: true });
  });

  // The whole reason a claim is a socket rather than a file: the kernel does the excluding.
  it('refuses a second listener on a path one already has, saying EADDRINUSE', async () => {
    await claiming();

    await expect(overASocket.listen(socket())).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  // Two paths, because refusing every second listen would satisfy the test above.
  it('allows one on a path nobody has', async () => {
    await claiming();

    const other = path.join(root, 'another.sock');
    const release = await overASocket.listen(other);

    expect(release).toBeDefined();
    release();
  });

  it('gives the path back when the claim is let go', async () => {
    (await claiming())();

    await expect(claiming()).resolves.toBeDefined();
  });

  // AIDEV-NOTE: node unlinks the path on close, which is what lets the next shop have it without
  // anything having to tidy up after an orderly stop.
  it('takes the path away when the claim is let go', async () => {
    (await claiming())();

    await expect(stat(socket())).rejects.toThrow();
  });

  describe('telling a live claim from a leftover', () => {
    it('answers for a path something is listening on', async () => {
      await claiming();

      await expect(overASocket.answers(socket())).resolves.toBe(true);
    });

    // AIDEV-NOTE: the one thing a lock FILE gets wrong. A path left behind by a process that died is
    // still THERE - it refuses a listener exactly as a live one does - and the only thing that tells
    // the two apart is that nobody answers on it.
    it('does not answer for a path left behind, though it still refuses a listener', async () => {
      await writeFile(socket(), 'left behind by a shop that died');

      await expect(overASocket.listen(socket())).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await expect(overASocket.answers(socket())).resolves.toBe(false);
    });

    it('does not answer for a path with nothing at it at all', async () => {
      await expect(overASocket.answers(socket())).resolves.toBe(false);
    });
  });

  it('clears a path away, whatever is at it', async () => {
    await writeFile(socket(), 'left behind');

    await overASocket.clear(socket());

    await expect(stat(socket())).rejects.toThrow();
  });
});
