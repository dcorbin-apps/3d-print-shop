import type { Job, Shop, Verdict } from '@3d-print-shop/client';

// AIDEV-NOTE: the operator's half of the JOBS, kept apart from the command line that calls it -
// answering with LINES rather than printing, so it can be tested without a process and so a GUI is
// not stuck behind stdout. The same shape as printerAdmin.ts, and for the same reasons.
export async function listJobs(shop: Shop): Promise<string[]> {
  const { accessibleJobs, totalJobs } = await shop.jobs();

  if (totalJobs === 0) return ['nothing outstanding'];
  if (accessibleJobs.length === 0) return [`nothing of yours - this shop is holding ${totalJobs}`];

  const lines = accessibleJobs.map((job) => `${job.id}  ${job.displayName}  ${job.filaments.join(', ')}  ${whereItIs(job)}`);
  const others = totalJobs - accessibleJobs.length;

  // AIDEV-NOTE: said rather than left out, because a list that quietly showed a caller only their
  // own work would read as the whole queue - and "what is this shop busy with" is the question an
  // operator asks it. What is not theirs is a number and nothing else.
  return others === 0 ? lines : [...lines, `and ${others} more this shop is holding, which are not yours`];
}

// AIDEV-NOTE: the verdict is what frees the PRINTER, not just the job - a printer holds its bed
// until a person has judged what came off it, because that is the only evidence the shop gets that
// the bed was cleared. Without this command a shop prints one thing per machine and stops.
export async function judgeJob(shop: Shop, id: number, verdict: Verdict): Promise<string[]> {
  const judged = await shop.verdict(id, verdict);

  if (judged) return [`job ${id} rejected - back in the queue, to print again from the same gcode`];
  if (verdict === 'abandoned') return [`job ${id} abandoned - and gone, with no good print to show for it`];

  return [`job ${id} approved - and gone`];
}

function whereItIs(job: Job): string {
  if (job.state === 'queued') return 'queued';
  if (job.state === 'printing') return `printing on ${job.heldBy}`;

  return `printed on ${job.heldBy}, ${job.lastPrinterOutcome} - waiting for a verdict`;
}
