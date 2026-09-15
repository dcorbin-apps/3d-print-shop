import type { FilamentDemand } from '@3d-print-shop/client';
import type { Job } from './Job.js';
import { canTake } from './Printer.js';
import type { RegisteredPrinter } from './Printer.js';

// The wire contract, so the shop and everything that talks to it cannot drift apart.
export type { FilamentDemand } from '@3d-print-shop/client';

// AIDEV-NOTE: every printer here has ONE extruder, so what a job waits for is the filament it
// STARTS with. A job may name more - a single head sliced for several virtual extruders swaps the
// rest in as it runs - and they are carried, but nothing schedules on them.
//
// When there is a printer with more than one extruder this is where it starts to matter, because
// filaments are then positional: the index is the extruder the slicer assigned. Until then, keeping
// one rule is worth more than anticipating that one.
export function startsWith(job: Job): string {
  const [first] = job.filaments;

  // AIDEV-NOTE: a job that names no filament is refused at submission and a record is written once,
  // so this cannot be one the shop took in. Grouped under the empty name rather than thrown from:
  // this runs inside a sweep over EVERY job, where one unprintable record must not take the answer
  // away from all the others - and the empty name matches nothing loaded, so it cannot print by
  // accident either.
  return first ?? '';
}

// AIDEV-NOTE: derived on every ask, never stored. What can print depends on what is loaded RIGHT
// NOW, which changes while the shop is running - so an order decided when a job arrived would be
// stale before it was used. This is why nothing here writes anything.
export function printableNow(jobs: Job[], printer: RegisteredPrinter): Job[] {
  return (
    jobs
      .filter((job) => job.state === 'queued')
      // Somebody said to leave this one. It is queued in every other respect and stays where it is.
      .filter((job) => job.heldBack === undefined)
      .filter((job) => canTake(printer, job))
      .filter((job) => printer.loaded.includes(startsWith(job)))
      .sort((a, b) => a.id - b.id)
  );
}

/**
 * The one to print, or nothing if what is loaded cannot print anything. Submission order among
 * equals, because ids ARE submission order and nothing here knows enough to be cleverer.
 */
export function nextToPrint(jobs: Job[], printer: RegisteredPrinter): Job | undefined {
  return printableNow(jobs, printer)[0];
}

/**
 * Everything queued, grouped by the filament it waits for, busiest first. Answers "what should I
 * load next" - including for the filament already loaded, because the caller asking may be deciding
 * whether to swap at all.
 *
 * Named a printer, it answers for that machine rather than for the shop.
 */
export function waitingOn(jobs: Job[], printer?: RegisteredPrinter): FilamentDemand[] {
  const waiting = new Map<string, Job[]>();

  // AIDEV-NOTE: `canTake` and NOT what is loaded, which is the difference between this and
  // `printableNow`: what is loaded is the very thing being asked about. Without a printer this
  // counts the whole shop's queue, which is right for the one machine an operator has and wrong the
  // moment there are two - it would tell somebody at the mini to load a filament for a job only the
  // XL could take.
  for (const job of jobs.filter((queued) => queued.state === 'queued' && (printer === undefined || canTake(printer, queued)))) {
    waiting.set(startsWith(job), [...(waiting.get(startsWith(job)) ?? []), job]);
  }

  const demands = [...waiting.entries()].map(([filament, held]) => ({
    filament,
    jobs: held.length,
    estimatedPrintSeconds: workIn(held),
  }));

  // AIDEV-NOTE: by WORK when the shop knows all of it, and by COUNT when it does not - decided over
  // the whole answer rather than demand by demand. "Load red, it is six hours" is what an operator
  // wants, and four quick jobs should not outrank one long one; but neither should one job that
  // said how long it takes outrank six that did not, which is what ranking a mixed answer by work
  // would do. So a single filament nobody timed puts the whole answer back on counting.
  //
  // Alphabetical within a tie, so that the answer does not wander between asks.
  const byWork = demands.every((demand) => demand.estimatedPrintSeconds !== undefined);
  const work = (demand: FilamentDemand): number => (byWork ? (demand.estimatedPrintSeconds ?? 0) : 0);

  return demands.sort((a, b) => work(b) - work(a) || b.jobs - a.jobs || a.filament.localeCompare(b.filament));
}

// AIDEV-NOTE: nothing at all where any one of them said nothing, rather than a total over the ones
// that did. A partial total is quietly short, and an operator choosing what to load by a number
// that understates the queue is worse served than by the count they had before.
function workIn(jobs: Job[]): number | undefined {
  if (jobs.some((job) => job.estimatedPrintSeconds === undefined)) return undefined;

  return jobs.reduce((total, job) => total + (job.estimatedPrintSeconds ?? 0), 0);
}
