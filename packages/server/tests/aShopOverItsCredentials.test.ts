import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createApi } from '../src/api';
import { CALLERS_FILE, callersIn, setPassword, writeFirstCaller } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { keepingTheirPassword } from '../src/running';
import { rereadEverything } from '../src/signals';
import { Sessions } from '../src/sessions';
import { silent, toStdout } from '../src/log';
import { aDataDirectory, parentOf } from './aDataDirectory';
import { drive } from './inProcess';
import type { Callers } from '../src/credentials';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: a person logging in to the real thing - the file the operator's own command writes,
// read by a shop the way a shop reads one. Everything about passwords is unit tested elsewhere:
// `hashPassword` and `isThePassword` in secrets, `Callers` in credentials, the routes in
// sessionRoutes. What is here is the JOIN, which each of those is blind to - and which used to take
// two spawned processes and a socket to ask.
describe('a shop over the credentials an operator wrote', () => {
  let etc: string;
  let where: DataLayout;
  let known: Callers;
  let said: string[];
  let asked: ReturnType<typeof drive>;
  let sessions: Sessions;

  const PASSWORD = 'a password of some length';
  const CHANGED = 'a different password entirely';

  const logIn = (id: string, password: string): ReturnType<typeof asked> => asked('POST', '/sessions', { json: { id, password } });

  beforeEach(async () => {
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-credentials-'));
    await chmod(etc, 0o700);
    where = await aDataDirectory('print-shop-credentials-data-');
    said = [];
    sessions = new Sessions();

    // What `init` writes, by the function it writes it with.
    await writeFirstCaller(etc, 'dave', 'dave', PASSWORD);
    known = await callersIn(etc);

    asked = drive(
      createApi(new JobStore(where), {
        callers: () => known,
        sessions,
        passwordChanged: async (id, password) => {
          known = await keepingTheirPassword(etc)(id, password);
        },
        log: toStdout(
          () => new Date(),
          (line) => said.push(line)
        ),
      })
    );
  }, 60_000);

  afterEach(async () => {
    await rm(etc, { recursive: true, force: true });
    await rm(parentOf(where), { recursive: true, force: true });
  });

  it('lets somebody in by the password the operator set, and names them by the session after it', async () => {
    const answer = await logIn('dave', PASSWORD);
    expect(answer.status).toBe(201);

    expect((await asked('GET', '/me', { headers: { cookie: answer.cookie() } })).body).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
  }, 60_000);

  it('refuses the wrong one', async () => {
    expect((await logIn('dave', 'not the password')).status).toBe(401);
  }, 60_000);

  // AIDEV-NOTE: the file holds a HASH, so this is the check that the shop is not simply comparing
  // what it was given against what is written down - which would be a file of passwords.
  it('is not let in by presenting what the file holds', async () => {
    const written = JSON.parse(await readFile(path.join(etc, CALLERS_FILE), 'utf-8')) as {
      credentials: { kind: string; hash: string }[];
    }[];
    const hash = written[0].credentials.find(({ kind }) => kind === 'password')?.hash ?? '';

    expect(hash).toContain('scrypt$');
    expect((await logIn('dave', hash)).status).toBe(401);
  }, 60_000);

  // The shop's log is what a supervisor captures and what somebody reads days later. A password in
  // it would outlive the request that carried one.
  it('says nothing of the password in its log, whatever it was asked', async () => {
    await logIn('dave', PASSWORD);
    await logIn('dave', 'not the password');

    expect(said.join('\n')).toContain('somebody logged in');
    expect(said.join('\n')).not.toContain(PASSWORD);
  }, 60_000);

  describe('when somebody changes their own password', () => {
    const changing = async (): Promise<number> => {
      const cookie = (await logIn('dave', PASSWORD)).cookie();

      const answer = await asked('PUT', '/me/password', {
        headers: { cookie, origin: 'http://shop.local' },
        json: { current: PASSWORD, password: CHANGED },
      });

      return answer.status;
    };

    it('is the new one that lets them back in, and not the old', async () => {
      expect(await changing()).toBe(204);

      expect((await logIn('dave', CHANGED)).status).toBe(201);
      expect((await logIn('dave', PASSWORD)).status).toBe(401);
    }, 60_000);

    // AIDEV-NOTE: written where the operator's OWN command would have written it, so `caller list`
    // and a restart agree with the shop that is running - and so nobody is locked out by an update.
    it('writes it where the credentials are kept', async () => {
      const before = await readFile(path.join(etc, CALLERS_FILE), 'utf-8');

      await changing();

      expect(await readFile(path.join(etc, CALLERS_FILE), 'utf-8')).not.toBe(before);
    }, 60_000);

    // AIDEV-NOTE: `caller password` says every browser logged in as them is logged out once the shop
    // has re-read the file, and this is that sentence being true over the routes. Who a re-read logs
    // out is signals.test.ts; that a session then names nobody is the half only a shop can say.
    it('logs out the browsers they were logged in on, once the shop has re-read the file', async () => {
      const cookie = (await logIn('dave', PASSWORD)).cookie();
      expect((await asked('GET', '/me', { headers: { cookie } })).status).toBe(200);

      await setPassword(etc, 'dave', CHANGED);
      await rereadEverything(etc, { callers: known, printerKeys: new Map() }, sessions, silent).then((held) => {
        known = held.callers;
      });

      expect((await asked('GET', '/me', { headers: { cookie } })).status).toBe(401);
    }, 60_000);

    // Read back rather than patched in memory: what is in force has to be what the FILE says, which
    // is what a re-read or a restart would find.
    it('is in force from the file rather than from memory', async () => {
      await changing();

      expect((await callersIn(etc)).named('dave')?.password).toBeDefined();
      expect(known.named('dave')?.password).toBe((await callersIn(etc)).named('dave')?.password);
    }, 60_000);
  });
});
