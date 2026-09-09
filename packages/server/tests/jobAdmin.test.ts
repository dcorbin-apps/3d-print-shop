import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Job, Shop } from '@3d-print-shop/client';
import { judgeJob, listJobs, whatToLoadNext } from '../src/jobAdmin';

// The shop is a CLIENT here, not a store - these commands go through the API like every other
// client, so what they are given is an interface. What the shop does with each call is its own suite.
describe('minding the work', () => {
  const mockJobs = jest.fn<Shop['jobs']>();
  const mockVerdict = jest.fn<Shop['verdict']>();
  const mockWaitingOn = jest.fn<Shop['waitingOn']>();

  const shop = { jobs: mockJobs, verdict: mockVerdict, waitingOn: mockWaitingOn } as unknown as Shop;

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

  // What the shop answers: the jobs this caller may see, and how many it holds altogether.
  const holding = (accessibleJobs: Job[], totalJobs = accessibleJobs.length): { accessibleJobs: Job[]; totalJobs: number } => ({
    accessibleJobs,
    totalJobs,
  });

  beforeEach(() => {
    mockJobs.mockResolvedValue(holding([]));
    mockWaitingOn.mockResolvedValue([]);
    mockVerdict.mockResolvedValue(undefined);
  });

  describe('listing it', () => {
    it('says there is none', async () => {
      expect(await listJobs(shop)).toEqual(['nothing outstanding']);
    });

    it('gives each job, what it needs, and that it is waiting', async () => {
      mockJobs.mockResolvedValue(holding([job()]));

      expect(await listJobs(shop)).toEqual(['1  Player Box  PLA-SpaceGray  queued']);
    });

    it('says which printer has one that is running', async () => {
      mockJobs.mockResolvedValue(holding([job({ state: 'printing', heldBy: 'mk4' })]));

      expect(await listJobs(shop)).toEqual(['1  Player Box  PLA-SpaceGray  printing on mk4']);
    });

    // AIDEV-NOTE: said rather than left out. A list that quietly showed a caller only their own work
    // would read as the whole queue, and "what is this shop busy with" is what an operator asks it.
    it('says how many it is holding that are not this caller\'s', async () => {
      mockJobs.mockResolvedValue(holding([job()], 4));

      expect(await listJobs(shop)).toEqual([
        '1  Player Box  PLA-SpaceGray  queued',
        'and 3 more this shop is holding, which are not yours',
      ]);
    });

    it('says the shop is busy even when none of it is theirs', async () => {
      mockJobs.mockResolvedValue(holding([], 4));

      expect(await listJobs(shop)).toEqual(['nothing of yours - this shop is holding 4']);
    });

    // AIDEV-NOTE: what an operator is really looking for. A job here is holding a bed until somebody
    // judges it, and the printer's own outcome is what they need before they can.
    it('says which are waiting on a person, and what the printer made of them', async () => {
      mockJobs.mockResolvedValue(holding([job({ state: 'awaiting-approval', heldBy: 'mk4', lastPrinterOutcome: 'failed' })]));

      expect(await listJobs(shop)).toEqual(['1  Player Box  PLA-SpaceGray  printed on mk4, failed - waiting for a verdict']);
    });
  });

  describe('what to load next', () => {
    it('says what is waiting, and how much of it is', async () => {
      mockWaitingOn.mockResolvedValue([
        { filament: 'PLA-Red', jobs: 3 },
        { filament: 'PLA-White', jobs: 1 },
      ]);

      expect(await whatToLoadNext(shop)).toEqual(['PLA-Red    3 jobs waiting', 'PLA-White  1 job waiting']);
    });

    // What the operator is actually deciding by, when the shop knows it.
    it('says how much printing is waiting, not only how many jobs', async () => {
      mockWaitingOn.mockResolvedValue([{ filament: 'PLA-Red', jobs: 2, estimatedPrintSeconds: 20_460 }]);

      expect(await whatToLoadNext(shop)).toEqual(['PLA-Red  2 jobs waiting, 5h 41m of printing']);
    });

    // Rounded up, so a queue is never said to be shorter than it is.
    it.each([
      [59, '1m'],
      [3600, '1h'],
      [3601, '1h 1m'],
    ])('says %i seconds as %s', async (seconds, expected) => {
      mockWaitingOn.mockResolvedValue([{ filament: 'PLA-Red', jobs: 1, estimatedPrintSeconds: seconds }]);

      expect(await whatToLoadNext(shop)).toEqual([`PLA-Red  1 job waiting, ${expected} of printing`]);
    });

    it('says when nothing is waiting on anything', async () => {
      mockWaitingOn.mockResolvedValue([]);

      expect(await whatToLoadNext(shop)).toEqual(['nothing queued - nothing is waiting on any filament']);
    });

    it('asks about one machine when the operator named one', async () => {
      mockWaitingOn.mockResolvedValue([{ filament: 'PLA-Red', jobs: 1 }]);

      expect(await whatToLoadNext(shop, 'mini')).toEqual(['PLA-Red  1 job waiting']);
      expect(mockWaitingOn).toHaveBeenCalledWith('mini');
    });

    // A busy shop none of whose work fits the machine in front of you is not a shop with nothing
    // to do, and reading it as one is how somebody walks away from a queue.
    it('says which machine has nothing to do, rather than saying the shop has nothing', async () => {
      mockWaitingOn.mockResolvedValue([]);

      expect(await whatToLoadNext(shop, 'mini')).toEqual(['nothing queued that mini could take']);
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
