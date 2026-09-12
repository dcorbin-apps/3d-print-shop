import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { digestOf } from '../../src/secrets';
import { SESSIONS_FILE } from '../../src/sessions';
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

  async function submitPlayerBox(shop: RunningShop): Promise<Response> {
    return submitGcode(shop, GCODE);
  }

  async function submitClaimedBy(shop: RunningShop, printer: string): Promise<Response> {
    const body = new FormData();
    body.append('job', JSON.stringify({ filaments: ['PLA-SpaceGray'], displayName: 'Player Box', printer }));
    body.append('gcode', new Blob([GCODE]), 'print.gcode');

    return fetch(`${shop.url}/jobs`, { method: 'POST', body, headers: asAdmin });
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

  async function writePrinterKeys(credentials: string, keys: Record<string, string>): Promise<void> {
    await writeFile(path.join(credentials, 'printer-keys.json'), JSON.stringify(keys), { mode: 0o600 });
  }

  async function submitGcode(shop: RunningShop, gcode: string): Promise<Response> {
    const body = new FormData();
    body.append('job', JSON.stringify({ filaments: ['PLA-SpaceGray'], displayName: 'Player Box' }));
    body.append('gcode', new Blob([gcode]), 'print.gcode');

    return fetch(`${shop.url}/jobs`, { method: 'POST', body, headers: asAdmin });
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

  it('keeps what it is given in the data directory it was pointed at', async () => {
    const shop = await shopIsRunning();
    await addMk4(shop);

    expect((await submitPlayerBox(shop)).status).toBe(201);
    expect(await readFile(path.join(where.jobs, '1', 'print.gcode'), 'utf-8')).toBe(GCODE);
  }, 30_000);

  // The operator's commands are a CLIENT of the running shop rather than a second writer over its
  // files - so this goes the whole way through: argv, the API, the store, and back out of a GET.
  it('takes a printer the operator adds through the running shop', async () => {
    const shop = await shopIsRunning();
    expect(await (await ask(shop, '/printers')).json()).toEqual([]);

    expect(await runCommand(['printer', '--shop-url', shop.url, 'add', 'mk4', '250x210x220', 'http://mk4'])).toBe(0);

    expect(await (await ask(shop, '/printers')).json()).toEqual([
      { name: 'mk4', buildVolume: MK4, api: 'octoprint', address: 'http://mk4', camera: 'http://mk4/webcam/?action=stream', loaded: [] },
    ]);
  }, 30_000);

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

    async function shopSomebodyCanLogInTo(): Promise<RunningShop> {
      return startShopOver(dataRoot, [], await aMachineSomebodyCanLogInTo());
    }

    const logIn = (shop: RunningShop, id: string, password: string): Promise<Response> =>
      fetch(`${shop.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, password }),
      });

    const cookieFor = async (shop: RunningShop): Promise<string> =>
      ((await logIn(shop, 'dave', PASSWORD)).headers.get('set-cookie') ?? '').split(';')[0];

    it('is let in by the password the operator set, and named by the session after it', async () => {
      const shop = await shopSomebodyCanLogInTo();

      const said = await logIn(shop, 'dave', PASSWORD);
      expect(said.status).toBe(201);

      const cookie = (said.headers.get('set-cookie') ?? '').split(';')[0];
      const asked = await fetch(`${shop.url}/me`, { headers: { cookie } });

      expect(await asked.json()).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    }, 60_000);

    it('is refused by the wrong one', async () => {
      const shop = await shopSomebodyCanLogInTo();

      expect((await logIn(shop, 'dave', 'not the password')).status).toBe(401);
    }, 60_000);

    // AIDEV-NOTE: the file holds a hash, so this is the check that the shop is not simply comparing
    // what it was given against what is written down - which would be a file of passwords.
    it('is not let in by presenting what the file holds', async () => {
      const shop = await shopSomebodyCanLogInTo();
      const credentials = madeEtc[madeEtc.length - 1];
      const written = JSON.parse(await readFile(path.join(credentials, 'callers.json'), 'utf-8')) as {
        credentials: { kind: string; hash: string }[];
      }[];
      const hash = written[0].credentials.find(({ kind }) => kind === 'password')?.hash ?? '';

      expect(hash).toContain('scrypt$');
      expect((await logIn(shop, 'dave', hash)).status).toBe(401);
    }, 60_000);

    // AIDEV-NOTE: the point of keeping them in a file at all, and provable only here: a process
    // stopped and a DIFFERENT one started over the same directories, with the browser presenting
    // what it was holding before.
    it('is still logged in after the shop has been stopped and started again', async () => {
      const credentials = await aMachineSomebodyCanLogInTo();
      const before = await startShopOver(dataRoot, [], credentials);

      const cookie = await cookieFor(before);
      await before.stop();
      await before.stopped;

      const after = await startShopOver(dataRoot, [], credentials);

      expect((await fetch(`${after.url}/me`, { headers: { cookie } })).status).toBe(200);
    }, 60_000);

    // AIDEV-NOTE: with the state, because the jobs directory is one directory per job and the store
    // reads every name in it. A file of its own there is something the shop would have to know not to
    // read, for ever.
    it('keeps who is logged in with its state, not among the jobs', async () => {
      const shop = await startShopOver(dataRoot, [], await aMachineSomebodyCanLogInTo());
      await cookieFor(shop);

      // A login does not wait for the disk, so the file is a moment behind the answer to it.
      const appeared = async (file: string): Promise<boolean> => {
        for (let asked = 0; asked < 200; asked += 1) {
          if ((await stat(file).catch(() => undefined)) !== undefined) return true;
          await new Promise((on) => setTimeout(on, 25));
        }

        return false;
      };

      expect(await appeared(path.join(where.state, SESSIONS_FILE))).toBe(true);
      await expect(stat(path.join(where.jobs, SESSIONS_FILE))).rejects.toThrow();
    }, 60_000);

    // The other half: logging out is not undone by a restart either.
    it('is not logged in again by a restart after logging out', async () => {
      const credentials = await aMachineSomebodyCanLogInTo();
      const before = await startShopOver(dataRoot, [], credentials);

      const cookie = await cookieFor(before);
      await fetch(`${before.url}/sessions`, { method: 'DELETE', headers: { cookie, origin: before.url } });
      await before.stop();
      await before.stopped;

      const after = await startShopOver(dataRoot, [], credentials);

      expect((await fetch(`${after.url}/me`, { headers: { cookie } })).status).toBe(401);
    }, 60_000);

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

    // AIDEV-NOTE: the whole of item "nobody can change their own password", end to end: the shop
    // WRITES the file and puts it in force in one act, with no signal and no restart - so what is
    // proved here is that the route, the file and what this process is holding are the same thing.
    it('changes its own password, and the new one is what lets them back in', async () => {
      const credentials = await aMachineSomebodyCanLogInTo();
      const shop = await startShopOver(dataRoot, [], credentials);
      const changed = 'a different password entirely';

      const said = await fetch(`${shop.url}/me/password`, {
        method: 'PUT',
        headers: { cookie: await cookieFor(shop), origin: shop.url, 'content-type': 'application/json' },
        body: JSON.stringify({ current: PASSWORD, password: changed }),
      });

      expect(said.status).toBe(204);
      expect((await logIn(shop, 'dave', changed)).status).toBe(201);
      expect((await logIn(shop, 'dave', PASSWORD)).status).toBe(401);
    }, 60_000);

    // Written where the operator's own command would have written it, so `caller list` and a restart
    // agree with the shop that is running - and so the person cannot be locked out by an update.
    it('writes the new password where the credentials are kept', async () => {
      const credentials = await aMachineSomebodyCanLogInTo();
      const shop = await startShopOver(dataRoot, [], credentials);
      const before = await readFile(path.join(credentials, 'callers.json'), 'utf-8');

      await fetch(`${shop.url}/me/password`, {
        method: 'PUT',
        headers: { cookie: await cookieFor(shop), origin: shop.url, 'content-type': 'application/json' },
        body: JSON.stringify({ current: PASSWORD, password: 'a different password entirely' }),
      });

      expect(await readFile(path.join(credentials, 'callers.json'), 'utf-8')).not.toBe(before);
    }, 60_000);

    it('says nothing of the password in its log, whatever it was asked', async () => {
      const shop = await shopSomebodyCanLogInTo();
      await logIn(shop, 'dave', PASSWORD);

      await shop.saysSomethingLike(/somebody logged in/);

      expect(shop.hasSaid(new RegExp(PASSWORD))).toBe(false);
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

  // AIDEV-NOTE: a key is a secret, and the log is built from every one this process holds - so one
  // that arrived while it was running has to reach the redactor too.
  it('never writes a key it was given into its log', async () => {
    const credentials = await credentialsNaming([{ id: 'dave', name: 'dave', role: 'admin', token: ADMIN }]);
    const shop = await startShopOver(dataRoot, [], credentials);

    await fetch(`${shop.url}/printers`, {
      method: 'POST',
      headers: { ...asAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mk4', buildVolume: MK4, address: 'http://mk4', key: 'a-key-from-a-browser' }),
    });
    await shop.saysSomethingLike(/a printer was given its key/);

    // A line the shop writes with the key inside it, which is what a leak actually looks like: a
    // reason, a failure, a header quoted back. The redactor is the only thing standing in the way.
    await fetch(`${shop.url}/printers/mk4/status`, {
      method: 'PUT',
      headers: { ...asAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ stopped: true, reason: 'the key is a-key-from-a-browser' }),
    });

    await shop.saysSomethingLike(/printer stopped/);
    expect(shop.hasSaid(/a-key-from-a-browser/)).toBe(false);
    expect(shop.hasSaid(/\[redacted]/)).toBe(true);
  }, 30_000);

  // AIDEV-NOTE: the whole way through - argv, the API, the foreman letting go of its machines, and a
  // process that actually ends. A shop that answered and stayed up would look identical to a client.
  // The data directory is made when the shop is installed and never by the shop, so a missing one is a
  // machine that was never set up - and it is worth finding out before anything is served.
  it('will not start over a data directory that is not there', async () => {
    await expect(startShopOver(path.join(dataRoot, 'never-made'))).rejects.toThrow('is not there');
  }, 30_000);

  // The other half of the same question: a data directory that IS there, and that anybody could rename a job
  // directory out of. The shop sets 0700 on everything below it, and none of that survives this.
  it('will not start over a data directory somebody else could write', async () => {
    await chmod(where.jobs, 0o777);

    await expect(startShop()).rejects.toThrow('may not be writable');
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

  // The other half of `job list`, and the one an operator asks standing at the machine.
  it('tells the operator what to load next', async () => {
    const shop = await shopIsRunning();
    await addMk4(shop);
    await submitPlayerBox(shop);

    const { stdout } = await runCommandSaying(['job', '--shop-url', shop.url, 'waiting']);

    expect(stdout.trim()).toBe('PLA-SpaceGray  1 job waiting');
  }, 30_000);

  // Naming a machine has to survive argv, the client and the query string; the shop's own suite
  // proves what the answer should be, and this proves the name gets there at all - which is why the
  // only job here is one the named machine could not take. An answer for the whole shop would count
  // it.
  it('tells the operator what to load at the machine they name', async () => {
    const shop = await shopIsRunning();
    await addMk4(shop);
    await addPrinter(shop, { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 }, address: 'http://mini.local' });
    await submitClaimedBy(shop, 'mk4');

    const { stdout } = await runCommandSaying(['job', '--shop-url', shop.url, 'waiting', 'mini']);

    expect(stdout.trim()).toBe('nothing queued that mini could take');
  }, 30_000);

  // AIDEV-NOTE: two shops over one data directory would both read `next-id` as 7 and both hand out 7, the
  // second overwriting the first job's gcode with no error anywhere. A second `serve` on the same
  // PORT already fails to listen; this is the case only the directory's own claim catches.
  it('will not serve a data directory another shop already has', async () => {
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

    expect(await (await ask(again, '/jobs')).json()).toMatchObject({ accessibleJobs: [{ id: 1, displayName: 'Player Box', state: 'queued' }] });
  }, 30_000);

  // The cap belongs to the operator: a slicer that outgrows the default has to be able to say so,
  // and the shop keeps that much room spare in the data directory for every job it accepts.
  it('takes gcode up to the size --max-gcode names, and no more', async () => {
    const shop = await startShopOver(dataRoot, ['--max-gcode', '1']);
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
  describe('told to re-read its credentials', () => {
    const DAVE = { id: 'dave', name: 'dave', role: 'admin', token: ADMIN };
    const SLICER = { id: 'slicer', name: 'slicer', role: 'user', token: USER };

    it('answers a caller added while it was running', async () => {
      const credentials = await credentialsNaming([DAVE]);
      const shop = await startShopOver(dataRoot, [], credentials);
      expect((await askCarrying(shop, USER)).status).toBe(401);

      await writeCallers(credentials, [DAVE, SLICER]);
      shop.reload();
      await shop.saysSomethingLike(/callers re-read/);

      expect((await askCarrying(shop, USER)).status).toBe(200);
    }, 30_000);

    it('refuses a caller taken out while it was running', async () => {
      const credentials = await credentialsNaming([DAVE, SLICER]);
      const shop = await startShopOver(dataRoot, [], credentials);
      expect((await askCarrying(shop, USER)).status).toBe(200);

      await writeCallers(credentials, [DAVE]);
      shop.reload();
      await shop.saysSomethingLike(/callers re-read/);

      expect((await askCarrying(shop, USER)).status).toBe(401);
    }, 30_000);

    // Reading a mistyped file as "nobody may call this shop" would revoke every caller at once, the
    // operator who has to fix it among them - and node ends a process that ignores SIGHUP, so a shop
    // that answers this at all is a shop that stayed up to answer it.
    it('keeps the callers it has when what it is told to re-read is unusable', async () => {
      const credentials = await credentialsNaming([DAVE]);
      const shop = await startShopOver(dataRoot, [], credentials);

      await writeFile(path.join(credentials, 'callers.json'), '{ not json', { mode: 0o600 });
      shop.reload();
      await shop.saysSomethingLike(/could not re-read the callers/);

      expect((await askCarrying(shop, ADMIN)).status).toBe(200);
    }, 30_000);

    // The other file in the same directory, and the reason a wrong key no longer costs a restart -
    // which cost the operator twice, because a stop outlives one. Waiting on the line IS the claim:
    // nothing says it until the signal has landed and the file has been read again.
    it('re-reads the printer keys as well as the callers', async () => {
      const credentials = await credentialsNaming([DAVE]);
      await writePrinterKeys(credentials, { mk4: 'was-wrong' });
      const shop = await startShopOver(dataRoot, [], credentials);

      await writePrinterKeys(credentials, { mk4: 'is-right' });
      shop.reload();

      await shop.saysSomethingLike(/printer keys re-read .*printers=1/);
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
    it('will not start when no callers are named', async () => {
      await expect(startShopOver(dataRoot, [], path.join(dataRoot, 'no-credentials-here'))).rejects.toThrow('every route names its caller');
    }, 30_000);

    // What proves `init` worked is not the file it wrote but a shop started over it answering the
    // token it printed. The mode, the shape and the token are each something a file can get wrong
    // while still looking right, and each of them is a shop that will not start or will not answer.
    it('is set up by init, and then answers the token init printed', async () => {
      const machine = await mkdtemp(path.join(tmpdir(), 'print-shop-fresh-'));
      madeEtc.push(machine);
      const fresh = path.join(machine, 'etc');

      const { stdout } = await runCommandSaying(['init', 'dave', '--etc', fresh], {}, `${A_PASSWORD}\n${A_PASSWORD}\n`);
      const token = /\b[0-9a-f]{64}\b/.exec(stdout)?.[0];

      const shop = await startShopOver(dataRoot, [], fresh);

      expect(token).toBeDefined();
      expect((await fetch(`${shop.url}/jobs`, { headers: { authorization: `Bearer ${token as string}` } })).status).toBe(200);
    }, 60_000);

    // The other half of what init writes, and the half a person uses.
    it('is set up by init with a password that then logs somebody in', async () => {
      const machine = await mkdtemp(path.join(tmpdir(), 'print-shop-fresh-'));
      madeEtc.push(machine);
      const fresh = path.join(machine, 'etc');

      await runCommandSaying(['init', 'dave', '--etc', fresh], {}, `${A_PASSWORD}\n${A_PASSWORD}\n`);
      const shop = await startShopOver(dataRoot, [], fresh);

      const said = await fetch(`${shop.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'dave', password: A_PASSWORD }),
      });

      expect(said.status).toBe(201);
    }, 60_000);

    // Typed twice because nobody can see what they typed the first time, and a machine set up with
    // a password nobody knows is a machine nobody can log in to.
    it('is not set up at all when the two passwords do not match', async () => {
      const machine = await mkdtemp(path.join(tmpdir(), 'print-shop-fresh-'));
      madeEtc.push(machine);
      const fresh = path.join(machine, 'etc');

      const { code } = await runCommandSaying(['init', 'dave', '--etc', fresh], {}, `${A_PASSWORD}\nsomething else\n`);

      expect(code).toBe(1);
      await expect(readFile(path.join(fresh, 'callers.json'), 'utf-8')).rejects.toThrow();
    }, 60_000);
  });
});
