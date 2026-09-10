import { describe, it, expect } from '@jest/globals';
import type { Job } from '@3d-print-shop/client/browser';
import { asPrintingTime, byFilament } from '../src/byFilament';

describe('the work, by what it needs loaded', () => {
  function job(id: number, filaments: string[], overrides: Partial<Job> = {}): Job {
    return {
      id,
      displayName: `Job ${id}`,
      filaments,
      submittedAt: new Date('2026-09-09T12:00:00Z'),
      gcodeBytes: 1024,
      state: 'queued',
      ...overrides,
    };
  }

  const filaments = (jobs: Job[]): string[] => byFilament(jobs).map((group) => group.filament);

  it('answers with nothing for a shop holding nothing', () => {
    expect(byFilament([])).toEqual([]);
  });

  it('gathers every job that needs the same filament', () => {
    expect(byFilament([job(1, ['red']), job(2, ['blue']), job(3, ['red'])])[0].jobs.map((held) => held.id)).toEqual([1, 3]);
  });

  // The shop's own rule: the first is the one that must be on the machine before it can begin, and
  // grouping by anything else would be a second answer to "what do I load" that disagreed with it.
  it('groups a job by the filament it starts with, whatever else it names', () => {
    expect(filaments([job(1, ['red', 'blue'])])).toEqual(['red']);
  });

  // What is printing is not what an operator has to load, so the heading counts only the queue -
  // while the jobs themselves are all still listed, because this is the view of everything.
  it('counts only what is queued, and lists what is not', () => {
    const [group] = byFilament([job(1, ['red']), job(2, ['red'], { state: 'printing' })]);

    expect(group).toMatchObject({ queued: 1 });
    expect(group.jobs.map((held) => held.id)).toEqual([1, 2]);
  });

  it('puts the busiest queue first', () => {
    expect(filaments([job(1, ['blue']), job(2, ['red']), job(3, ['red'])])).toEqual(['red', 'blue']);
  });

  it('breaks a tie alphabetically, so the answer does not wander', () => {
    expect(filaments([job(1, ['red']), job(2, ['blue'])])).toEqual(['blue', 'red']);
  });

  it('lists the jobs in the order they were submitted', () => {
    expect(byFilament([job(3, ['red']), job(1, ['red'])])[0].jobs.map((held) => held.id)).toEqual([1, 3]);
  });

  describe('how much printing is waiting', () => {
    it('totals what the queued jobs say they take', () => {
      const held = [job(1, ['red'], { estimatedPrintSeconds: 3600 }), job(2, ['red'], { estimatedPrintSeconds: 1800 })];

      expect(byFilament(held)[0].estimatedPrintSeconds).toBe(5400);
    });

    // The same all-or-nothing rule the shop applies: a partial total is quietly short.
    it('says nothing of the total when one of them did not say', () => {
      expect(byFilament([job(1, ['red'], { estimatedPrintSeconds: 3600 }), job(2, ['red'])])[0].estimatedPrintSeconds).toBeUndefined();
    });

    // A print already running is not work waiting, so its time is not part of what is.
    it('leaves a printing job out of the total', () => {
      const held = [job(1, ['red'], { estimatedPrintSeconds: 3600 }), job(2, ['red'], { state: 'printing' })];

      expect(byFilament(held)[0].estimatedPrintSeconds).toBe(3600);
    });

    it('says nothing at all when nothing is queued', () => {
      expect(byFilament([job(1, ['red'], { state: 'printing', estimatedPrintSeconds: 3600 })])[0].estimatedPrintSeconds).toBeUndefined();
    });
  });

  // Rounded up, so a queue is never shown as shorter than it is.
  describe('said as a time', () => {
    it.each([
      [59, '1m'],
      [600, '10m'],
      [3600, '1h'],
      [3601, '1h 1m'],
      [20_460, '5h 41m'],
    ])('says %i seconds as %s', (seconds, expected) => {
      expect(asPrintingTime(seconds)).toBe(expected);
    });
  });
});
