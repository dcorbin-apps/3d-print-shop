import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { IncomingMessage, ServerResponse } from 'node:http';
import { rm } from 'node:fs/promises';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { createApi } from '../src/api';
import { Callers } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { digestOf } from '../src/secrets';
import { SESSION_COOKIE, Sessions } from '../src/sessions';
import { aDataDirectory, parentOf } from './aDataDirectory';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: the guard's PLACE, which is a security property expressed as nothing but the order of
// statements in createApi - the logger, the page and POST /sessions above it, every other route
// below. Moving it up means nobody can log in; moving it down, or registering a route above it,
// means that route is open to anybody who reaches the port, and nothing else here would fail.
//
// An express app is a function of a request, so this drives the REAL router with the real ordering
// and no socket at all. The request object is the only thing made up, and it is not what is claimed:
// what express derives from a real request line is pinned in tests/assumptions/theRequestLine.test.ts,
// and the rule the guard applies is `requireTheirRole` in tests/api.test.ts.
describe('where the guard sits', () => {
  let where: DataLayout;
  let shop: JobStore;
  let sessions: Sessions;
  let api: ReturnType<typeof createApi>;

  const HOST = 'shop.local';
  const HERE = `http://${HOST}`;

  const ADMIN = 'dave-token';
  const USER = 'slicer-token';

  const callers = new Callers([
    { caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] },
    { caller: { id: 'slicer', name: 'slicer', role: 'user' }, credentials: [{ kind: 'token', hash: digestOf(USER) }] },
  ]);

  interface Answer {
    status: number;
    body: string;
  }

  function answered(method: string, url: string, token?: string, body?: string, carrying: Record<string, string> = {}): Promise<Answer> {
    const request = new IncomingMessage(new Socket());
    request.method = method;
    request.url = url;
    const payload = body === undefined ? undefined : Buffer.from(body);
    request.headers = {
      host: HOST,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
      ...carrying,
    };
    if (payload !== undefined) request.push(payload);
    request.push(null);

    const response = new ServerResponse(request);
    // A ServerResponse writes to a socket, and nothing here has one. What it writes is not the claim;
    // the status is, and express sets that through its own real `res.status().json()`.
    const wire = new PassThrough();
    const written: Buffer[] = [];
    wire.on('data', (chunk: Buffer) => written.push(chunk));
    response.assignSocket(wire as unknown as Socket);

    return new Promise((settled) => {
      response.on('finish', () => settled({ status: response.statusCode, body: Buffer.concat(written).toString() }));
      api(request, response);
    });
  }

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-guard-');
    shop = new JobStore(where);
    await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://octopi.local' });
    sessions = new Sessions();
    api = createApi(shop, { callers: () => callers, sessions });
  });

  afterEach(async () => {
    await rm(parentOf(where), { recursive: true, force: true });
  });

  it('is above every route that holds work, so one is refused a caller it cannot name', async () => {
    expect((await answered('GET', '/jobs')).status).toBe(401);
  });

  // AIDEV-NOTE: the half that would be silent. A route registered ABOVE the guard is open to anybody
  // who can reach the port, and no other test in the suite would go red for it.
  it('is above the printers too, and not only the jobs', async () => {
    expect((await answered('GET', '/printers')).status).toBe(401);
  });

  // The other direction, which fails loudly rather than silently: a guard above the login is a shop
  // nobody can ever log in to, because logging in is how a caller stops being unknown.
  it('is below the login, which is the one route reached before the shop knows anybody', async () => {
    const refused = await answered('POST', '/sessions', undefined, JSON.stringify({ id: 'dave' }), { origin: HERE });

    expect(refused.status).toBe(400);
    expect(refused.body).toContain('a login is an id and a password');
  });

  it('lets a caller it knows through to the work', async () => {
    expect((await answered('GET', '/jobs', USER)).status).toBe(200);
  });

  it('asks the role rule, and answers with what it said', async () => {
    const refused = await answered('DELETE', '/printers/mk4', USER);

    expect(refused.status).toBe(403);
    expect(refused.body).toContain('DELETE /printers/mk4 is for an admin, and slicer is not one');
  });

  // AIDEV-NOTE: leaving, which a caller who was not an admin could not do - `DELETE /sessions` was
  // missing from the open list, so the role rule refused somebody the end of their own session. The
  // session is begun directly rather than by logging in, because what is under test is the guard
  // letting the request through, and a password would buy nothing but two scrypts.
  it('lets a caller who is not an admin end their own session', async () => {
    const secret = sessions.begin('slicer');

    const out = await answered('DELETE', '/sessions', undefined, undefined, {
      cookie: `${SESSION_COOKIE}=${secret}`,
      origin: 'http://shop.local',
    });

    expect(out.status).toBe(204);
    expect(sessions.whose(secret)).toBeUndefined();
  });

  // AIDEV-NOTE: `request.path` and not `request.url`, which is the whole of the bug this block exists
  // for. Handed the url, every route asked with a parameter would be a route nobody had classified -
  // and it fails CLOSED, so only the less privileged caller ever sees it.
  it('judges the path a request asked for rather than the url it wrote', async () => {
    expect((await answered('GET', '/jobs?mine=true', USER)).status).toBe(200);
  });
});
