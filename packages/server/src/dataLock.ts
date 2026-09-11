import { rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import type { Server } from 'node:net';
import * as path from 'node:path';

export class DataInUse extends Error {}

const LOCK_SOCKET = 'running.sock';

/**
 * Hold a data directory for this process, and answer with the way to let it go.
 *
 * The store's numbers are only unique while ONE process is handing them out: allocating an id is a
 * read of `next-id`, an add, and a write back, and two shops over one directory would both read 7, both
 * write 8, and both hand out 7 - the second overwriting the first job's gcode and record with no
 * error anywhere.
 */
export async function claimData(root: string): Promise<() => void> {
  const socket = path.join(root, LOCK_SOCKET);
  const held = createServer();

  // AIDEV-NOTE: nothing may talk to it. This is a listening socket for the exclusivity alone: the
  // kernel refuses a second listener on the same path, and drops the claim when the process ends -
  // however it ends. That is what a lock FILE cannot do, because a crash leaves the file behind and
  // whoever comes next has to guess whether it means anything.
  //
  // Scoped to the data directory rather than to the port. A second `serve` on the same port already fails to
  // listen; one on a different port over the same directory is the case only this catches.
  held.on('connection', (client) => client.destroy());

  try {
    await listening(held, socket);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw failure;

    if (await somebodyIsListening(socket)) {
      throw new DataInUse(`another shop is already serving ${root} - only one may, or they would hand out the same job ids`);
    }

    // Left by a shop that died. The path outlives the process even though the claim does not, so
    // this is the one thing that has to be tidied - and nobody answering is what makes it safe to.
    await rm(socket, { force: true });
    await listening(held, socket);
  }

  return () => held.close();
}

function listening(held: Server, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    held.once('error', reject);
    held.listen(socket, () => {
      held.removeListener('error', reject);
      resolve();
    });
  });
}

function somebodyIsListening(socket: string): Promise<boolean> {
  return new Promise((answer) => {
    const asking = createConnection(socket)
      .on('connect', () => {
        asking.destroy();
        answer(true);
      })
      .on('error', () => answer(false));
  });
}
