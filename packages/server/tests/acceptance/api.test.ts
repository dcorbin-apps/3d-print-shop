import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { serve } from '../../src/api';
import { FREELY } from '../../src/attempts';
import { Callers, UnusableCredentials } from '../../src/credentials';
import { digestOf, hashPassword } from '../../src/secrets';
import type { JobDetails } from '../../src/Job';
import { JobStore } from '../../src/JobStore';
import { aDataDirectory, parentOf } from '../aDataDirectory';
import type { DataLayout } from '../../src/dataLayout';

// AIDEV-NOTE: real HTTP against a real listener on an ephemeral port, over a real data directory -
// for what only that can say. A multipart body handed to a fake request would prove only that the
// test can build one, and a cookie's attributes, a drained upload and a 503 are things a client
// reads off the wire.
//
// What does NOT need any of it has gone: the body rules are functions over a value in tests/api.test.ts,
// the permission table is `requireTheirRole` beside them, and where the guard sits is tests/guard.test.ts,
// which drives this same app in-process because an express app is a function of a request. What
// express makes of a raw request line is tests/assumptions/theRequestLine.test.ts.
describe('the shop over HTTP', () => {
  let where: DataLayout;
  let shop: JobStore;
  let server: Server;
  let shopUrl: string;
  let mockChanged: jest.Mock<() => void>;
  let mockStarted: jest.Mock<(name: string) => void>;
  let mockShutDown: jest.Mock<() => void>;
  let mockKeyGiven: jest.Mock<(printer: string, key: string) => Promise<void>>;

  const MK4 = { x: 250, y: 210, z: 220 };
  const MK4_ADDRESS = 'http://octopi.local';
  const playerBox: JobDetails = { filaments: ['PLA-SpaceGray'], displayName: 'Player Box' };

  // Every route names its caller, so every request here carries a token - an admin's unless the
  // test is about what a user may do.
  const ADMIN = 'dave-token';
  const USER = 'slicer-token';
  // AIDEV-NOTE: a token is held as a DIGEST now, so these are built the way the file is read rather
  // than keyed by what a request carries - `presenting()` is what turns the one into the other.
  const CALLERS = new Callers([
    { caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] },
    { caller: { id: 'slicer', name: 'slicer', role: 'user' }, credentials: [{ kind: 'token', hash: digestOf(USER) }] },
  ]);

  function as(token: string | undefined, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${shopUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function submitting(url: string, body: FormData, token: string = ADMIN): Promise<Response> {
    return fetch(`${url}/jobs`, { method: 'POST', body, headers: { authorization: `Bearer ${token}` } });
  }

  async function submit(details: unknown, gcode = 'G1 X100.000 Y100.000\n'): Promise<Response> {
    const body = new FormData();
    body.append('job', JSON.stringify(details));
    body.append('gcode', new Blob([gcode]), 'print.gcode');

    return submitting(shopUrl, body);
  }


  async function ask(path: string): Promise<Response> {
    return as(ADMIN, 'GET', path);
  }


  beforeEach(async () => {
    where = await aDataDirectory('print-shop-api-');
    shop = new JobStore(where);
    await shop.addPrinter({ name: 'mk4', buildVolume: MK4, api: 'octoprint', address: MK4_ADDRESS });

    mockChanged = jest.fn<() => void>();
    mockStarted = jest.fn<(name: string) => void>();
    mockShutDown = jest.fn<() => void>();
    mockKeyGiven = jest.fn<(printer: string, key: string) => Promise<void>>();
    mockKeyGiven.mockResolvedValue(undefined);
    server = await serve(shop, 0, {
      changed: mockChanged,
      started: mockStarted,
      shutDown: mockShutDown,
      keyGiven: mockKeyGiven,
      callers: () => CALLERS,
    });
    shopUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(parentOf(where), { recursive: true, force: true });
  });

  // AIDEV-NOTE: a shop with somewhere to serve a page from. The files are made here rather than
  // taken from the ui package, because what the shop is given is a DIRECTORY - it knows nothing
  // about what is in one, and a test that reached for the real page would be the dependency this
  // deliberately does not have.
  // AIDEV-NOTE: the one submission left over a real socket, and the only test in this repository that
  // needs one. At SIZE, because that is the only way the drain matters: the shop decides against this
  // job before it has read any of it, and a client still writing megabytes has to stay connected long
  // enough to read the answer - so what is left of the upload is drained rather than dropped. Driven
  // in-process there is no "still arriving": the body is pushed whole before the app is ever called,
  // and the test would be asserting against a stream it wrote itself. Every other job route is
  // tests/jobRoutes.test.ts.
  describe('submitting, while the client is still writing', () => {
    it('answers a refusal while the gcode it refused is still arriving', async () => {
      const tooTall = { ...playerBox, requiredBuildVolume: { x: 100, y: 100, z: 400 } };

      const response = await submit(tooTall, 'G1 X100.000 Y100.000\n'.repeat(400_000));

      expect(response.status).toBe(400);
    });
  });

  describe('serving a page beside the API', () => {
    let withAPage: Server;
    let pageUrl: string;
    let page: string;

    const get = (path: string, token?: string): Promise<Response> =>
      fetch(`${pageUrl}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

    beforeEach(async () => {
      page = await mkdtemp(path.join(tmpdir(), 'print-shop-page-'));
      await writeFile(path.join(page, 'index.html'), '<!doctype html><title>the page</title>');
      await mkdir(path.join(page, 'assets'));
      await writeFile(path.join(page, 'assets', 'shop.js'), 'console.log("hello")');

      withAPage = await serve(shop, 0, { callers: () => CALLERS, page });
      pageUrl = `http://127.0.0.1:${(withAPage.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => withAPage.close(() => resolve()));
      await rm(page, { recursive: true, force: true });
    });

    // AIDEV-NOTE: without a credential, and that is the point - the page nobody is logged in to yet
    // is the page they log in ON. Requiring one would be a login screen that cannot be fetched
    // without having logged in.
    it('gives the page to somebody the shop does not know', async () => {
      const response = await get('/');

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('the page');
    });

    it('gives what the page asks for next, equally', async () => {
      const response = await get('/assets/shop.js');

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('hello');
    });

    // A page a browser navigated INTO rather than loaded at the root, then reloaded. Deliberately
    // NOT a path under one of the shop's own routes: those belong to the API whatever a browser
    // thinks, which is the next test.
    it('gives the page for a path inside it, so a reload is not a 404', async () => {
      expect(await (await get('/somewhere/the/page/went')).text()).toContain('the page');
    });

    // AIDEV-NOTE: the thing that would be a hole. Serving files at the root is one mistake away from
    // answering an API path with a page - or worse, from answering one WITHOUT the guard.
    it('does not answer the shop own routes with a page', async () => {
      expect((await get('/jobs')).status).toBe(401);
      expect((await get('/printers')).status).toBe(401);
    });

    it('still answers them properly to somebody it knows', async () => {
      expect((await get('/printers', ADMIN)).status).toBe(200);
    });

    // Nothing is served at all unless the shop was pointed somewhere, which is what a shop with no
    // page installed looks like.
    it('serves nothing of the sort when it was given nowhere to serve from', async () => {
      expect((await ask('/')).status).toBe(404);
    });
  });

  // AIDEV-NOTE: the one route reached before the shop knows who is asking, which is what makes it
  // the one worth being careful about. Over real HTTP, because half of what is being proven is in
  // the headers: what the cookie says, and that a write carrying one has to come from here.
  describe('logging in', () => {
    const PASSWORD = 'a password of some length';
    let withPasswords: Server;
    let loginUrl: string;

    const logIn = (id: string, password: string, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${loginUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ id, password }),
      });

    const cookieFrom = (response: Response): string => (response.headers.get('set-cookie') ?? '').split(';')[0];

    beforeEach(async () => {
      const hash = await hashPassword(PASSWORD);
      const known = new Callers([
        { caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'password', hash }] },
        { caller: { id: 'slicer', name: 'slicer', role: 'user' }, credentials: [{ kind: 'token', hash: digestOf(USER) }] },
      ]);

      withPasswords = await serve(shop, 0, { callers: () => known });
      loginUrl = `http://127.0.0.1:${(withPasswords.address() as AddressInfo).port}`;
    }, 15_000);

    afterEach(async () => {
      await new Promise<void>((resolve) => withPasswords.close(() => resolve()));
    });

    it('answers with the caller, so the page knows what to offer', async () => {
      const response = await logIn('dave', PASSWORD);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    }, 15_000);

    // AIDEV-NOTE: the three that matter, and the reason this is a cookie at all. HttpOnly is what a
    // script on the page cannot read - which a token kept by the page always could. SameSite=Strict
    // is what another site's form cannot make a browser send. Secure is left OFF here because the
    // request arrived over http: a shop on loopback would otherwise set a cookie never sent back.
    it('sets a session a script cannot read and another site cannot send', async () => {
      const said = (await logIn('dave', PASSWORD)).headers.get('set-cookie') ?? '';

      expect(said).toContain('HttpOnly');
      expect(said).toContain('SameSite=Strict');
      expect(said).not.toContain('Secure');
    }, 15_000);

    it('is a session that then names the caller without a token', async () => {
      const cookie = cookieFrom(await logIn('dave', PASSWORD));

      const asked = await fetch(`${loginUrl}/me`, { headers: { cookie } });

      expect(await asked.json()).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    }, 15_000);

    // AIDEV-NOTE: the same answer for a name nobody has and for a password that is wrong. Otherwise
    // the refusals are a list of which names exist, which is the half of a credential an attacker
    // does not have to guess.
    it('says the same thing to a wrong password as to a name it does not know', async () => {
      const wrong = await logIn('dave', 'not the password');
      const nobody = await logIn('nobody at all', 'not the password');

      expect(wrong.status).toBe(nobody.status);
      expect(await wrong.json()).toEqual(await nobody.json());
    }, 20_000);

    it('gives a refused login no session at all', async () => {
      expect((await logIn('dave', 'not the password')).headers.get('set-cookie')).toBeNull();
    }, 15_000);

    // A machine's token is not a password: presenting it here must not be a way in.
    it('refuses a caller who has a token and no password', async () => {
      expect((await logIn('slicer', USER)).status).toBe(401);
    }, 15_000);

    // `loginIn` refuses six shapes in tests/api.test.ts. One here, for what only a running shop can
    // say: that this route - the one reached before the shop knows anybody - puts a body through it.
    it('refuses a body that is not a login', async () => {
      const response = await fetch(`${loginUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'dave' }),
      });

      expect(response.status).toBe(400);
    });

    // AIDEV-NOTE: what stands between a password and somebody working through a list of them.
    it('makes somebody wait after enough wrong ones, and says so', async () => {
      for (let tried = 0; tried <= FREELY; tried += 1) await logIn('dave', 'not the password');

      const turned = await logIn('dave', 'not the password');

      expect(turned.status).toBe(429);
      expect(((await turned.json()) as { error: string }).error).toContain('wait');
    }, 60_000);

    describe('and logging out', () => {
      it('ends the session it was holding', async () => {
        const cookie = cookieFrom(await logIn('dave', PASSWORD));

        const out = await fetch(`${loginUrl}/sessions`, { method: 'DELETE', headers: { cookie, origin: loginUrl } });
        expect(out.status).toBe(204);

        expect((await fetch(`${loginUrl}/me`, { headers: { cookie } })).status).toBe(401);
      }, 15_000);

      it('clears the cookie as well as ending it', async () => {
        const cookie = cookieFrom(await logIn('dave', PASSWORD));

        const out = await fetch(`${loginUrl}/sessions`, { method: 'DELETE', headers: { cookie, origin: loginUrl } });

        expect(out.headers.get('set-cookie')).toContain('print-shop-session=;');
      }, 15_000);
    });

    // AIDEV-NOTE: SameSite is a rule the BROWSER keeps; this is the shop keeping it too. A cookie is
    // sent by whatever page asked, so a WRITE that arrived with one has to have come from here.
    //
    // The rule itself is `requireItCameFromHere`, unit tested over a dozen origins in tests/api.test.ts.
    // What is left here is what only a running shop can say: that the guard hands it the two headers
    // a request really arrived with, that the host half is compared rather than assumed, and that a
    // token is subject to none of it.
    describe('a write carrying a session', () => {
      it('is taken when it came from this shop', async () => {
        const cookie = cookieFrom(await logIn('dave', PASSWORD));

        const response = await fetch(`${loginUrl}/printers/mk4/filament`, {
          method: 'PUT',
          headers: { cookie, origin: loginUrl, 'content-type': 'application/json' },
          body: JSON.stringify({ loaded: ['PLA-Red'] }),
        });

        expect(response.status).toBe(200);
      }, 15_000);

      it('is refused when it came from somewhere else', async () => {
        const cookie = cookieFrom(await logIn('dave', PASSWORD));

        const response = await fetch(`${loginUrl}/printers/mk4/filament`, {
          method: 'PUT',
          headers: { cookie, origin: 'http://somewhere.else', 'content-type': 'application/json' },
          body: JSON.stringify({ loaded: ['PLA-Red'] }),
        });

        expect(response.status).toBe(403);
      }, 15_000);

      // A token is not sent by a browser on anybody's behalf, so none of this applies to one.
      it('is nothing a token has to answer for', async () => {
        const response = await as(USER, 'GET', '/jobs');

        expect(response.status).toBe(200);
      });
    });

    // AIDEV-NOTE: their OWN, which is the whole of what this route is - an operator changing somebody
    // else's is `caller password` at a terminal. The password they have now is asked for even though
    // the shop already knows who is asking, because a session is a screen somebody walked away from.
    describe('and changing your own password', () => {
      const NEW_PASSWORD = 'a different password entirely';
      const A_USERS_TOKEN = 'ada-token';
      let changing: Server;
      let changeUrl: string;
      let known: Callers;
      let mockKept: jest.Mock<(id: string, password: string) => Promise<void>>;

      const naming = async (...held: { id: string; password?: string; token?: string; role?: 'admin' | 'user' }[]): Promise<Callers> =>
        new Callers(
          await Promise.all(
            held.map(async ({ id, password, token, role = 'admin' }) => ({
              caller: { id, name: id, role },
              credentials: [
                ...(password === undefined ? [] : [{ kind: 'password' as const, hash: await hashPassword(password) }]),
                ...(token === undefined ? [] : [{ kind: 'token' as const, hash: digestOf(token) }]),
              ],
            })),
          ),
        );

      const changeTo = (
        password: string,
        current: string,
        headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` },
      ): Promise<Response> =>
        fetch(`${changeUrl}/me/password`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ current, password }),
        });

      const logInThere = (id: string, password: string): Promise<Response> =>
        fetch(`${changeUrl}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, password }),
        });

      beforeEach(async () => {
        // A user among them, because this route is one of the few open to every caller - their own
        // password is the one thing a user may change, and a shop that made it an admin's would be
        // back to nobody being able to change their own.
        const everybody = (changed?: { id: string; password: string }): Promise<Callers> => {
          const passwordOf = (id: string): string => (changed?.id === id ? changed.password : PASSWORD);

          return naming(
            { id: 'dave', password: passwordOf('dave'), token: ADMIN },
            { id: 'slicer', token: USER },
            { id: 'ada', password: passwordOf('ada'), token: A_USERS_TOKEN, role: 'user' },
          );
        };

        known = await everybody();

        // What the shop itself does with one: writes it where the callers are kept, and reads the
        // file back so that what is in force is what it now says - for the caller it was given and
        // nobody else.
        mockKept = jest.fn<(id: string, password: string) => Promise<void>>(async (id, password) => {
          known = await everybody({ id, password });
        });

        changing = await serve(shop, 0, { callers: () => known, passwordChanged: mockKept });
        changeUrl = `http://127.0.0.1:${(changing.address() as AddressInfo).port}`;
      }, 30_000);

      afterEach(async () => {
        await new Promise<void>((resolve) => changing.close(() => resolve()));
      });

      it('is what logs them in afterwards', async () => {
        expect((await changeTo(NEW_PASSWORD, PASSWORD)).status).toBe(204);

        expect((await logInThere('dave', NEW_PASSWORD)).status).toBe(201);
        expect((await logInThere('dave', PASSWORD)).status).toBe(401);
      }, 60_000);

      it('is refused, and nothing written, when the one they have now is wrong', async () => {
        const response = await changeTo(NEW_PASSWORD, 'not the password');

        expect(response.status).toBe(403);
        expect(mockKept).not.toHaveBeenCalled();
      }, 30_000);

      // The id is whoever the request turned out to be. There is no shape of body that changes
      // somebody else's - which is what keeps this open to every caller.
      it('changes the caller who asked, whoever the body names', async () => {
        await fetch(`${changeUrl}/me/password`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
          body: JSON.stringify({ id: 'slicer', current: PASSWORD, password: NEW_PASSWORD }),
        });

        expect(mockKept).toHaveBeenCalledWith('dave', NEW_PASSWORD);
      }, 30_000);

      // A caller with no password is a machine's token, and there is nothing here for it to prove.
      // Giving one their first password is an operator's act, like taking one away.
      it('refuses a caller who has a token and no password', async () => {
        const response = await changeTo(NEW_PASSWORD, PASSWORD, { authorization: `Bearer ${USER}` });

        expect(response.status).toBe(403);
        expect(mockKept).not.toHaveBeenCalled();
      }, 30_000);

      it('refuses the one they are already using', async () => {
        const response = await changeTo(PASSWORD, PASSWORD);

        expect(response.status).toBe(400);
        expect(mockKept).not.toHaveBeenCalled();
      }, 30_000);

      // `passwordChangeIn` refuses six shapes in tests/api.test.ts; one here for the wiring.
      it('refuses a body that is not a change', async () => {
        const response = await fetch(`${changeUrl}/me/password`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
          body: JSON.stringify({ current: PASSWORD }),
        });

        expect(response.status).toBe(400);
      }, 30_000);

      // AIDEV-NOTE: what a new password is FOR - somebody either forgot theirs or believes somebody
      // else has it. The browser doing the changing is kept, because asking somebody to log in again
      // for having just proved who they are is a page that punishes the safe thing.
      it('logs out every other browser, and leaves the one that asked logged in', async () => {
        const elsewhere = ((await logInThere('dave', PASSWORD)).headers.get('set-cookie') ?? '').split(';')[0];
        const here = ((await logInThere('dave', PASSWORD)).headers.get('set-cookie') ?? '').split(';')[0];

        await changeTo(NEW_PASSWORD, PASSWORD, { cookie: here, origin: changeUrl });

        expect((await fetch(`${changeUrl}/me`, { headers: { cookie: elsewhere } })).status).toBe(401);
        expect((await fetch(`${changeUrl}/me`, { headers: { cookie: here } })).status).toBe(200);
      }, 60_000);

      // The same oracle as a login - something that says whether a guess was right - so it is
      // counted the same way.
      it('makes somebody wait after enough wrong ones', async () => {
        for (let tried = 0; tried <= FREELY; tried += 1) await changeTo(NEW_PASSWORD, 'not the password');

        expect((await changeTo(NEW_PASSWORD, 'not the password')).status).toBe(429);
      }, 60_000);

      // AIDEV-NOTE: a user's own password is the whole point of this route. Made an admin's, it
      // would be back to nobody being able to change their own - which is what it is here to fix.
      it("is a user's to change as much as an admin's", async () => {
        const response = await changeTo(NEW_PASSWORD, PASSWORD, { authorization: `Bearer ${A_USERS_TOKEN}` });

        expect(response.status).toBe(204);
        expect(mockKept).toHaveBeenCalledWith('ada', NEW_PASSWORD);
      }, 30_000);

      // AIDEV-NOTE: the rule about a password is `setPassword`'s and is deliberately written down
      // nowhere else - the page keeps no copy on purpose, "that rule is the shop's, it says so in its
      // own words". Which it could not: `UnusableCredentials` had no row in `statusFor`, so this was
      // a 500 and "why is in its log", and the one rule there is was never said to anybody.
      it('says what is wrong with a password it will not take', async () => {
        const why = 'a password is at least 12 characters, which is the only rule there is';
        mockKept.mockRejectedValue(new UnusableCredentials(why));

        const response = await changeTo('too short', PASSWORD);

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: why });
      }, 30_000);

      it('is refused by a shop that was given nowhere to keep one', async () => {
        const nowhere = await serve(shop, 0, { callers: () => known });
        const nowhereUrl = `http://127.0.0.1:${(nowhere.address() as AddressInfo).port}`;

        const response = await fetch(`${nowhereUrl}/me/password`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
          body: JSON.stringify({ current: PASSWORD, password: NEW_PASSWORD }),
        });

        expect(response.status).toBe(400);
        await new Promise<void>((resolve) => nowhere.close(() => resolve()));
      }, 30_000);
    });
  });

  // AIDEV-NOTE: a client that shows a person what they may do has to be able to ask what that is.
  // The one route that answers with a name, and it is the name of whoever asked.
  describe('who the shop takes the caller to be', () => {
    it('says the caller back to them, by the token they presented', async () => {
      expect(await (await as(ADMIN, 'GET', '/me')).json()).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    });

    // The role is the whole point: it is what a UI offers or withholds a printer command by.
    it('says a user is a user', async () => {
      expect(await (await as(USER, 'GET', '/me')).json()).toEqual({ id: 'slicer', name: 'slicer', role: 'user' });
    });

    // It answers about the TOKEN, and a shop that cannot name one answers nothing at all.
    it('tells a caller it cannot name nothing', async () => {
      expect((await as('made-up', 'GET', '/me')).status).toBe(401);
    });

    // Whatever else a token buys, it does not buy the list of who else is here.
    it('says nothing about anybody else', async () => {
      expect(Object.keys((await (await as(ADMIN, 'GET', '/me')).json()) as object)).toEqual(['id', 'name', 'role']);
    });
  });

  // AIDEV-NOTE: the permission table is the security boundary, and it IS asserted route by route -
  // against `requireTheirRole` in tests/api.test.ts, where the answer says which rule refused and in
  // what words rather than being read back as a status code. That the guard asks it, is handed the
  // path rather than the url, and sits above every route that holds work, is tests/guard.test.ts.
  //
  // What is left here is the credential half: a token on the wire, and that a shop which cannot name
  // a caller says the same thing whichever way it failed to.
  describe('who is asking', () => {
    it('refuses a caller carrying no token at all', async () => {
      const response = await as(undefined, 'GET', '/jobs');

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'this shop does not know that token' });
    });

    it('refuses a token it does not know', async () => {
      expect((await as('made-up', 'GET', '/jobs')).status).toBe(401);
    });

    // The same answer either way, so a caller cannot learn which tokens exist by watching for a
    // different refusal.
    it('says the same thing to a bad token as to none', async () => {
      const missing = await as(undefined, 'GET', '/jobs');
      const wrong = await as('made-up', 'GET', '/jobs');

      expect(await wrong.json()).toEqual(await missing.json());
    });

    it('lets a user submit a job', async () => {
      const body = new FormData();
      body.append('job', JSON.stringify(playerBox));
      body.append('gcode', new Blob(['G1\n']), 'print.gcode');

      const response = await submitting(shopUrl, body, USER);

      expect(response.status).toBe(201);
    });
  });

});
