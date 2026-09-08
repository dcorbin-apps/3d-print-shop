import { describe, it, expect, jest } from '@jest/globals';
import { redacting, silent, toStdout } from '../src/log';
import type { About, Log } from '../src/log';

describe('what the shop writes down', () => {
  const at = new Date('2026-09-08T14:02:11.123Z');

  function written(): { log: Log; lines: () => Record<string, unknown>[] } {
    const said: string[] = [];
    const write = jest.fn<(line: string) => void>((line) => {
      said.push(line);
    });

    return { log: toStdout(() => at, write), lines: () => said.map((line) => JSON.parse(line) as Record<string, unknown>) };
  }

  it('says when it happened, what happened, and what it was about - as one line of JSON', () => {
    const { log, lines } = written();

    log.happened('job submitted', { id: 7, filaments: ['PLA-Red'] });

    expect(lines()).toEqual([{ at: '2026-09-08T14:02:11.123Z', level: 'note', event: 'job submitted', id: 7, filaments: ['PLA-Red'] }]);
  });

  it('takes an event with nothing to say about it', () => {
    const { log, lines } = written();

    log.happened('the shop is listening');

    expect(lines()).toEqual([{ at: '2026-09-08T14:02:11.123Z', level: 'note', event: 'the shop is listening' }]);
  });

  // Two levels, not five: what an operator needs, and why something failed.
  it('marks a fault as one', () => {
    const { log, lines } = written();

    log.failed('could not send to the printer', { printer: 'mk4' });

    expect(lines()[0]).toMatchObject({ level: 'fault', event: 'could not send to the printer', printer: 'mk4' });
  });

  // AIDEV-NOTE: the default every component falls back to, so a silent one that was not silent would
  // put a line under every unit test in the repository. Console is swapped rather than spied on
  // because writing to it IS the behaviour being denied - there is nothing else to observe.
  it('writes nothing at all when it is the silent one', () => {
    const wrote = jest.fn<(...said: unknown[]) => void>();
    const [log, error] = [console.log, console.error];
    console.log = wrote;
    console.error = wrote;

    try {
      silent.happened('job submitted', { id: 7 });
      silent.failed('and that is all', { id: 7 });
    } finally {
      console.log = log;
      console.error = error;
    }

    expect(wrote).not.toHaveBeenCalled();
  });

  // AIDEV-NOTE: the shop holds two kinds of secret - a printer's API key and a caller's token - and
  // the ways either reaches a log are ways nobody chose: an OctoPrint failure quoting its own
  // request headers, an express error quoting an Authorization header.
  describe('a secret it was told never to write', () => {
    function guarded(): { log: Log; lines: () => Record<string, unknown>[] } {
      const { log, lines } = written();

      return { log: redacting(log, ['mk4-api-key', 'dave-token']), lines };
    }

    it('is not written even when it is the whole of a field', () => {
      const { log, lines } = guarded();

      log.happened('reached the printer', { key: 'mk4-api-key' });

      expect(lines()[0].key).toBe('[redacted]');
    });

    it('is not written when it is buried in a message', () => {
      const { log, lines } = guarded();

      log.failed('the printer refused', { why: 'GET /api/job with X-Api-Key: mk4-api-key failed' });

      expect(lines()[0].why).toBe('GET /api/job with X-Api-Key: [redacted] failed');
    });

    it('is not written when it is nested inside something else', () => {
      const { log, lines } = guarded();

      log.happened('a caller asked', { request: { headers: { authorization: 'Bearer dave-token' } } });

      expect(lines()[0]).toMatchObject({ request: { headers: { authorization: 'Bearer [redacted]' } } });
    });

    it('leaves everything that is not a secret alone', () => {
      const { log, lines } = guarded();

      log.happened('job submitted', { id: 7, printer: 'mk4', displayName: 'Player Box' });

      expect(lines()[0]).toMatchObject({ id: 7, printer: 'mk4', displayName: 'Player Box' });
    });

    // A shop with no printer keys yet, or a caller list still empty: an empty secret would otherwise
    // match between every character and shred the line.
    it.each([[''], [' '], ['a']])('is not made of %j, which would match everything', (nothing) => {
      const { log, lines } = written();

      redacting(log, [nothing]).happened('job submitted', { displayName: 'Player Box' });

      expect(lines()[0].displayName).toBe('Player Box');
    });

    it('takes the same secret twice without writing it twice over', () => {
      const { log, lines } = written();

      redacting(log, ['mk4-api-key', 'mk4-api-key']).happened('reached it', { key: 'mk4-api-key' } as About);

      expect(lines()[0].key).toBe('[redacted]');
    });
  });
});
