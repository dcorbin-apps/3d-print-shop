import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Job, Shop } from '@3d-print-shop/client';
import { judgeJob, listJobs } from '../src/jobAdmin';

// The shop is a CLIENT here, not a store - these commands go through the API like every other
// client, so what they are given is an interface. What the shop does with each call is its own suite.
describe('minding the work', () => {
  const mockJobs = jest.fn<Shop['jobs']>();
  const mockVerdict = jest.fn<Shop['verdict']>();

  const shop = { jobs: mockJobs, verdict: mockVerdict } as unknown as Shop;

  function job(overrides: Partial<Job> = {}): Job {
    return {
      id: 1,
      displayName: 'Player Box',
      filaments: ['PLA-SpaceGray'],
      submittedAt: new Date('2026-09-06T12:00:00Z'),
      gcodeBytes: 1024,
      state: 'queued',
      ...overrides,
    };
  }

  beforeEach(() => {
    mockJobs.mockResolvedValue([]);
    mockVerdict.mockResolvedValue(undefined);
  });

  describe('listing it', () => {
    it('says there is none', async () => {
      expect(await listJobs(shop)).toEqual(['nothing outstanding']);
    });

    it('gives each job, what it needs, and that it is waiting', async () => {
      mockJobs.mockResolvedValue([job()]);

      expect(await listJobs(shop)).toEqual(['1  Player Box  PLA-SpaceGray  queued']);
    });

    it('says which printer has one that is running', async () => {
      mockJobs.mockResolvedValue([job({ state: 'printing', heldBy: 'mk4' })]);

      expect(await listJobs(shop)).toEqual(['1  Player Box  PLA-SpaceGray  printing on mk4']);
    });

    // AIDEV-NOTE: what an operator is really looking for. A job here is holding a bed until somebody
    // judges it, and the printer's own outcome is what they need before they can.
    it('says which are waiting on a person, and what the printer made of them', async () => {
      mockJobs.mockResolvedValue([job({ state: 'awaiting-approval', heldBy: 'mk4', lastPrinterOutcome: 'failed' })]);

      expect(await listJobs(shop)).toEqual(['1  Player Box  PLA-SpaceGray  printed on mk4, failed - waiting for a verdict']);
    });
  });

  describe('judging one', () => {
    it('says an approved job has gone', async () => {
      expect(await judgeJob(shop, 7, 'approved')).toEqual(['job 7 approved - and gone']);
      expect(mockVerdict).toHaveBeenCalledWith(7, 'approved');
    });

    it('says an abandoned job has gone, and why that is not approval', async () => {
      expect(await judgeJob(shop, 7, 'abandoned')).toEqual(['job 7 abandoned - and gone, with no good print to show for it']);
      expect(mockVerdict).toHaveBeenCalledWith(7, 'abandoned');
    });

    it('says a rejected one is back to be printed again', async () => {
      mockVerdict.mockResolvedValue(job({ id: 7 }));

      expect(await judgeJob(shop, 7, 'rejected')).toEqual(['job 7 rejected - back in the queue, to print again from the same gcode']);
      expect(mockVerdict).toHaveBeenCalledWith(7, 'rejected');
    });
  });
});
