import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { run } from '../src/cli';
import { CALLERS_FILE } from '../src/credentials';
import { digestOf } from '../src/secrets';
import { aDataDirectory, parentOf } from './aDataDirectory';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: the sum of everything stopping does, which is the one thing none of the parts can say.
// What `stopTheShop` lets go of and in what order is tests/running.test.ts; that node ends a process
// once nothing holds its event loop open is in the assumption suite. Between them sits the claim
// that matters to an operator: the shop really does let go of ALL of it, so there is nothing left
// for node to keep the loop open with.
//
// Asked of node rather than of a process. `process.getActiveResourcesInfo()` names what is holding
// the loop right now, so a shop that is serving shows a listener and a clock that were not there
// before, and a shop that has stopped shows neither. This was a spawned process reading an exit
// code, which said only that the whole thing worked and never which handle was left behind.
describe('a shop asked to stop', () => {
  let where: DataLayout;
  let etc: string;
  let said: string[];
  let url: string;

  const ADMIN = 'dave-token';

  const holding = (): Record<string, number> => {
    const counted: Record<string, number> = {};
    for (const kind of process.getActiveResourcesInfo()) counted[kind] = (counted[kind] ?? 0) + 1;

    return counted;
  };

  const gained = (before: Record<string, number>, after: Record<string, number>): string[] =>
    [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((kind) => (after[kind] ?? 0) > (before[kind] ?? 0));

  const serving = async (): Promise<void> => {
    await run(['node', 'shop', 'serve', '--data', parentOf(where), '--etc', etc, '--port', '0'], () => undefined, {
      say: (lines) => said.push(...lines),
      // Dropped rather than read: what a serving shop writes down is log.test.ts's to ask about.
      // What matters here is that it has somewhere to go that is not the test's own output.
      writing: () => undefined,
    });

    const listening = /listening on (\S+):(\d+)/.exec(said.join('\n'));
    if (listening === null) throw new Error(`the shop never said where it was listening: ${said.join('\n')}`);
    url = `http://${listening[1]}:${listening[2]}`;
  };

  const askingItToStop = (): Promise<Response> => fetch(`${url}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } });

  // Whatever the shop let go of, it does so in its own time - the answer goes back before it starts.
  const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 250));

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-stopping-');
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-stopping-etc-'));
    await chmod(etc, 0o700);
    // A token is held as a DIGEST, so what goes in the file is what `digestOf` makes of the one a
    // request then presents. A file with a token in the clear is one this shop refuses to start on.
    await writeFile(
      path.join(etc, CALLERS_FILE),
      JSON.stringify([{ id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] }]),
      { mode: 0o600 },
    );
    said = [];
  });

  // AIDEV-NOTE: a shop left running holds its port and its data directory's claim for as long as the
  // process lives, and every test here would report green either way - so if one is still up, it is
  // stopped before the next begins rather than left for jest to trip over.
  afterEach(async () => {
    if (url !== '') await askingItToStop().catch(() => undefined);
    await settled();
    await rm(etc, { recursive: true, force: true });
    await rm(parentOf(where), { recursive: true, force: true });
    url = '';
  });

  it('holds a listener and a clock while it is serving', async () => {
    const before = holding();

    await serving();

    expect(gained(before, holding())).toEqual(expect.arrayContaining(['TCPServerWrap', 'Timeout']));
  }, 30_000);

  // The whole of it: what an operator sees as "the process ended" is this, and node doing the rest.
  it('is holding nothing at all once it has stopped', async () => {
    const before = holding();
    await serving();

    expect((await askingItToStop()).status).toBe(202);
    await settled();

    expect(gained(before, holding())).toEqual([]);
  }, 30_000);

  it('says so, so whoever asked knows it is done rather than merely answered', async () => {
    await serving();

    await askingItToStop();
    await settled();

    expect(said.join('\n')).toContain('3d-print-shop has stopped');
  }, 30_000);
});
