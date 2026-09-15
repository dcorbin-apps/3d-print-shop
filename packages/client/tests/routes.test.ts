import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { BORROWED_ROUTES, HttpShop, SHOP_ROUTES } from '../src';

// AIDEV-NOTE: what this exists to catch is a route added to `HttpShop` and not to `SHOP_ROUTES` -
// which is not a broken test anywhere, it is a dev server answering with index.html and a page
// saying "unexpected character at line 1 column 1 of the JSON data". That happened, and it named
// neither the route nor the reason.
//
// Every method is CALLED rather than listed, so a new one is caught by being written at all: the
// answers are refused on purpose and the failures thrown away, because what is under test is the
// path each one asks for and nothing else.
describe('every path this client asks the shop for', () => {
  const fetching = jest.fn<typeof fetch>();

  const asked = (): string[] => fetching.mock.calls.map(([where]) => String(where));

  beforeEach(() => {
    fetching.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 418, json: () => Promise.resolve({ error: 'not what this is about' }) } as Response)
    );
    global.fetch = fetching;
  });

  async function everythingItCanBeAsked(): Promise<void> {
    const shop = new HttpShop('', 'a-token');
    const anyway = (asking: Promise<unknown>): Promise<unknown> => asking.catch(() => undefined);

    await Promise.all([
      anyway(shop.whoAmI()),
      anyway(shop.logIn('dave', 'a password of some length')),
      anyway(shop.logOut()),
      anyway(shop.changeMyPassword('the password in use', 'a different password entirely')),
      anyway(shop.jobs()),
      anyway(shop.job(1)),
      anyway(shop.submit({ filaments: ['PLA-Red'] }, new Blob(['G1\n']))),
      anyway(shop.verdict(1, 'approved')),
      anyway(shop.waitingOn()),
      anyway(shop.waitingOn('mk4')),
      anyway(shop.printers()),
      anyway(shop.addPrinter({ name: 'mk4', buildVolume: { x: 1, y: 1, z: 1 }, api: 'octoprint', address: 'http://mk4' }, 'a-key')),
      anyway(shop.removePrinter('mk4')),
      anyway(shop.pause('mk4', 'the door is open')),
      anyway(shop.resume('mk4')),
      anyway(shop.load('mk4', ['PLA-Red'])),
      anyway(shop.shutDown()),
    ]);
  }

  it('asks for something, so that this is measuring anything at all', async () => {
    await everythingItCanBeAsked();

    expect(asked().length).toBeGreaterThan(10);
  });

  it('is under one of the routes the shop is known to answer', async () => {
    await everythingItCanBeAsked();

    const strays = asked().filter((path) => !SHOP_ROUTES.some((route) => path === route || path.startsWith(`${route}/`) || path.startsWith(`${route}?`)));

    expect(strays).toEqual([]);
  });

  // The other way round: a route nothing asks for is one somebody left behind, and a dev server
  // would go on forwarding a path the shop no longer has. The borrowed ones are the exception and
  // are named rather than excused - they exist for callers that never reach for this client at all.
  it('covers every route the shop is known to answer, but for the ones not meant for this client', async () => {
    await everythingItCanBeAsked();

    const unasked = SHOP_ROUTES.filter((route) => !asked().some((path) => path === route || path.startsWith(`${route}/`) || path.startsWith(`${route}?`)));

    expect(unasked).toEqual(BORROWED_ROUTES);
  });
});
