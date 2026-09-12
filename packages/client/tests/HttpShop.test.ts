import { describe, it, expect } from '@jest/globals';
import { asJob, asPrinter, printerPath, refusal, sending, since } from '../src/HttpShop';

// AIDEV-NOTE: a time is an ISO string on the wire and a Date in hand, and converting it here is the
// whole reason this is a client rather than a cast - a caller handed `submittedAt` typed as a Date
// and holding a string finds out at the first comparison, somewhere else entirely. Seven acceptance
// tests used to stand up a server to watch that happen; none of it needs one.
describe('what the wire says, in the shape a caller was promised', () => {
  const WIRE_JOB = {
    id: 1,
    filaments: ['PLA-Red'],
    displayName: 'Player Box',
    gcodeBytes: 100,
    state: 'queued' as const,
    submittedAt: '2026-09-12T09:00:00.000Z',
  };

  describe('a job', () => {
    it('hands back the time it was submitted as a time', () => {
      expect(asJob(WIRE_JOB).submittedAt).toEqual(new Date('2026-09-12T09:00:00.000Z'));
    });

    it('leaves everything else exactly as it came', () => {
      expect(asJob(WIRE_JOB)).toMatchObject({ id: 1, filaments: ['PLA-Red'], displayName: 'Player Box', gcodeBytes: 100, state: 'queued' });
    });
  });

  describe('a time a printer has been in some state since', () => {
    it('is nothing at all when the printer is in no such state', () => {
      expect(since(undefined)).toBeUndefined();
    });

    it('keeps the reason and turns the time into one', () => {
      expect(since({ reason: 'the door is open', since: '2026-09-12T09:00:00.000Z' })).toEqual({
        reason: 'the door is open',
        since: new Date('2026-09-12T09:00:00.000Z'),
      });
    });
  });

  // Four ways a printer can be in trouble, and each carries a time. A cast would let any of them
  // through as a string.
  describe('a printer', () => {
    const WIRE_PRINTER = {
      name: 'mk4',
      buildVolume: { x: 250, y: 210, z: 220 },
      address: 'http://octopi.local',
      api: 'octoprint' as const,
      loaded: ['PLA-Red'],
    };

    it.each(['paused', 'unreachable', 'refused', 'outOfContact'] as const)('hands back the time it went %s as a time', (trouble) => {
      const printer = asPrinter({ ...WIRE_PRINTER, [trouble]: { reason: 'because', since: '2026-09-12T09:00:00.000Z' } });

      expect(printer[trouble]).toEqual({ reason: 'because', since: new Date('2026-09-12T09:00:00.000Z') });
    });

    it('leaves a printer in no trouble with none of them', () => {
      const printer = asPrinter(WIRE_PRINTER);

      expect([printer.paused, printer.unreachable, printer.refused, printer.outOfContact]).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('keeps what the printer is', () => {
      expect(asPrinter(WIRE_PRINTER)).toMatchObject(WIRE_PRINTER);
    });
  });
});

// A name is whatever an operator typed, and one carrying a '#' would otherwise make a URL whose path
// stops there.
describe('a printer name on its way into a path', () => {
  it.each([
    ['mk4', '/printers/mk4'],
    ['Prusa MK4', '/printers/Prusa%20MK4'],
    ['mk4#two', '/printers/mk4%23two'],
    ['a/b', '/printers/a%2Fb'],
    ['a?b', '/printers/a%3Fb'],
  ])('puts %j at %j', (name, path) => {
    expect(printerPath(name)).toBe(path);
  });
});

// The far end is what knows WHY - a printer that is not here, a bed nothing has room for. This end
// knows only that something was refused.
describe('what a client says when the shop would not', () => {
  it('repeats what the shop said', async () => {
    const said = new Response(JSON.stringify({ error: 'no printer called mini' }), { status: 404 });

    expect(await refusal(said)).toBe('no printer called mini');
  });

  it('falls back to the status when the refusal said nothing', async () => {
    expect(await refusal(new Response('', { status: 503, statusText: 'Service Unavailable' }))).toBe('503 Service Unavailable');
  });

  it('falls back when the body was not JSON at all', async () => {
    expect(await refusal(new Response('<html>a proxy</html>', { status: 502, statusText: 'Bad Gateway' }))).toBe('502 Bad Gateway');
  });

  it('falls back when the body was JSON that said no error', async () => {
    expect(await refusal(new Response(JSON.stringify({ nothing: true }), { status: 400, statusText: 'Bad Request' }))).toBe('400 Bad Request');
  });
});

// A multipart body carries its own content type, boundary and all; JSON has to say so itself.
describe('how a body is sent', () => {
  it('sends nothing at all when there is no body', () => {
    expect(sending(undefined)).toEqual({});
  });

  it('lets a form say its own content type, because the boundary is part of it', () => {
    const form = new FormData();

    expect(sending(form)).toEqual({ body: form });
  });

  it('says that anything else is JSON, and makes it so', () => {
    expect(sending({ stopped: true })).toEqual({ headers: { 'content-type': 'application/json' }, body: '{"stopped":true}' });
  });
});
