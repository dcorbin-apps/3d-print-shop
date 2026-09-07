import type { Job, Shop, Verdict } from '@3d-print-shop/client';

// AIDEV-NOTE: the operator's half of the JOBS, kept apart from the command line that calls it -
// answering with LINES rather than printing, so it can be tested without a process and so a GUI is
// not stuck behind stdout. The same shape as printerAdmin.ts, and for the same reasons.
export async function listJobs(shop: Shop): Promise<string[]> {
  const jobs = await shop.jobs();
  if (jobs.length === 0) return ['nothing outstanding'];

  return jobs.map((job) => `${job.id}  ${job.displayName}  ${job.filaments.join(', ')}  ${whereItIs(job)}`);
}

// AIDEV-NOTE: the verdict is what frees the PRINTER, not just the job - a printer holds its bed
// until a person has judged what came off it, because that is the only evidence the shop gets that
// the bed was cleared. Without this command a shop prints one thing per machine and stops.
export async function judgeJob(shop: Shop, id: number, verdict: Verdict): Promise<string[]> {
  const judged = await shop.verdict(id, verdict);

  return [judged ? `job ${id} rejected - back in the queue, to print again from the same gcode` : `job ${id} approved - and gone`];
}

function whereItIs(job: Job): string {
  if (job.state === 'queued') return 'queued';
  if (job.state === 'printing') return `printing on ${job.heldBy}`;

  return `printed on ${job.heldBy}, ${job.lastPrinterOutcome} - waiting for a verdict`;
}
