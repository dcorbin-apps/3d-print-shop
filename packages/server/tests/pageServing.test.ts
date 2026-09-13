import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createApi } from '../src/api';
import { Callers } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { digestOf } from '../src/secrets';
import { aDataDirectory, parentOf } from './aDataDirectory';
import { drive } from './inProcess';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: a shop with somewhere to serve a page from. The files are made here rather than taken
// from the ui package, because what the shop is given is a DIRECTORY - it knows nothing about what is
// in one, and a test that reached for the real page would be the dependency this deliberately has not
// got. The directory is real; the static middleware and `sendFile` are real; only the request is not.
describe('serving a page beside the API', () => {
  let where: DataLayout;
  let page: string;
  let asked: ReturnType<typeof drive>;
  let withoutAPage: ReturnType<typeof drive>;

  const ADMIN = 'dave-token';
  const callers = new Callers([{ caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf(ADMIN) }] }]);

  const get = (route: string, token?: string): ReturnType<typeof asked> => asked('GET', route, { token });

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-page-');
    const shop = new JobStore(where);

    page = await mkdtemp(path.join(tmpdir(), 'print-shop-page-files-'));
    await writeFile(path.join(page, 'index.html'), '<!doctype html><title>the page</title>');
    await mkdir(path.join(page, 'assets'));
    await writeFile(path.join(page, 'assets', 'shop.js'), 'console.log("hello")');

    asked = drive(createApi(shop, { callers: () => callers, page }));
    withoutAPage = drive(createApi(shop, { callers: () => callers }));
  });

  afterEach(async () => {
    await rm(page, { recursive: true, force: true });
    await rm(parentOf(where), { recursive: true, force: true });
  });

  // AIDEV-NOTE: without a credential, and that is the point - the page nobody is logged in to yet is
  // the page they log in ON. Requiring one would be a login screen that cannot be fetched without
  // having logged in.
  it('gives the page to somebody the shop does not know', async () => {
    const answer = await get('/');

    expect(answer.status).toBe(200);
    expect(answer.text).toContain('the page');
  });

  it('gives what the page asks for next, equally', async () => {
    const answer = await get('/assets/shop.js');

    expect(answer.status).toBe(200);
    expect(answer.text).toContain('hello');
  });

  // A page a browser navigated INTO rather than loaded at the root, then reloaded. Deliberately NOT
  // a path under one of the shop's own routes: those belong to the API whatever a browser thinks,
  // which is the next test.
  it('gives the page for a path inside it, so a reload is not a 404', async () => {
    expect((await get('/somewhere/the/page/went')).text).toContain('the page');
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

  // AIDEV-NOTE: set once for the whole app rather than per route, so what is asked here is that both
  // halves carry it - the files, which go out through the static middleware, and an answer from the
  // API, which does not. A refusal is asked for too, because that is the one a route never writes.
  describe('what every answer carries', () => {
    it('says a content type is not a browser to second-guess, on the page and on an answer alike', async () => {
      expect((await get('/')).header('x-content-type-options')).toBe('nosniff');
      expect((await get('/assets/shop.js')).header('x-content-type-options')).toBe('nosniff');
      expect((await get('/printers', ADMIN)).header('x-content-type-options')).toBe('nosniff');
      expect((await get('/printers')).header('x-content-type-options')).toBe('nosniff');
    });

    it('does not volunteer what it is written in', async () => {
      expect((await get('/')).header('x-powered-by')).toBeUndefined();
      expect((await get('/printers', ADMIN)).header('x-powered-by')).toBeUndefined();
    });
  });

  // Nothing is served at all unless the shop was pointed somewhere, which is what a shop with no page
  // installed looks like.
  it('serves nothing of the sort when it was given nowhere to serve from', async () => {
    expect((await withoutAPage('GET', '/', { token: ADMIN })).status).toBe(404);
  });
});
