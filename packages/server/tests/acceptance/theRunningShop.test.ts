import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// AIDEV-NOTE: the shop as an operator gets it - a process started from a command line, holding a
// spool it was pointed at, answered over a socket. api.test.ts drives the same routes in-process and
// so proves nothing about main.ts, argv, the spool option, or that any of it survives a restart.
//
// Started as `node --import tsx`, which is ONE process: `yarn tsx` puts a runner in front of it, and
// a signal sent to the runner can leave the shop holding the port.
describe('the shop, running as its own process', () => {
  const SHOP = 'packages/server/src/main.ts';
  const MK4 = { x: 250, y: 210, z: 220 };
  const GCODE = 'G1 X100.000 Y100.000 E1.00000\n';

  interface RunningShop {
    url: string;
    stop: () => Promise<void>;
    /** Settles when the process has ended, however it was asked to. */
    stopped: Promise<void>;
  }

  let spool: string;
  let started: RunningShop[];

  function startShop(): Promise<RunningShop> {
    return startShopOver(spool);
  }

  function startShopOver(root: string): Promise<RunningShop> {
    return new Promise<RunningShop>((resolve, reject) => {
      const shop = spawn('node', ['--import', 'tsx', SHOP, 'serve', '--spool', root, '--port', '0']);
      let said = '';
      let complaint = '';

      shop.stdout.on('data', (chunk: Buffer) => {
        said += chunk.toString();

        // The port it actually took, which is the only way to find an ephemeral one.
        const listening = /listening on (\d+)/.exec(said);
        if (listening) {
          resolve({
            url: `http://127.0.0.1:${listening[1]}`,
            stop: () => stopShop(shop),
            stopped: new Promise<void>((ended) => shop.on('close', () => ended())),
          });
        }
      });

      shop.stderr.on('data', (chunk: Buffer) => {
        complaint += chunk.toString();
      });

      shop.on('error', reject);
      shop.on('close', (code) => reject(new Error(`the shop stopped before it was listening (${code}) ${complaint}`)));
    });
  }

  function stopShop(shop: ChildProcess): Promise<void> {
    // Asked twice when a test stops one itself and the teardown stops what it started.
    if (shop.exitCode !== null || shop.signalCode !== null) return Promise.resolve();

    return new Promise<void>((resolve) => {
      shop.on('close', () => resolve());
      shop.kill();
    });
  }

  async function runCommand(args: string[]): Promise<number> {
    return (await runCommandSaying(args)).code;
  }

  function runCommandSaying(args: string[]): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const command = spawn('node', ['--import', 'tsx', SHOP, ...args]);
      let stdout = '';

      command.stdout.on('data', (said: Buffer) => (stdout += said.toString()));
      command.on('error', reject);
      command.on('close', (code) => resolve({ code: code ?? 0, stdout }));
    });
  }

  async function shopIsRunning(): Promise<RunningShop> {
    const shop = await startShop();
    started.push(shop);

    return shop;
  }

  async function addMk4(shop: RunningShop): Promise<void> {
    await fetch(`${shop.url}/printers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mk4', buildVolume: MK4, address: 'http://octopi.local' }),
    });
  }

  async function submitPlayerBox(shop: RunningShop): Promise<Response> {
    const body = new FormData();
    body.append('job', JSON.stringify({ filaments: ['PLA-SpaceGray'], displayName: 'Player Box' }));
    body.append('gcode', new Blob([GCODE]), 'print.gcode');

    return fetch(`${shop.url}/jobs`, { method: 'POST', body });
  }

  beforeEach(async () => {
    spool = await mkdtemp(path.join(tmpdir(), 'print-shop-running-'));
    started = [];
  });

  afterEach(async () => {
    await Promise.all(started.map((shop) => shop.stop()));
    await rm(spool, { recursive: true, force: true });
  });

  it('keeps what it is given in the spool it was pointed at', async () => {
    const shop = await shopIsRunning();
    await addMk4(shop);

    expect((await submitPlayerBox(shop)).status).toBe(201);
    expect(await readFile(path.join(spool, 'jobs', '1', 'print.gcode'), 'utf-8')).toBe(GCODE);
  }, 30_000);

  // The operator's commands are a CLIENT of the running shop rather than a second writer over its
  // files - so this goes the whole way through: argv, the API, the store, and back out of a GET.
  it('takes a printer the operator adds through the running shop', async () => {
    const shop = await shopIsRunning();
    expect(await (await fetch(`${shop.url}/printers`)).json()).toEqual([]);

    expect(await runCommand(['printer', '--shop-url', shop.url, 'add', 'mk4', '250x210x220', 'http://mk4'])).toBe(0);

    expect(await (await fetch(`${shop.url}/printers`)).json()).toEqual([
      { name: 'mk4', buildVolume: MK4, api: 'octoprint', address: 'http://mk4', loaded: [] },
    ]);
  }, 30_000);

  // AIDEV-NOTE: the whole way through - argv, the API, the foreman letting go of its machines, and a
  // process that actually ends. A shop that answered and stayed up would look identical to a client.
  // The spool is made when the shop is installed and never by the shop, so a missing one is a
  // machine that was never set up - and it is worth finding out before anything is served.
  it('will not start over a spool that is not there', async () => {
    await expect(startShopOver(path.join(spool, 'never-made'))).rejects.toThrow('is not there');
  }, 30_000);

  // AIDEV-NOTE: the verdict is what frees a printer's bed, so without a way to give one a shop
  // prints a single thing per machine and stops. This proves the operator has one - argv, the API,
  // the store, and back out as a line a person can read.
  it('shows the operator what it is holding', async () => {
    const shop = await shopIsRunning();
    await addMk4(shop);
    await submitPlayerBox(shop);

    const { stdout } = await runCommandSaying(['job', '--shop-url', shop.url, 'list']);

    expect(stdout.trim()).toBe('1  Player Box  PLA-SpaceGray  queued');
  }, 30_000);

  // AIDEV-NOTE: two shops over one spool would both read `next-id` as 7 and both hand out 7, the
  // second overwriting the first job's gcode with no error anywhere. A second `serve` on the same
  // PORT already fails to listen; this is the case only the spool's own claim catches.
  it('will not serve a spool another shop already has', async () => {
    await shopIsRunning();

    await expect(startShop()).rejects.toThrow('already serving');
  }, 30_000);

  it('stops when the operator asks it to', async () => {
    const shop = await shopIsRunning();

    expect(await runCommand(['shutdown', '--shop-url', shop.url])).toBe(0);

    await shop.stopped;
  }, 30_000);

  it('is still holding the job after it has been stopped and started again', async () => {
    const first = await shopIsRunning();
    await addMk4(first);
    await submitPlayerBox(first);
    await first.stop();

    const again = await shopIsRunning();

    expect(await (await fetch(`${again.url}/jobs`)).json()).toMatchObject([{ id: 1, displayName: 'Player Box', state: 'queued' }]);
  }, 30_000);
});
