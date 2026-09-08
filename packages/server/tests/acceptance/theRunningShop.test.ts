import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    /** The address it actually bound, which is what `--listen` is for. */
    address: string;
    stop: () => Promise<void>;
    /** Settles when the process has ended, however it was asked to. */
    stopped: Promise<void>;
  }

  let spool: string;
  let started: RunningShop[];

  function startShop(): Promise<RunningShop> {
    return startShopOver(spool);
  }

  function startShopOver(root: string, alsoSaying: string[] = []): Promise<RunningShop> {
    return new Promise<RunningShop>((resolve, reject) => {
      const shop = spawn('node', ['--import', 'tsx', SHOP, 'serve', '--spool', root, '--port', '0', ...alsoSaying]);
      let said = '';
      let complaint = '';

      shop.stdout.on('data', (chunk: Buffer) => {
        said += chunk.toString();

        // The address and port it actually took, which is the only way to find an ephemeral one.
        const listening = /listening on (\S+):(\d+)/.exec(said);
        if (listening) {
          resolve({
            address: listening[1],
            url: reachedAt(listening[1], listening[2]),
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

  // An IPv6 address is bracketed in a URL, where an IPv4 one must not be.
  function reachedAt(address: string, port: string): string {
    return address.includes(':') ? `http://[${address}]:${port}` : `http://${address}:${port}`;
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

  function runCommandSaying(args: string[], carrying: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const command = spawn('node', ['--import', 'tsx', SHOP, ...args], { env: { ...process.env, ...carrying } });
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
    return submitGcode(shop, GCODE);
  }

  // 0600, because the shop refuses to read credentials anybody else could.
  async function credentialsNaming(callers: { id: string; name: string; role: string; token: string }[]): Promise<string> {
    const etc = await mkdtemp(path.join(tmpdir(), 'print-shop-etc-'));
    await writeFile(path.join(etc, 'callers.json'), JSON.stringify(callers), { mode: 0o600 });

    return etc;
  }

  async function submitGcode(shop: RunningShop, gcode: string): Promise<Response> {
    const body = new FormData();
    body.append('job', JSON.stringify({ filaments: ['PLA-SpaceGray'], displayName: 'Player Box' }));
    body.append('gcode', new Blob([gcode]), 'print.gcode');

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

  // The cap belongs to the operator: a slicer that outgrows the default has to be able to say so,
  // and the shop keeps that much room spare on the spool for every job it accepts.
  it('takes gcode up to the size --max-gcode names, and no more', async () => {
    const shop = await startShopOver(spool, ['--max-gcode', '1']);
    started.push(shop);
    await addMk4(shop);

    const oneMegabyte = 1024 * 1024;
    expect((await submitGcode(shop, 'G'.repeat(oneMegabyte))).status).toBe(201);

    const over = await submitGcode(shop, 'G'.repeat(oneMegabyte + 1));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: `gcode is longer than the ${oneMegabyte} bytes this shop takes` });
  }, 30_000);

  // AIDEV-NOTE: the whole path a token travels - an environment variable, into HttpShop, onto the
  // wire as a header, and back out as a role the shop enforces. Every other test of this reaches the
  // routes with fetch and a hand-written header, which proves nothing about the client that clients
  // actually use.
  describe('an operator carrying a token', () => {
    const ADMIN = 'dave-token';
    const USER = 'gamebox-token';

    async function guardedShop(): Promise<RunningShop> {
      const etc = await credentialsNaming([
        { id: 'dave', name: 'dave', role: 'admin', token: ADMIN },
        { id: 'gamebox', name: 'gamebox', role: 'user', token: USER },
      ]);
      const shop = await startShopOver(spool, ['--etc', etc]);
      started.push(shop);

      return shop;
    }

    it('is let in when the token is one the shop knows', async () => {
      const shop = await guardedShop();

      const listing = await runCommandSaying(['printer', '--shop-url', shop.url, 'list'], { PRINT_SHOP_TOKEN: ADMIN });

      expect(listing.code).toBe(0);
    }, 30_000);

    it('is refused when carrying no token at all', async () => {
      const shop = await guardedShop();

      expect(await runCommand(['printer', '--shop-url', shop.url, 'list'])).toBe(1);
    }, 30_000);

    // The role travels with the token: the same command, the same shop, a different caller.
    it('is refused a printer command when the token is only a user', async () => {
      const shop = await guardedShop();

      const stopping = ['printer', '--shop-url', shop.url, 'stop', 'mk4', 'door is open'];

      expect((await runCommandSaying(stopping, { PRINT_SHOP_TOKEN: USER })).code).toBe(1);
    }, 30_000);
  });

  // Loopback is the default because nothing else is authenticated by default - so the interface it
  // binds is the access control, and going past it is the operator's decision rather than a default.
  describe('where it listens', () => {
    it('is loopback, so a shop naming no callers is not on the network', async () => {
      expect((await shopIsRunning()).address).toBe('127.0.0.1');
    }, 30_000);

    // The pair that matters: past loopback, a shop that named nobody would be one ANYBODY could
    // submit to, delete a printer on, or shut down - so it does not start at all.
    it('will not go past loopback when nobody is named who may call', async () => {
      const refused = await runCommandSaying(['serve', '--spool', spool, '--port', '0', '--listen', '::1', '--etc', spool]);

      expect(refused.code).toBe(1);
    }, 30_000);

    // `::1` rather than an address off this machine: it proves the option is carried through to the
    // listener without a test that opens a port to the network.
    it('is the address --listen names, and it answers there', async () => {
      const etc = await credentialsNaming([{ id: 'dave', name: 'dave', role: 'admin', token: 'a-token' }]);
      const shop = await startShopOver(spool, ['--listen', '::1', '--etc', etc]);
      started.push(shop);

      expect(shop.address).toBe('::1');
      expect((await fetch(`${shop.url}/printers`, { headers: { authorization: 'Bearer a-token' } })).status).toBe(200);
    }, 30_000);
  });
});
