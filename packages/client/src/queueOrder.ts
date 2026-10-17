import type { Job } from './Job.js';

// AIDEV-NOTE: here rather than in the shop, because a page draws the queue in the order it will
// print - and a page sorting by its own rule is a second answer to "what prints next".
/** The order a filament's queue prints in: the latest promoted first, then the rest as they were submitted. */
export function inQueueOrder(one: Job, another: Job): number {
  return promoted(another) - promoted(one) || one.id - another.id;
}

function promoted(job: Job): number {
  return job.promotedAt?.getTime() ?? 0;
}
