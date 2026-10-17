import { describe, it, expect } from '@jest/globals';
import type { Job } from '../src/Job';
import { inQueueOrder } from '../src/queueOrder';

// (UT)
describe('the order a queue prints in', () => {
  const job = (id: number, promotedAt?: string): Job => ({
    id,
    displayName: `Job ${id}`,
    filaments: ['PLA-Red'],
    submittedAt: new Date('2026-09-12T09:00:00Z'),
    gcodeBytes: 1,
    state: 'queued',
    promotedAt: promotedAt === undefined ? undefined : new Date(promotedAt),
  });

  const order = (jobs: Job[]): number[] => [...jobs].sort(inQueueOrder).map(({ id }) => id);

  it('is the order they were submitted in when nobody promoted any', () => {
    expect(order([job(3), job(1), job(2)])).toEqual([1, 2, 3]);
  });

  it('puts a promoted job ahead of every one that was not', () => {
    expect(order([job(1), job(2), job(3, '2026-09-12T10:00:00Z')])).toEqual([3, 1, 2]);
  });

  it('puts the latest promotion ahead of an earlier one', () => {
    expect(order([job(1, '2026-09-12T11:00:00Z'), job(2, '2026-09-12T10:00:00Z'), job(3)])).toEqual([1, 2, 3]);
    expect(order([job(1, '2026-09-12T10:00:00Z'), job(2, '2026-09-12T11:00:00Z'), job(3)])).toEqual([2, 1, 3]);
  });
});
