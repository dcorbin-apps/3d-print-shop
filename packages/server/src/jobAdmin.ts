import type { FilamentDemand, Job, Shop, Verdict } from '@3d-print-shop/client';

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

// AIDEV-NOTE: the other half of `list`, and the more useful one at the machine - "what should I
// load next" rather than "what is here". It counts every queued job the shop holds, which is why it
// is an admin's to ask: a caller who owns none of that work may learn only how much there is.
export async function whatToLoadNext(shop: Shop, printer?: string): Promise<string[]> {
  const waiting = await shop.waitingOn(printer);
  if (waiting.length === 0) return [nothingIsWaiting(printer)];

  const widest = Math.max(...waiting.map((demand) => demand.filament.length));

  return waiting.map((demand) => `${demand.filament.padEnd(widest)}  ${jobsWaiting(demand)}`);
}

// Which of the two questions was asked, because "nothing queued" at a machine that could take
// none of a busy queue would read as a shop with nothing to do.
function nothingIsWaiting(printer: string | undefined): string {
  return printer === undefined ? 'nothing queued - nothing is waiting on any filament' : `nothing queued that ${printer} could take`;
}

function jobsWaiting({ jobs, estimatedPrintSeconds }: FilamentDemand): string {
  const waiting = jobs === 1 ? '1 job waiting' : `${jobs} jobs waiting`;

  // Said only when the shop has it for all of them - see `FilamentDemand`. What an operator decides
  // by is the time, so it goes on the line rather than being left for them to work out.
  return estimatedPrintSeconds === undefined ? waiting : `${waiting}, ${asPrintingTime(estimatedPrintSeconds)} of printing`;
}

// Hours and minutes, which is what a person deciding whether to swap a spool thinks in - and rounded
// UP, so that the queue is never said to be shorter than it is.
function asPrintingTime(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours === 0) return `${minutes}m`;
  if (minutes % 60 === 0) return `${hours}h`;

  return `${hours}h ${minutes % 60}m`;
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
