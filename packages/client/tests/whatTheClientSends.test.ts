import { describe, it, expect, beforeEach } from '@jest/globals';
import { HttpShop } from '../src/HttpShop';
import type { JobDetails, PrinterRecord, Verdict } from '../src';

// AIDEV-NOTE: what this client puts on a request and what it makes of the answer - the order of a
// multipart body, a path a name has to be escaped into, a time that arrives as a string and has to
// leave as a Date. It used to be asked over a real socket at a stand-in shop, which was a way of
// WATCHING rather than anything being claimed: carrying the bytes is undici's, and what is on them
// is ours.
//
// Undici still does the serialising. Each request is built as a real `Request`, so a multipart body
// gets its boundary and its part order from exactly the code that would write it to a wire - it is
// simply read back here instead of sent. That undici refuses a connection nobody is listening on,
// which is the one thing the socket really showed, is tests/assumptions/whatFetchDoes.test.ts.
//
// That the shop AGREES with all of this is proved from the other side, in the server's own suite,
// where both halves are to hand.
describe('what the client sends, and what it makes of the answer', () => {
  let asked: { method: string; path: string; body: string; contentType: string }[];
  let answers: { status: number; body?: unknown };
  let shop: HttpShop;

  const AT = 'http://shop.local';

  const watching: typeof fetch = async (input, init) => {
    const sending = new Request(input as string, init);
    const where = new URL(sending.url);
    asked.push({
      method: sending.method,
      path: `${where.pathname}${where.search}`,
      body: await sending.text(),
      contentType: sending.headers.get('content-type') ?? '',
    });

    return new Response(answers.status === 204 ? null : JSON.stringify(answers.body), {
      status: answers.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  const MK4: PrinterRecord = { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://octopi.local' };
  const playerBox: JobDetails = { filaments: ['PLA-SpaceGray'], displayName: 'Player Box' };
  const aJob = { id: 7, displayName: 'Player Box', filaments: ['PLA-SpaceGray'], gcodeBytes: 21, state: 'queued' };

  beforeEach(() => {
    asked = [];
    answers = { status: 200, body: {} };
    shop = new HttpShop(AT, undefined, watching);
  });

  describe('the jobs it is holding', () => {
    // The operator's question rather than the shop's, and a route of its own: anything under /jobs
    // would collide with /jobs/{id}.
    it('asks what the queue is waiting for', async () => {
      answers = { status: 200, body: [{ filament: 'PLA-Red', jobs: 2 }] };

      expect(await shop.waitingOn()).toEqual([{ filament: 'PLA-Red', jobs: 2 }]);
      expect(asked).toMatchObject([{ method: 'GET', path: '/filaments' }]);
    });

    // A name goes in the query and not the path: /filaments is the resource, and a machine only
    // narrows it. Encoded, because a printer may be named anything a directory can be called.
    it('asks what one machine is waiting for', async () => {
      answers = { status: 200, body: [] };

      await shop.waitingOn('the big one');

      expect(asked).toMatchObject([{ method: 'GET', path: '/filaments?printer=the%20big%20one' }]);
    });

    it('asks for one by id', async () => {
      answers = { status: 200, body: { ...aJob, submittedAt: '2026-09-06T11:22:04.177Z' } };

      expect(await shop.job(7)).toMatchObject({ id: 7, displayName: 'Player Box' });
      expect(asked[0]).toMatchObject({ method: 'GET', path: '/jobs/7' });
    });
  });

  describe('submitting', () => {
    beforeEach(() => {
      answers = { status: 201, body: { ...aJob, submittedAt: '2026-09-06T11:22:04.177Z' } };
    });

    // AIDEV-NOTE: the shop validates the description before reading a byte of gcode, which is what
    // lets it refuse a hopeless job without being sent tens of megabytes to say so. The order is the
    // contract, and it is the order of the SERIALISED body - which is why the body is read back off
    // a real Request rather than off the FormData that went in.
    it('sends the description ahead of the gcode', async () => {
      await shop.submit(playerBox, new Blob(['G1 X100\n']));

      expect(asked[0].body.indexOf('name="job"')).toBeLessThan(asked[0].body.indexOf('name="gcode"'));
    });

    // AIDEV-NOTE: a multipart body carries its own content type, boundary and all - so the header
    // has to be left to the form rather than set. Labelled anything else, the boundary never reaches
    // the shop and nothing it was sent can be parsed, however right the bytes are.
    it('lets the form say its own content type, so the boundary reaches the shop', async () => {
      await shop.submit(playerBox, new Blob(['G1 X100\n']));

      expect(asked[0].contentType).toContain('multipart/form-data; boundary=');
    });

    it('sends what the shop schedules on, and the gcode it was given', async () => {
      await shop.submit(playerBox, new Blob(['G1 X100\n']));

      expect(asked[0].body).toContain(JSON.stringify(playerBox));
      expect(asked[0].body).toContain('G1 X100');
    });

    it('answers with the job the shop made of it', async () => {
      expect(await shop.submit(playerBox, new Blob(['G1 X100\n']))).toMatchObject({ id: 7, state: 'queued' });
    });
  });

  describe('a verdict', () => {
    // One route and a value, so every verdict goes the same way in and none of them is an endpoint.
    it.each<[Verdict]>([['approved'], ['rejected'], ['abandoned']])('sends %s as the word the shop reads', async (verdict) => {
      answers = { status: 204 };

      await shop.verdict(7, verdict);

      expect(asked[0]).toMatchObject({ method: 'PUT', path: '/jobs/7/verdict', body: `{"verdict":"${verdict}"}` });
    });

    it('answers with nothing for a job that has left the shop', async () => {
      answers = { status: 204 };

      expect(await shop.verdict(7, 'approved')).toBeUndefined();
    });

    it('answers with the job when it is back in the queue', async () => {
      answers = { status: 200, body: { ...aJob, submittedAt: '2026-09-06T11:22:04.177Z' } };

      expect(await shop.verdict(7, 'rejected')).toMatchObject({ id: 7, state: 'queued' });
    });
  });

  // AIDEV-NOTE: the one they have now travels WITH the new one rather than being checked by a login
  // first, so the shop judges one request instead of trusting that an earlier one was the same
  // person - and the route is the caller's own, with no id in it for one to be somebody else's.
  it('sends both passwords to a route about nobody else', async () => {
    answers = { status: 204 };

    await shop.changeMyPassword('the password in use', 'a different password entirely');

    expect(asked[0]).toMatchObject({
      method: 'PUT',
      path: '/me/password',
      body: '{"current":"the password in use","password":"a different password entirely"}',
    });
  });

  describe('the printers', () => {
    // 201 or 200 is the whole difference between adding a printer and changing one, and it lives
    // only in the status.
    it.each([
      [201, true],
      [200, false],
    ])('reads %s as created being %s', async (status, created) => {
      answers = { status, body: { ...MK4, loaded: [] } };

      expect((await shop.addPrinter(MK4)).created).toBe(created);
    });
  });

  // AIDEV-NOTE: the shop is a service somebody starts, so nothing answering is the ordinary mistake
  // rather than an exceptional one - and worth a sentence saying what to do about it, naming the
  // shop it could not reach. What undici does when nobody is listening is its own, and is pinned in
  // the assumption suite; this is what the client makes of it.
  it('says the shop is not running when nothing answers', async () => {
    const nowhere = new HttpShop(AT, undefined, () => Promise.reject(new TypeError('fetch failed')));

    await expect(nowhere.jobs()).rejects.toThrow(`Cannot reach the print shop at ${AT}. Is it running?`);
  });
});
