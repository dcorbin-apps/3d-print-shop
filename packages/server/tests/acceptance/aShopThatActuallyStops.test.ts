import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { digestOf } from '../../src/secrets';
import { aDataDirectory, parentOf } from '../aDataDirectory';
import type { DataLayout } from '../../src/dataLayout';

// AIDEV-NOTE: the last thing in this repository that needs a process of its own, and it needs one for
// exactly one reason: a shop that ANSWERED and stayed up would look identical to a client. Only a
// process can be asked whether it ended.
//
// Nothing else here is what it used to be. What stopping lets go of, and in what order, and that a
// second ask changes nothing, is tests/running.test.ts. What a signal does is tests/signals.test.ts,
// and that node ends a process without a handler for one is in the assumption suite beside the fact
// that it ends a process with nothing left holding the loop open. Which address a shop takes is
// tests/serve.test.ts; what an operator's commands do is tests/operatorCommands.test.ts; what a shop
// must have before it serves is tests/foundations.test.ts.
//
// What is left is the join of all of that: the shop really does let go of everything it holds, so
// node really does end it. Every piece of that is tested; only their sum needs a process.
describe('a shop asked to stop', () => {
  const SHOP = 'packages/server/src/main.ts';
  const ADMIN = 'dave-token';

  let where: DataLayout;
  let etc: string;
  let spawned: ChildProcess[];

  interface RunningShop {
    url: string;
    /** Settles when the process has ended, however it ended. */
    ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  }

  // AIDEV-NOTE: started as `node --import tsx`, which is ONE process. `yarn tsx` puts a runner in
  // front of it, and a runner that is asked to stop can leave the shop behind still holding the port.
  function startShop(): Promise<RunningShop> {
    return new Promise((listening, never) => {
      const shop = spawn('node', ['--import', 'tsx', SHOP, 'serve', '--data', parentOf(where), '--etc', etc, '--port', '0']);
      spawned.push(shop);

      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((over) => {
        shop.on('close', (code, signal) => over({ code, signal }));
      });

      let said = '';
      let complaint = '';
      shop.stdout.on('data', (chunk: Buffer) => {
        said += chunk.toString();
        const where0 = /listening on (\S+):(\d+)/.exec(said);
        if (where0) listening({ url: `http://${where0[1]}:${where0[2]}`, ended });
      });
      shop.stderr.on('data', (chunk: Buffer) => (complaint += chunk.toString()));
      shop.on('error', never);
      shop.on('close', (code) => never(new Error(`the shop stopped before it listened (${code}) ${complaint}`)));
    });
  }

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-stopping-');
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-stopping-etc-'));
    await chmod(etc, 0o700);
    // A token is held as a DIGEST, so what goes in the file is what `digestOf` makes of the one a
    // request then presents. A file with a token in the clear is one this shop refuses to start on.
    await writeFile(
      path.join(etc, 'callers.json'),
      JSON.stringify([{ id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] }]),
      { mode: 0o600 }
    );
    spawned = [];
  });

  // AIDEV-NOTE: a shop left running holds its port and its data directory's claim for as long as the
  // machine is up, and nothing else would notice - this file reports green either way. Two were once
  // found doing exactly that, one of them 14 hours old.
  afterEach(async () => {
    spawned.forEach((shop) => {
      if (shop.exitCode === null && shop.signalCode === null) shop.kill('SIGKILL');
    });
    await rm(etc, { recursive: true, force: true });
    await rm(parentOf(where), { recursive: true, force: true });
  });

  it('ends, rather than answering and staying up', async () => {
    const shop = await startShop();

    const answered = await fetch(`${shop.url}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(answered.status).toBe(202);

    // Of its own accord and with nothing killed: everything it was holding was let go, so node had
    // nothing left to keep the loop open with.
    expect(await shop.ended).toEqual({ code: 0, signal: null });
  }, 30_000);
});
