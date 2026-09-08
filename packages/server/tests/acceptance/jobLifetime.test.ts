import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { JobStore } from '../../src/JobStore';

// AIDEV-NOTE: the unit tests take each transition on its own; this takes a job all the way through
// one, in order, across a restart - which is the only way to find out whether the pieces compose.
//
// It also prints a gcode of a realistic SIZE. Every unit test uses a few bytes, so nothing else here
// would notice if the stream were being buffered whole or truncated part way; this is what makes
// "streamed, not held" a claim the suite actually checks.
describe('the life of a job', () => {
  let spool: string;

  const MEGABYTES = 8;

  function realisticGcode(): Readable {
    const line = 'G1 X100.000 Y100.000 E1.00000 F1200\n';
    const lines = Math.ceil((MEGABYTES * 1024 * 1024) / line.length);

    return Readable.from(
      (function* () {
        for (let i = 0; i < lines; i++) yield line;
      })()
    );
  }

  async function digestOf(gcode: Readable): Promise<string> {
    const hash = createHash('sha256');
    let bytes = 0;

    for await (const chunk of gcode) {
      hash.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
    }

    return `${hash.digest('hex')}:${bytes}`;
  }

  beforeEach(async () => {
    spool = await fs.mkdtemp(path.join(tmpdir(), 'print-shop-lifetime-'));
  });

  afterEach(async () => {
    await fs.rm(spool, { recursive: true, force: true });
  });

  const DAVE = 'u-dave';

  it(
    'is taken in, printed, rejected, printed again, approved, and gone',
    async () => {
      const shop = new JobStore(spool);
      await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://mk4' });

      const job = await shop.submit(
        {
          filaments: ['PLA-SpaceGray'],
          displayName: 'Player Box',
          requiredBuildVolume: { x: 120, y: 90, z: 40 },
          metadata: { pieces: [{ piece: 'player_box' }] },
        },
        realisticGcode(),
        DAVE
      );
      expect(job.gcodeBytes).toBeGreaterThan(MEGABYTES * 1024 * 1024);

      // What was stored is what arrived - a truncated or re-encoded stream would not match. Read
      // back as a stream too, which is how a printer will be fed it.
      const digest = await digestOf(await shop.gcodeStream(job.id));
      expect(digest.endsWith(`:${job.gcodeBytes}`)).toBe(true);

      // A print that ran to the end, and a person who says it is not usable anyway.
      await shop.startPrinting('mk4', job.id);
      await shop.finishedPrinting('mk4', 'finished');
      expect(await shop.reject(job.id)).toMatchObject({ state: 'queued' });

      // The service restarts while the reprint is still owed.
      const afterRestart = new JobStore(spool);
      expect(await afterRestart.all()).toMatchObject([{ id: job.id, displayName: 'Player Box', state: 'queued' }]);

      // The same bytes are still there to run again - which is why approval, not the printer, is
      // what discards them.
      expect(await digestOf(await afterRestart.gcodeStream(job.id))).toBe(digest);

      await afterRestart.startPrinting('mk4', job.id);
      await afterRestart.finishedPrinting('mk4', 'finished');
      await afterRestart.approve(job.id);

      // The shop holds outstanding work, so a job that succeeded leaves no trace in it.
      expect(await afterRestart.all()).toEqual([]);
      await expect(fs.readdir(path.join(spool, 'jobs'))).resolves.toEqual([]);

      // ...but its number is spent. The next job is 2.
      const next = await afterRestart.submit({ filaments: ['PLA-White'] }, Readable.from(['G1 X0\n']), DAVE);
      expect(next.id).toBe(2);
    },
    30_000
  );
});
