import { describe, it, expect, jest } from '@jest/globals';
import { redacting, silent, toStdout } from '../src/log';
import type { Log } from '../src/log';

describe('what the shop writes down', () => {
  const at = new Date('2026-09-08T14:02:11.123Z');

  function written(): { log: Log; lines: () => string[] } {
    const said: string[] = [];

    return { log: toStdout(() => at, (line) => said.push(line)), lines: () => said };
  }

  it('says when it happened, at what level, and what happened', () => {
    const { log, lines } = written();

    log.happened('job submitted', { job: 7 });

    expect(lines()).toEqual(['2026-09-08T14:02:11.123Z note  job submitted job=7']);
  });

  it('takes an event with nothing to say about it', () => {
    const { log, lines } = written();

    log.happened('the shop is listening');

    expect(lines()).toEqual(['2026-09-08T14:02:11.123Z note  the shop is listening']);
  });

  // Two levels, not five: what an operator needs, and why something failed. Both are the same width,
  // so a run reads down the page as columns rather than as ragged prose.
  it('marks a fault as one', () => {
    const { log, lines } = written();

    log.failed('could not send a job to the printer', { printer: 'mk4' });

    expect(lines()).toEqual(['2026-09-08T14:02:11.123Z fault could not send a job to the printer printer=mk4']);
  });

  describe('what a line is about', () => {
    it('says each one as key=value, in the order it was given them', () => {
      const { log, lines } = written();

      log.happened('started printing', { printer: 'mk4', job: 7, gcodeBytes: 1024 });

      expect(lines()[0]).toContain('started printing printer=mk4 job=7 gcodeBytes=1024');
    });

    // Otherwise a display name runs into whatever follows it and the line stops being readable.
    it('quotes a value that would otherwise run into the next one', () => {
      const { log, lines } = written();

      log.happened('job submitted', { displayName: 'Player Box', job: 7 });

      expect(lines()[0]).toContain('job submitted displayName="Player Box" job=7');
    });

    it('says a list as a list', () => {
      const { log, lines } = written();

      log.happened('filament loaded', { loaded: ['PLA-Red', 'PLA-White'] });

      expect(lines()[0]).toContain('filament loaded loaded=["PLA-Red","PLA-White"]');
    });

    // A caller nobody could name, an outcome a print never reached: absent is not the same as empty,
    // and a column of `caller=undefined` is noise in every line that has no caller.
    it('leaves out what there was nothing to say about', () => {
      const { log, lines } = written();

      log.happened('request', { status: 401, caller: undefined });

      expect(lines()[0]).toContain('request status=401');
      expect(lines()[0]).not.toContain('caller');
    });
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
      silent.happened('job submitted', { job: 7 });
      silent.failed('and that is all', { job: 7 });
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
    function guarded(): { log: Log; lines: () => string[] } {
      const { log, lines } = written();

      return { log: redacting(log, ['mk4-api-key', 'dave-token']), lines };
    }

    it('is not written even when it is the whole of a value', () => {
      const { log, lines } = guarded();

      log.happened('reached the printer', { key: 'mk4-api-key' });

      expect(lines()[0]).toContain('key=[redacted]');
    });

    it('is not written when it is buried in a value', () => {
      const { log, lines } = guarded();

      log.failed('the printer refused', { why: 'GET /api/job with X-Api-Key: mk4-api-key failed' });

      expect(lines()[0]).toContain('why="GET /api/job with X-Api-Key: [redacted] failed"');
    });

    it('is not written when it is in the message itself', () => {
      const { log, lines } = guarded();

      log.failed('could not reach http://mk4/?apikey=mk4-api-key');

      expect(lines()[0]).toContain('could not reach http://mk4/?apikey=[redacted]');
    });

    it('is not written when it is nested inside something else', () => {
      const { log, lines } = guarded();

      log.happened('a caller asked', { request: { headers: { authorization: 'Bearer dave-token' } } });

      expect(lines()[0]).toContain('Bearer [redacted]');
    });

    it('leaves everything that is not a secret alone', () => {
      const { log, lines } = guarded();

      log.happened('job submitted', { job: 7, printer: 'mk4', displayName: 'Player Box' });

      expect(lines()[0]).toContain('job submitted job=7 printer=mk4 displayName="Player Box"');
    });

    // A shop with no printer keys yet, or a caller list still empty: an empty secret would otherwise
    // match between every character and shred the line.
    it.each([[''], [' '], ['a']])('is not made of %j, which would match everything', (nothing) => {
      const { log, lines } = written();

      redacting(log, [nothing]).happened('job submitted', { displayName: 'Player Box' });

      expect(lines()[0]).toContain('displayName="Player Box"');
    });

    it('takes the same secret twice without writing it twice over', () => {
      const { log, lines } = written();

      redacting(log, ['mk4-api-key', 'mk4-api-key']).happened('reached it', { key: 'mk4-api-key' });

      expect(lines()[0]).toContain('key=[redacted]');
    });
  });
});
