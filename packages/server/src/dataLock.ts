import { mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import * as path from 'node:path';

export class DataInUse extends Error {}

const LOCK_SOCKET = 'running.sock';

/**
 * The three things holding a directory takes, apart so that what this shop DOES with each of them
 * can be asked without one.
 *
 * AIDEV-NOTE: the answers come from the kernel, and the kernel is not ours to test - that a second
 * listener on one path is refused, and that closing gives the path back, is node's and is pinned in
 * tests/assumptions/aListeningClaim.test.ts. What IS ours is what the shop does when it is told
 * those things, and that is `claimData`.
 */
export interface Claiming {
  /** Start listening at this path, answering with how to stop. Rejects the way node does. */
  listen(at: string): Promise<() => void>;
  /** Whether anything answers at this path - which is what tells a live claim from a leftover. */
  answers(at: string): Promise<boolean>;
  /** Take the path away, whatever is there. */
  clear(at: string): Promise<void>;
}

// AIDEV-NOTE: nothing may talk to it. This is a listening socket for the exclusivity alone: the
// kernel refuses a second listener on the same path, and drops the claim when the process ends -
// however it ends. That is what a lock FILE cannot do, because a crash leaves the file behind and
// whoever comes next has to guess whether it means anything.
export const overASocket: Claiming = {
  listen: (at) =>
    new Promise((listening, cannot) => {
      const held = createServer();
      held.on('connection', (client) => client.destroy());
      held.once('error', cannot);
      held.listen(at, () => {
        held.removeListener('error', cannot);
        listening(() => held.close());
      });
    }),

  answers: (at) =>
    new Promise((answer) => {
      const asking = createConnection(at)
        .on('connect', () => {
          asking.destroy();
          answer(true);
        })
        .on('error', () => answer(false));
    }),

  clear: (at) => rm(at, { force: true }),
};

/**
 * Hold a data directory for this process, and answer with the way to let it go.
 *
 * The store's numbers are only unique while ONE process is handing them out: allocating an id is a
 * read of `next-id`, an add, and a write back, and two shops over one directory would both read 7,
 * both write 8, and both hand out 7 - the second overwriting the first job's gcode and record with
 * no error anywhere.
 *
 * Scoped to the data directory rather than to the port. A second `serve` on the same port already
 * fails to listen; one on a different port over the same directory is the case only this catches.
 */
export async function claimData(root: string, how: Claiming = overASocket): Promise<() => void> {
  const socket = path.join(root, LOCK_SOCKET);

  // AIDEV-NOTE: the one directory the shop makes for itself, and the exception is the point. Work
  // and state are the installer's because a shop that created them would create them wherever it
  // was mispointed - but this one is MEANT not to survive: it is /var/run on an installed machine,
  // which is emptied by a boot, so nothing could have made it that would still be there.
  await mkdir(root, { recursive: true, mode: 0o700 });

  try {
    return await how.listen(socket);
  } catch (failure) {
    // AIDEV-NOTE: any other reason is not this function's to interpret. Answered as "somebody has
    // it" an operator goes looking for a process that is not there, and the thing actually wrong -
    // a directory nothing may be created in - is never mentioned. It also stops the tidy-up below
    // running on the strength of a failure nobody read.
    if ((failure as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw failure;

    if (await how.answers(socket)) {
      throw new DataInUse(`another shop is already serving ${root} - only one may, or they would hand out the same job ids`);
    }

    // Left by a shop that died. The path outlives the process even though the claim does not, so
    // this is the one thing that has to be tidied - and nobody answering is what makes it safe to.
    await how.clear(socket);

    return how.listen(socket);
  }
}
