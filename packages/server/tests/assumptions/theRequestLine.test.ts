import { describe, it, expect, afterAll, beforeAll } from '@jest/globals';
import express from 'express';
import { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// AIDEV-NOTE: what node's parser and express between them hand a handler, for a request line written
// on the wire by hand. The shop's guard asks `needsAdmin(request.method, request.path)`, so the whole
// of its correctness rests on these two values being what their author pictured - and that is the one
// link no test above this can watch, because the only way to fake it is to write down the answer.
//
// The bug this exists for was never that the rule computed the wrong answer. It was that the value
// reaching the rule was not the one assumed.
describe('what a raw request line becomes by the time a handler sees it', () => {
  let server: Server;
  let port: number;
  let seen: { method: string; url: string; path: string };

  beforeAll(async () => {
    const app = express();
    app.use((request, response) => {
      seen = { method: request.method, url: request.url ?? '', path: request.path };
      response.status(204).end();
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((listening) => server.once('listening', () => listening()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((closed) => server.close(() => closed()));
  });

  // Written to the socket rather than handed to fetch: a URL given to fetch is normalised by the
  // WHATWG parser before a byte leaves, which is a second opinion about the very thing being asked.
  async function arriving(line: string): Promise<{ method: string; url: string; path: string }> {
    await new Promise<void>((done) => {
      const wire = new Socket();
      wire.connect(port, '127.0.0.1', () => wire.write(`${line} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
      wire.on('close', () => done());
      wire.resume();
    });

    return seen;
  }

  // The guard reads `path`, so a query string must not be part of what it matches on - otherwise
  // every route a client asked with a parameter would be a route nobody had classified.
  it('keeps the query on the url and takes it off the path', async () => {
    expect(await arriving('GET /jobs?x=1')).toEqual({ method: 'GET', url: '/jobs?x=1', path: '/jobs' });
  });

  // Nothing folds case on the way in, which is why the rule has to. Express ROUTES case-insensitively
  // regardless, so a path that arrives shouting reaches the same handler while reading differently.
  it('folds no case', async () => {
    expect(await arriving('GET /JOBS')).toMatchObject({ url: '/JOBS', path: '/JOBS' });
  });

  // Same again for a trailing slash: express routes non-strictly, so `/jobs/` is the `/jobs` handler
  // while the path still carries the slash.
  it('strips no trailing slash', async () => {
    expect(await arriving('GET /jobs/')).toMatchObject({ path: '/jobs/' });
  });

  it('leaves a doubled slash as it was written', async () => {
    expect(await arriving('GET //jobs')).toMatchObject({ path: '//jobs' });
  });

  // A HEAD is served from a GET route and arrives saying HEAD, which is why the rule maps one to the
  // other - matching on the method as written would leave every HEAD unclassified.
  it('says HEAD for a HEAD, though a GET route is what will answer it', async () => {
    expect(await arriving('HEAD /jobs')).toMatchObject({ method: 'HEAD', path: '/jobs' });
  });

  // AIDEV-NOTE: the one worth the socket. A client can write `%2F` where a path segment cannot hold a
  // slash, and NEITHER node nor express decodes it here - so what the guard matches on still carries
  // the escape. What express does decode is a route PARAMETER, which is why a name that climbs out of
  // the data directory is caught at the `/printers/:name` mount and not by anything reading `path`.
  it('decodes no escape in the path, however much one looks like a slash', async () => {
    expect(await arriving('DELETE /printers/..%2F..%2Fetc')).toMatchObject({ path: '/printers/..%2F..%2Fetc' });
  });

  it('leaves an ordinary encoded name encoded too', async () => {
    expect(await arriving('GET /printers/Prusa%20MK4/filament')).toMatchObject({ path: '/printers/Prusa%20MK4/filament' });
  });
});
