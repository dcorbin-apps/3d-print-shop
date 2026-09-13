import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { digestOf } from '../../src/secrets';
import { aDataDirectory, parentOf } from '../aDataDirectory';
import type { DataLayout } from '../../src/dataLayout';

// AIDEV-NOTE: the shop as an operator gets it - a process started from a command line, holding a
// data directory it was pointed at, answered over a socket. api.test.ts drives the same routes in-process and
// so proves nothing about main.ts, argv, the --data option, or that any of it survives a restart.
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
    /** What an operator sends after editing the credentials - the shop re-reads them and keeps running. */
    reload: () => void;
    /** Settles once the shop has written a line like this, which is how a test waits for a signal to land. */
    saysSomethingLike: (pattern: RegExp) => Promise<void>;
    // Waiting cannot prove an absence - it would only ever time out - so this reads what has been
    // said so far, after something later has been waited for.
    /** Whether the shop has said anything like this yet. */
    hasSaid: (pattern: RegExp) => boolean;
    stop: () => Promise<void>;
    /** Settles when the process has ended, however it was asked to. */
    stopped: Promise<void>;
  }

  interface WrittenCaller {
    id: string;
    name: string;
    role: string;
    token: string;
  }

  // No route answers a caller the shop cannot name, so every shop here is started with credentials
  // and every request carries a token.
  const ADMIN = 'dave-token';
  const USER = 'slicer-token';
  const asAdmin = { authorization: `Bearer ${ADMIN}` };

  let dataRoot: string;
  let where: DataLayout;
  let etc: string;
  let madeEtc: string[];
  // AIDEV-NOTE: every process this suite spawns, tracked from the spawn itself rather than from the
  // promise resolving. A shop started by a test that EXPECTS a refusal was tracked by nothing: if it
  // ever came up anyway - which is what a failure of that test looks like - nothing would stop it,
  // and the suite would report green while leaving a shop listening for as long as the machine was
  // up. Two were found doing exactly that, one of them 14 hours old.
  let spawned: ChildProcess[];

  function startShop(): Promise<RunningShop> {
    return startShopOver(dataRoot);
  }

  function startShopOver(root: string, alsoSaying: string[] = [], credentials: string = etc): Promise<RunningShop> {
    return new Promise<RunningShop>((resolve, reject) => {
      const shop = spawn('node', ['--import', 'tsx', SHOP, 'serve', '--data', root, '--etc', credentials, '--port', '0', ...alsoSaying]);
      spawned.push(shop);
      let said = '';
      let complaint = '';
      // AIDEV-NOTE: a signal is answered in the shop's own time, so a test that sent one has nothing
      // to await. Its log is what says the signal landed, and waiting on a line beats a sleep.
      let waiting: { pattern: RegExp; heard: () => void }[] = [];

      shop.stdout.on('data', (chunk: Buffer) => {
        said += chunk.toString();

        // The address and port it actually took, which is the only way to find an ephemeral one.
        const listening = /listening on (\S+):(\d+)/.exec(said);
        if (listening) {
          resolve({
            address: listening[1],
            url: reachedAt(listening[1], listening[2]),
            reload: () => shop.kill('SIGHUP'),
            saysSomethingLike: (pattern: RegExp) =>
              new Promise<void>((heard) => {
                if (pattern.test(said)) heard();
                else waiting.push({ pattern, heard });
              }),
            hasSaid: (pattern: RegExp) => pattern.test(said),
            stop: () => stopShop(shop),
            stopped: new Promise<void>((ended) => shop.on('close', () => ended())),
          });
        }

        const arrived = waiting.filter((waiter) => waiter.pattern.test(said));
        waiting = waiting.filter((waiter) => !arrived.includes(waiter));
        arrived.forEach((waiter) => waiter.heard());
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

  function runCommandSaying(
    args: string[],
    carrying: Record<string, string> = { PRINT_SHOP_TOKEN: ADMIN },
    // AIDEV-NOTE: what a command asks for rather than takes as an argument - a password, which is
    // never in argv because argv is `ps` and shell history. Not a terminal here, so it is read as a
    // line, which is the path that lets this be driven at all.
    typing?: string
  ): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const command = spawn('node', ['--import', 'tsx', SHOP, ...args], { env: { ...process.env, ...carrying } });
      if (typing !== undefined) command.stdin.write(typing);
      command.stdin.end();
      let stdout = '';

      command.stdout.on('data', (said: Buffer) => (stdout += said.toString()));
      command.on('error', reject);
      command.on('close', (code) => resolve({ code: code ?? 0, stdout }));
    });
  }

  async function shopIsRunning(): Promise<RunningShop> {
    return startShop();
  }

  async function addMk4(shop: RunningShop): Promise<void> {
    await addPrinter(shop, { name: 'mk4', buildVolume: MK4, address: 'http://octopi.local' });
  }

  async function addPrinter(shop: RunningShop, record: { name: string; buildVolume: typeof MK4; address: string }): Promise<void> {
    await fetch(`${shop.url}/printers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...asAdmin },
      body: JSON.stringify(record),
    });
  }



  async function submitAs(shop: RunningShop, token: string, displayName: string): Promise<Response> {
    const body = new FormData();
    body.append('job', JSON.stringify({ filaments: ['PLA-SpaceGray'], displayName }));
    body.append('gcode', new Blob([GCODE]), 'print.gcode');

    return fetch(`${shop.url}/jobs`, { method: 'POST', body, headers: { authorization: `Bearer ${token}` } });
  }

  // 0600, because the shop refuses to read credentials anybody else could.
  async function credentialsNaming(callers: WrittenCaller[]): Promise<string> {
    const written = await mkdtemp(path.join(tmpdir(), 'print-shop-etc-'));
    madeEtc.push(written);
    await writeCallers(written, callers);

    return written;
  }

  // AIDEV-NOTE: written the way the shop reads it - a token is held as a DIGEST, so what goes in the
  // file is what `digestOf` makes of the token a test then presents. A file with a token in the
  // clear is one this shop refuses to start on, which is the point of that refusal.
  async function writeCallers(credentials: string, callers: WrittenCaller[]): Promise<void> {
    const held = callers.map(({ id, name, role, token }) => ({
      id,
      name,
      role,
      credentials: [{ kind: 'token', hash: digestOf(token) }],
    }));

    await writeFile(path.join(credentials, 'callers.json'), JSON.stringify(held), { mode: 0o600 });
  }



  function ask(shop: RunningShop, path: string): Promise<Response> {
    return fetch(`${shop.url}${path}`, { headers: asAdmin });
  }

  // A route every caller may reach, so what the answer turns on is whether the shop knows the token.
  function askCarrying(shop: RunningShop, token: string): Promise<Response> {
    return fetch(`${shop.url}/jobs`, { headers: { authorization: `Bearer ${token}` } });
  }

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-running-');
    dataRoot = parentOf(where);
    spawned = [];
    madeEtc = [];
    etc = await credentialsNaming([{ id: 'dave', name: 'dave', role: 'admin', token: ADMIN }]);
  });

  afterEach(async () => {
    await Promise.all(spawned.map((shop) => stopShop(shop)));

    // AIDEV-NOTE: the suite saying it cleaned up after itself. Nothing else would notice a shop left
    // listening - every test here reports green either way - and a leaked one holds its port, and
    // its data directory's lock socket, for as long as the machine is up.
    expect(spawned.filter((shop) => shop.exitCode === null && shop.signalCode === null)).toEqual([]);
    await Promise.all([dataRoot, ...madeEtc].map((made) => rm(made, { recursive: true, force: true })));
  });

  const A_PASSWORD = 'a password of some length';

  // AIDEV-NOTE: a person logging in to the real thing - the file written by the command an operator
  // actually runs, read by a shop started the way one is started, over a socket. Everything else
  // about passwords is unit-tested; what is proved here is that those pieces are the ones wired up.
  describe('somebody logging in', () => {
    const PASSWORD = A_PASSWORD;

    // The operator's own command, not a file written by this test - so what is being logged in to is
    // what `init` makes, hashing and all. Answered with the directory rather than the shop, because a
    // restart has to be a second shop over the same one.
    async function aMachineSomebodyCanLogInTo(): Promise<string> {
      const credentials = await mkdtemp(path.join(tmpdir(), 'print-shop-etc-'));
      madeEtc.push(credentials);

      await runCommandSaying(['init', 'dave', '--etc', credentials], {}, `${PASSWORD}\n${PASSWORD}\n`);

      return credentials;
    }


    const logIn = (shop: RunningShop, id: string, password: string): Promise<Response> =>
      fetch(`${shop.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, password }),
      });

    const cookieFor = async (shop: RunningShop): Promise<string> =>
      ((await logIn(shop, 'dave', PASSWORD)).headers.get('set-cookie') ?? '').split(';')[0];

    // AIDEV-NOTE: `caller password` says every browser logged in as them is logged out once the shop
    // has re-read this. It was not true: the id still existed, so the session went on naming them.
    it('is logged out by the password being changed, once the shop has re-read it', async () => {
      const credentials = await aMachineSomebodyCanLogInTo();
      const shop = await startShopOver(dataRoot, [], credentials);

      const cookie = await cookieFor(shop);
      expect((await fetch(`${shop.url}/me`, { headers: { cookie } })).status).toBe(200);

      const changed = 'a different password entirely';
      await runCommandSaying(['caller', 'password', 'dave', '--etc', credentials], {}, `${changed}\n${changed}\n`);
      shop.reload();
      await shop.saysSomethingLike(/a changed password logged out every browser/);

      expect((await fetch(`${shop.url}/me`, { headers: { cookie } })).status).toBe(401);
    }, 60_000);

  });

  // AIDEV-NOTE: the shop WRITING its own credentials file, which is the one thing it does to /etc
  // and the reason a printer can be given its key from a browser. Provable only here: which file the
  // keys live in, and that the running process is told at the same moment, is main.ts's wiring.
  it('writes a key it is given with a printer where it keeps them, and does not wait to be signalled', async () => {
    const credentials = await credentialsNaming([{ id: 'dave', name: 'dave', role: 'admin', token: ADMIN }]);
    const shop = await startShopOver(dataRoot, [], credentials);

    const added = await fetch(`${shop.url}/printers`, {
      method: 'POST',
      headers: { ...asAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mk4', buildVolume: MK4, address: 'http://mk4', key: 'a-key-from-a-browser' }),
    });
    expect(added.status).toBe(201);

    // On disk, in the file the shop reads its keys from, and only its owner can read it.
    const kept = path.join(credentials, 'printer-keys.json');
    expect(JSON.parse(await readFile(kept, 'utf-8'))).toEqual({ mk4: 'a-key-from-a-browser' });
    expect((await stat(kept)).mode & 0o077).toBe(0);

    // And the process that wrote it acted on it then and there rather than waiting for a SIGHUP.
    await shop.saysSomethingLike(/a printer was given its key/);
  }, 30_000);

  // AIDEV-NOTE: what only a spawned process can say about stopping - that the process ENDS. A shop
  // that answered and stayed up would look identical to a client, and nothing below a real process
  // can tell the two apart. What stopping DOES - the order it lets things go in, that a second ask
  // changes nothing, that it says so once the watchers have settled - is tests/running.test.ts.
  it('stops when the operator asks it to', async () => {
    const shop = await shopIsRunning();

    expect(await runCommand(['shutdown', '--shop-url', shop.url])).toBe(0);

    await shop.stopped;
  }, 30_000);

  // AIDEV-NOTE: the whole path a token travels - an environment variable, into HttpShop, onto the
  // wire as a header, and back out as a role the shop enforces. Every other test of this reaches the
  // routes with fetch and a hand-written header, which proves nothing about the client that clients
  // actually use.
  describe('an operator carrying a token', () => {
    async function guardedShop(): Promise<RunningShop> {
      const bothOfThem = await credentialsNaming([
        { id: 'dave', name: 'dave', role: 'admin', token: ADMIN },
        { id: 'slicer', name: 'slicer', role: 'user', token: USER },
      ]);
      const shop = await startShopOver(dataRoot, [], bothOfThem);

      return shop;
    }

    it('is let in when the token is one the shop knows', async () => {
      const shop = await guardedShop();

      const listing = await runCommandSaying(['printer', '--shop-url', shop.url, 'list'], { PRINT_SHOP_TOKEN: ADMIN });

      expect(listing.code).toBe(0);
    }, 30_000);

    // XDG_CONFIG_HOME at a directory with no token in it, so what this proves is the shop refusing
    // a nameless caller rather than whatever token the machine running the test happens to hold.
    it('is refused when carrying no token at all', async () => {
      const shop = await guardedShop();

      const listing = ['printer', '--shop-url', shop.url, 'list'];

      expect((await runCommandSaying(listing, { PRINT_SHOP_TOKEN: '', XDG_CONFIG_HOME: dataRoot })).code).toBe(1);
    }, 30_000);

    // AIDEV-NOTE: the whole way through, for the half of access control a role cannot express -
    // argv, the API, the store, and back out as the lines a person reads. A user is shown their own
    // work and told only how much else the shop is holding.
    it('is shown its own work, and a count of what is not', async () => {
      const shop = await guardedShop();
      await addMk4(shop);
      await submitAs(shop, USER, 'Player Box');
      await submitAs(shop, ADMIN, 'Somebody Else');

      const { stdout } = await runCommandSaying(['job', '--shop-url', shop.url, 'list'], { PRINT_SHOP_TOKEN: USER });

      expect(stdout.trim().split('\n')).toEqual([
        '1  Player Box  PLA-SpaceGray  queued',
        'and 1 more this shop is holding, which are not yours',
      ]);
    }, 30_000);

    // The role travels with the token: the same command, the same shop, a different caller.
    it('is refused a printer command when the token is only a user', async () => {
      const shop = await guardedShop();

      const stopping = ['printer', '--shop-url', shop.url, 'stop', 'mk4', 'door is open'];

      expect((await runCommandSaying(stopping, { PRINT_SHOP_TOKEN: USER })).code).toBe(1);
    }, 30_000);
  });

  // AIDEV-NOTE: changing a credential used to mean stopping the shop, which meant losing sight of
  // every print it was watching. SIGHUP is what a long-running service is told to re-read its
  // configuration with, and the whole of the mechanism is the files it already reads, read again.
  // AIDEV-NOTE: what only a spawned process can say about a signal: that it ARRIVES, and that the
  // shop is still there afterwards to answer. node ENDS a process that has no handler for SIGHUP, so
  // a shop that answers a request after one is a shop that registered one and stayed up.
  //
  // What each signal DOES - which are registered, that SIGTERM and SIGINT stop where SIGHUP does
  // not, what a re-read holds afterwards, who a changed password logs out - is tests/signals.test.ts,
  // where it can be asked directly instead of being read back off a log line.
  describe('told to re-read its credentials', () => {
    const DAVE = { id: 'dave', name: 'dave', role: 'admin', token: ADMIN };
    const SLICER = { id: 'slicer', name: 'slicer', role: 'user', token: USER };

    it('is still running afterwards, and answers a caller the file has since named', async () => {
      const credentials = await credentialsNaming([DAVE]);
      const shop = await startShopOver(dataRoot, [], credentials);
      expect((await askCarrying(shop, USER)).status).toBe(401);

      await writeCallers(credentials, [DAVE, SLICER]);
      shop.reload();
      await shop.saysSomethingLike(/callers re-read/);

      expect((await askCarrying(shop, USER)).status).toBe(200);
    }, 30_000);
  });

  // A token travels in the clear over http, so loopback is the default even though every route is
  // now authenticated - and going past it is the operator's decision rather than a default.
  describe('where it listens', () => {
    it('is loopback unless the operator asks for somewhere else', async () => {
      expect((await shopIsRunning()).address).toBe('127.0.0.1');
    }, 30_000);

    // `::1` rather than an address off this machine: it proves the option is carried through to the
    // listener without a test that opens a port to the network.
    it('is the address --listen names, and it answers there', async () => {
      const shop = await startShopOver(dataRoot, ['--listen', '::1']);

      expect(shop.address).toBe('::1');
      expect((await ask(shop, '/printers')).status).toBe(200);
    }, 30_000);
  });

  // AIDEV-NOTE: the whole point of removing the anonymous mode - a shop whose credentials are not
  // there does not start, rather than starting as one anybody reaching the port may ask anything.
  // `init` is the way out of that, and the only operator command that is not a client of a running
  // shop: until it has run there is nobody a shop would answer.
  describe('a machine nobody has set up yet', () => {
  });
});
