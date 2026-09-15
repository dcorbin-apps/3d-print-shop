import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { rm } from 'node:fs/promises';
import { createApi } from '../src/api';
import { FREELY } from '../src/attempts';
import { Callers, UnusableCredentials } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { digestOf, hashPassword } from '../src/secrets';
import { SESSION_COOKIE } from '../src/sessions';
import { aDataDirectory, parentOf } from './aDataDirectory';
import { HERE, drive } from './inProcess';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: the routes a browser reaches - logging in, logging out, and changing the password you
// have. `Callers`, `Sessions` and `Attempts` each answer for themselves in their own suites; what is
// here is what the ROUTES do with them, including the headers, because a Set-Cookie's attributes are
// the whole reason a session is a cookie rather than something the page keeps.
//
// The app answers in-process, so the real cookie serialiser and the real guard run. The one thing
// that needs a listener is nowhere near here.
describe('the sessions, over the shop routes', () => {
  let where: DataLayout;
  let shop: JobStore;

  const PASSWORD = 'a password of some length';
  const NEW_PASSWORD = 'a different password entirely';
  const ADMIN = 'dave-token';
  const USER = 'slicer-token';
  const A_USERS_TOKEN = 'ada-token';

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

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-sessions-');
    shop = new JobStore(where);
    await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://octopi.local' });
  });

  afterEach(async () => {
    await rm(parentOf(where), { recursive: true, force: true });
  });

  describe('logging in', () => {
    let asked: ReturnType<typeof drive>;

    const logIn = (id: string, password: string): ReturnType<typeof asked> =>
      asked('POST', '/sessions', { json: { id, password }, headers: { origin: HERE } });

    beforeEach(async () => {
      const known = await naming({ id: 'dave', password: PASSWORD }, { id: 'slicer', token: USER, role: 'user' });
      asked = drive(createApi(shop, { callers: () => known }));
    }, 15_000);

    it('answers with the caller, so the page knows what to offer', async () => {
      const answer = await logIn('dave', PASSWORD);

      expect(answer.status).toBe(201);
      expect(answer.body).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    }, 15_000);

    // AIDEV-NOTE: the three that matter, and the reason this is a cookie at all. HttpOnly is what a
    // script on the page cannot read - which a token kept by the page always could. SameSite=Strict
    // is what another site's form cannot make a browser send. Secure is left OFF because the request
    // did not arrive over TLS: a shop on loopback would otherwise set a cookie never sent back.
    it('sets a session a script cannot read and another site cannot send', async () => {
      const said = (await logIn('dave', PASSWORD)).header('set-cookie') ?? '';

      expect(said).toContain('HttpOnly');
      expect(said).toContain('SameSite=Strict');
      expect(said).not.toContain('Secure');
    }, 15_000);

    // AIDEV-NOTE: the companion to the cookie's SameSite above, and the reason one does not cover the
    // other. SameSite stops another site SENDING this cookie; it says nothing about a Set-Cookie
    // being STORED, so without this a page elsewhere could post a login of its own choosing and
    // leave a browser holding a session belonging to whoever it picked - and then read back what was
    // submitted through it. The login is the one route the guard never sees, so the rule cannot be
    // left to the guard.
    //
    // `requireItCameFromHere` answers for its own branches in tests/api.test.ts. What is asked here
    // is the WIRING: that this route asks it, and asks it with the two headers rather than with two
    // of something else - which is why an origin from elsewhere is asked for as well as none at all.
    it('refuses a login that will not say where it came from', async () => {
      const refused = await asked('POST', '/sessions', { json: { id: 'dave', password: PASSWORD } });

      expect(refused.status).toBe(403);
      expect(refused.header('set-cookie')).toBeUndefined();
    });

    it('refuses a login another site asked for, however right the password is', async () => {
      const elsewhere = { json: { id: 'dave', password: PASSWORD }, headers: { origin: 'http://elsewhere.example' } };
      const refused = await asked('POST', '/sessions', elsewhere);

      expect(refused.status).toBe(403);
      expect(refused.header('set-cookie')).toBeUndefined();
    });

    // AIDEV-NOTE: the ORDER, which is the half that would go quietly wrong. Asked after `attempts`,
    // a refusal like this would count against the caller it named - so anybody could spend somebody
    // else's guesses from another site and leave them locked out without ever reaching a password.
    it("spends nobody's guesses on a login it will not act on", async () => {
      const guess = { json: { id: 'dave', password: 'not the password' } };
      for (let tried = 0; tried <= FREELY + 1; tried += 1) await asked('POST', '/sessions', guess);

      expect((await logIn('dave', PASSWORD)).status).toBe(201);
    }, 15_000);

    it('is a session that then names the caller without a token', async () => {
      const cookie = (await logIn('dave', PASSWORD)).cookie();

      expect((await asked('GET', '/me', { headers: { cookie } })).body).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    }, 15_000);

    // AIDEV-NOTE: the same answer for a name nobody has and for a password that is wrong. Otherwise
    // the refusals are a list of which names exist, which is the half of a credential an attacker
    // does not have to guess.
    it('says the same thing to a wrong password as to a name it does not know', async () => {
      const wrong = await logIn('dave', 'not the password');
      const nobody = await logIn('nobody at all', 'not the password');

      expect(wrong.status).toBe(nobody.status);
      expect(wrong.body).toEqual(nobody.body);
    }, 20_000);

    it('gives a refused login no session at all', async () => {
      expect((await logIn('dave', 'not the password')).header('set-cookie')).toBeUndefined();
    }, 15_000);

    // A machine's token is not a password: presenting it here must not be a way in.
    it('refuses a caller who has a token and no password', async () => {
      expect((await logIn('slicer', USER)).status).toBe(401);
    }, 15_000);

    // `loginIn` refuses six shapes in tests/api.test.ts. One here, for the wiring: that this route -
    // the one reached before the shop knows anybody - puts a body through it.
    it('refuses a body that is not a login', async () => {
      expect((await asked('POST', '/sessions', { json: { id: 'dave' }, headers: { origin: HERE } })).status).toBe(400);
    });

    // AIDEV-NOTE: what stands between a password and somebody working through a list of them.
    it('makes somebody wait after enough wrong ones, and says so', async () => {
      for (let tried = 0; tried <= FREELY; tried += 1) await logIn('dave', 'not the password');

      const turned = await logIn('dave', 'not the password');

      expect(turned.status).toBe(429);
      expect((turned.body as { error: string }).error).toContain('wait');
    }, 60_000);

    describe('and logging out', () => {
      const loggingOut = (cookie: string): ReturnType<typeof asked> => asked('DELETE', '/sessions', { headers: { cookie, origin: HERE } });

      it('ends the session it was holding', async () => {
        const cookie = (await logIn('dave', PASSWORD)).cookie();

        expect((await loggingOut(cookie)).status).toBe(204);
        expect((await asked('GET', '/me', { headers: { cookie } })).status).toBe(401);
      }, 15_000);

      it('clears the cookie as well as ending it', async () => {
        const cookie = (await logIn('dave', PASSWORD)).cookie();

        expect((await loggingOut(cookie)).header('set-cookie')).toContain(`${SESSION_COOKIE}=;`);
      }, 15_000);
    });

    // AIDEV-NOTE: SameSite is a rule the BROWSER keeps; this is the shop keeping it too. A cookie is
    // sent by whatever page asked, so a WRITE that arrived with one has to have come from here.
    //
    // The rule is `requireItCameFromHere`, unit tested over a dozen origins in tests/api.test.ts.
    // What is left is that the guard hands it the two headers a request really arrived with, that
    // the host half is compared rather than assumed, and that a token is subject to none of it.
    describe('a write carrying a session', () => {
      const loading = (headers: Record<string, string>): ReturnType<typeof asked> =>
        asked('PUT', '/printers/mk4/filament', { headers, json: { loaded: ['PLA-Red'] } });

      it('is taken when it came from this shop', async () => {
        const cookie = (await logIn('dave', PASSWORD)).cookie();

        expect((await loading({ cookie, origin: HERE })).status).toBe(200);
      }, 15_000);

      it('is refused when it came from somewhere else', async () => {
        const cookie = (await logIn('dave', PASSWORD)).cookie();

        expect((await loading({ cookie, origin: 'http://somewhere.else' })).status).toBe(403);
      }, 15_000);

      // A token is not sent by a browser on anybody's behalf, so none of this applies to one.
      it('is nothing a token has to answer for', async () => {
        expect((await asked('GET', '/jobs', { token: USER })).status).toBe(200);
      });
    });
  });

  // AIDEV-NOTE: their OWN, which is the whole of what this route is - an operator changing somebody
  // else's is `caller password` at a terminal. The password they have now is asked for even though
  // the shop already knows who is asking, because a session is a screen somebody walked away from.
  describe('changing your own password', () => {
    let asked: ReturnType<typeof drive>;
    let known: Callers;
    let mockKept: jest.Mock<(id: string, password: string) => Promise<void>>;

    const changeTo = (password: string, current: string, headers: Record<string, string> = {}, token = ADMIN): ReturnType<typeof asked> =>
      asked('PUT', '/me/password', { token: headers.cookie === undefined ? token : undefined, headers, json: { current, password } });

    const logInThere = (id: string, password: string): ReturnType<typeof asked> =>
      asked('POST', '/sessions', { json: { id, password }, headers: { origin: HERE } });

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

      // What the shop itself does with one: writes it where the callers are kept, and reads the file
      // back so that what is in force is what it now says - for the caller it was given, nobody else.
      mockKept = jest.fn<(id: string, password: string) => Promise<void>>(async (id, password) => {
        known = await everybody({ id, password });
      });

      asked = drive(createApi(shop, { callers: () => known, passwordChanged: mockKept }));
    }, 30_000);

    it('is what logs them in afterwards', async () => {
      expect((await changeTo(NEW_PASSWORD, PASSWORD)).status).toBe(204);

      expect((await logInThere('dave', NEW_PASSWORD)).status).toBe(201);
      expect((await logInThere('dave', PASSWORD)).status).toBe(401);
    }, 60_000);

    it('is refused, and nothing written, when the one they have now is wrong', async () => {
      expect((await changeTo(NEW_PASSWORD, 'not the password')).status).toBe(403);
      expect(mockKept).not.toHaveBeenCalled();
    }, 30_000);

    // The id is whoever the request turned out to be. There is no shape of body that changes
    // somebody else's - which is what keeps this open to every caller.
    it('changes the caller who asked, whoever the body names', async () => {
      await asked('PUT', '/me/password', { token: ADMIN, json: { id: 'slicer', current: PASSWORD, password: NEW_PASSWORD } });

      expect(mockKept).toHaveBeenCalledWith('dave', NEW_PASSWORD);
    }, 30_000);

    // A caller with no password is a machine's token, and there is nothing here for it to prove.
    // Giving one their first password is an operator's act, like taking one away.
    it('refuses a caller who has a token and no password', async () => {
      expect((await changeTo(NEW_PASSWORD, PASSWORD, {}, USER)).status).toBe(403);
      expect(mockKept).not.toHaveBeenCalled();
    }, 30_000);

    it('refuses the one they are already using', async () => {
      expect((await changeTo(PASSWORD, PASSWORD)).status).toBe(400);
      expect(mockKept).not.toHaveBeenCalled();
    }, 30_000);

    // `passwordChangeIn` refuses six shapes in tests/api.test.ts; one here for the wiring.
    it('refuses a body that is not a change', async () => {
      expect((await asked('PUT', '/me/password', { token: ADMIN, json: { current: PASSWORD } })).status).toBe(400);
    }, 30_000);

    // AIDEV-NOTE: what a new password is FOR - somebody either forgot theirs or believes somebody
    // else has it. The browser doing the changing is kept, because asking somebody to log in again
    // for having just proved who they are is a page that punishes the safe thing.
    it('logs out every other browser, and leaves the one that asked logged in', async () => {
      const elsewhere = (await logInThere('dave', PASSWORD)).cookie();
      const here = (await logInThere('dave', PASSWORD)).cookie();

      await changeTo(NEW_PASSWORD, PASSWORD, { cookie: here, origin: HERE });

      expect((await asked('GET', '/me', { headers: { cookie: elsewhere } })).status).toBe(401);
      expect((await asked('GET', '/me', { headers: { cookie: here } })).status).toBe(200);
    }, 60_000);

    // The same oracle as a login - something that says whether a guess was right - so it is counted
    // the same way.
    it('makes somebody wait after enough wrong ones', async () => {
      for (let tried = 0; tried <= FREELY; tried += 1) await changeTo(NEW_PASSWORD, 'not the password');

      expect((await changeTo(NEW_PASSWORD, 'not the password')).status).toBe(429);
    }, 60_000);

    // AIDEV-NOTE: a user's own password is the whole point of this route. Made an admin's, it would
    // be back to nobody being able to change their own - which is what it is here to fix.
    it("is a user's to change as much as an admin's", async () => {
      expect((await changeTo(NEW_PASSWORD, PASSWORD, {}, A_USERS_TOKEN)).status).toBe(204);
      expect(mockKept).toHaveBeenCalledWith('ada', NEW_PASSWORD);
    }, 30_000);

    // AIDEV-NOTE: the rule about a password is `setPassword`'s and is deliberately written down
    // nowhere else - the page keeps no copy on purpose, "that rule is the shop's, it says so in its
    // own words". Which it could not: `UnusableCredentials` had no row in `statusFor`, so this was a
    // 500 and "why is in its log", and the one rule there is was never said to anybody.
    it('says what is wrong with a password it will not take', async () => {
      const why = 'a password is at least 12 characters, which is the only rule there is';
      mockKept.mockRejectedValue(new UnusableCredentials(why));

      const answer = await changeTo('too short', PASSWORD);

      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ error: why });
    }, 30_000);

    it('is refused by a shop that was given nowhere to keep one', async () => {
      const nowhere = drive(createApi(shop, { callers: () => known }));

      expect((await nowhere('PUT', '/me/password', { token: ADMIN, json: { current: PASSWORD, password: NEW_PASSWORD } })).status).toBe(400);
    }, 30_000);
  });

  describe('who the shop takes the caller to be', () => {
    let asked: ReturnType<typeof drive>;

    beforeEach(async () => {
      const known = await naming({ id: 'dave', token: ADMIN }, { id: 'slicer', token: USER, role: 'user' });
      asked = drive(createApi(shop, { callers: () => known }));
    }, 15_000);

    it('says the caller back to them, by the token they presented', async () => {
      expect((await asked('GET', '/me', { token: ADMIN })).body).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
    });

    // The role is the whole point: it is what a UI offers or withholds a printer command by.
    it('says a user is a user', async () => {
      expect((await asked('GET', '/me', { token: USER })).body).toEqual({ id: 'slicer', name: 'slicer', role: 'user' });
    });

    // It answers about the TOKEN, and a shop that cannot name one answers nothing at all.
    it('tells a caller it cannot name nothing', async () => {
      expect((await asked('GET', '/me', { token: 'made-up' })).status).toBe(401);
    });

    // Whatever else a token buys, it does not buy the list of who else is here.
    it('says nothing about anybody else', async () => {
      expect(Object.keys((await asked('GET', '/me', { token: ADMIN })).body as object)).toEqual(['id', 'name', 'role']);
    });

    describe('a caller it cannot name', () => {
      it('is refused for carrying no token at all', async () => {
        const answer = await asked('GET', '/jobs');

        expect(answer.status).toBe(401);
        expect(answer.body).toEqual({ error: 'this shop does not know that token' });
      });

      // The same answer either way, so a caller cannot learn which tokens exist by watching for a
      // different refusal.
      it('is told the same thing for a bad token as for none', async () => {
        expect((await asked('GET', '/jobs', { token: 'made-up' })).body).toEqual((await asked('GET', '/jobs')).body);
      });
    });
  });
});
