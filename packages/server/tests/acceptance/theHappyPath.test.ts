import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { HttpShop } from '@3d-print-shop/client';
import { startOctoPrintServer } from '@3d-print-shop/octoprint-sim';
import type { OctoPrintServer, SubmittedJob } from '@3d-print-shop/octoprint-sim';
import { aDataDirectory, parentOf } from '../aDataDirectory';
import type { Job } from '@3d-print-shop/client';
import type { DataLayout } from '../../src/dataLayout';

// AIDEV-NOTE: the one acceptance test, and the only claim in this repository that no seam can reach:
// that all of it works together, as an operator meets it. A machine is set up, a shop is started as
// its own process, a client from the published package talks to it over a socket, a printer answers
// on another socket, and work goes round the loop - printed, judged, printed again, approved, and the
// next one started.
//
// Everything it touches is tested apart, and precisely: what each route does, what each rule refuses,
// what stopping lets go of, what the client puts on the wire, what node and ws and busboy do. None of
// that is asked again here. What is asked is the thing none of them can be: that the pieces, wired up
// the way an installed machine wires them, carry a job from a submission to a verdict.
//
// It is slow and it is one test, and both are on purpose. A second would be the same wiring again.
describe('a shop, a printer, and two jobs', () => {
  const SHOP = 'packages/server/src/main.ts';
  const A_PASSWORD = 'a password of some length';

  let where: DataLayout;
  let etc: string;
  let spawned: ChildProcess[];
  let printer: OctoPrintServer | undefined;
  let printed: string[];
  let shop: HttpShop;
  let stopped: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  /** Every job the printer was asked to run, in order, each completed the moment it arrived. */
  function startThePrinter(): Promise<OctoPrintServer> {
    return startOctoPrintServer(0, (job: SubmittedJob, complete) => {
      printed.push(job.remotePath);
      complete('PrintDone');
    });
  }

  function saying(args: string[], typing?: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((ended, never) => {
      const command = spawn('node', ['--import', 'tsx', SHOP, ...args]);
      spawned.push(command);
      if (typing !== undefined) command.stdin.write(typing);
      command.stdin.end();

      let stdout = '';
      command.stdout.on('data', (said: Buffer) => (stdout += said.toString()));
      command.on('error', never);
      command.on('close', (code) => ended({ code, stdout }));
    });
  }

  // AIDEV-NOTE: `node --import tsx`, which is ONE process. `yarn tsx` puts a runner in front of it,
  // and a runner asked to stop can leave the shop behind still holding the port.
  function startTheShop(): Promise<string> {
    return new Promise((listening, never) => {
      const running = spawn('node', ['--import', 'tsx', SHOP, 'serve', '--data', parentOf(where), '--etc', etc, '--port', '0']);
      spawned.push(running);
      stopped = new Promise((ended) => running.on('close', (code, signal) => ended({ code, signal })));

      let said = '';
      let complaint = '';
      running.stdout.on('data', (chunk: Buffer) => {
        said += chunk.toString();
        const at = /listening on (\S+):(\d+)/.exec(said);
        if (at) listening(`http://${at[1]}:${at[2]}`);
      });
      running.stderr.on('data', (chunk: Buffer) => (complaint += chunk.toString()));
      running.on('error', never);
      running.on('close', (code) => never(new Error(`the shop stopped before it listened (${code}) ${complaint}`)));
    });
  }

  /** Polls the shop rather than sleeping, so a slow machine waits and a quick one does not. */
  async function until<T>(wanted: string, asking: () => Promise<T | undefined>): Promise<T> {
    const giveUpAt = Date.now() + 20_000;

    for (;;) {
      const answer = await asking();
      if (answer !== undefined) return answer;
      if (Date.now() > giveUpAt) throw new Error(`gave up waiting for ${wanted}`);
      await new Promise((again) => setTimeout(again, 50));
    }
  }

  const held = async (): Promise<Job[]> => (await shop.jobs()).accessibleJobs;
  const holding = async (named: string): Promise<Job | undefined> => (await held()).find((job) => job.displayName === named);

  const waitingForAPerson = (named: string): Promise<Job> =>
    until(`${named} to finish printing`, async () => {
      const job = await holding(named);

      return job?.state === 'awaiting-approval' ? job : undefined;
    });

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-happy-');
    etc = path.join(await mkdtemp(path.join(tmpdir(), 'print-shop-happy-etc-')), 'etc');
    spawned = [];
    printed = [];
  }, 30_000);

  // AIDEV-NOTE: a shop left running holds its port and its data directory's claim for as long as the
  // machine is up, and this file would report green either way. Killed rather than asked, because by
  // the time this runs the test has either stopped it or has nothing to say about it.
  afterEach(async () => {
    spawned.forEach((child) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await printer?.close();
    printer = undefined;
    await rm(path.dirname(etc), { recursive: true, force: true });
    await rm(parentOf(where), { recursive: true, force: true });
  });

  it('prints one job, prints it again when it is rejected, and starts the next when it is approved', async () => {
    printer = await startThePrinter();

    // A machine nobody has set up yet, set up the way an operator sets one up.
    const { stdout } = await saying(['init', 'dave', '--etc', etc], `${A_PASSWORD}\n${A_PASSWORD}\n`);
    const token = /\b[0-9a-f]{64}\b/.exec(stdout)?.[0];
    expect(token).toBeDefined();

    const url = await startTheShop();
    shop = new HttpShop(url, token);

    // The printer is added with the key it is reached by, in one call, and told what is on it.
    const { created } = await shop.addPrinter(
      { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: `http://127.0.0.1:${printer.port}` },
      'a-key-for-the-sim',
    );
    expect(created).toBe(true);
    await shop.load('mk4', ['PLA']);

    const first = await shop.submit({ filaments: ['PLA'], displayName: 'First' }, new Blob(['G1 X10 Y10\n']));
    await shop.submit({ filaments: ['PLA'], displayName: 'Second' }, new Blob(['G1 X20 Y20\n']));

    // One at a time: a printer holding a job takes no other, so the second waits its turn.
    const printedFirst = await waitingForAPerson('First');
    expect((await holding('Second'))?.state).toBe('queued');

    // AIDEV-NOTE: what the machine was ASKED to run, and the shop's own name for it - a job is filed
    // by its id rather than by what a person called it, because ids are unique and safe in a path
    // and display names are neither. What that name IS belongs to `remotePathFor` and its own tests;
    // what is asked here is only which job went, and how many times.
    expect(printed).toEqual([`3d-print-shop/job-${first.id}.gcode`]);

    // Rejected. The plate was no good, so the SAME job goes round again - the second print of it is
    // the same file, under the same name, on the same bed.
    expect(await shop.verdict(printedFirst.id, 'rejected')).toMatchObject({ id: first.id, state: 'queued' });
    await waitingForAPerson('First');
    expect(printed).toEqual([`3d-print-shop/job-${first.id}.gcode`, `3d-print-shop/job-${first.id}.gcode`]);

    // Approved. It leaves the shop, which frees the bed for what was waiting behind it.
    expect(await shop.verdict(first.id, 'approved')).toBeUndefined();
    const printedSecond = await waitingForAPerson('Second');
    expect(printed[2]).toBe(`3d-print-shop/job-${printedSecond.id}.gcode`);
    expect(printed).toHaveLength(3);
    expect(await holding('First')).toBeUndefined();

    await shop.shutDown();
    expect(await stopped).toEqual({ code: 0, signal: null });
  }, 120_000);
});
