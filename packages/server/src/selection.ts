import type { Job } from './Job.js';
import { canTake } from './Printer.js';
import type { RegisteredPrinter } from './Printer.js';

/**
 * What is waiting on one filament, and how much of it there is. What an operator needs in order to
 * answer "what should I load next".
 */
export interface FilamentDemand {
  filament: string;
  jobs: number;
}

// AIDEV-NOTE: every printer here has ONE extruder, so what a job waits for is the filament it
// STARTS with. A job may name more - a single head sliced for several virtual extruders swaps the
// rest in as it runs - and they are carried, but nothing schedules on them.
//
// When there is a printer with more than one extruder this is where it starts to matter, because
// filaments are then positional: the index is the extruder the slicer assigned. Until then, keeping
// one rule is worth more than anticipating that one.
export function startsWith(job: Job): string {
  return job.filaments[0];
}

// AIDEV-NOTE: derived on every ask, never stored. What can print depends on what is loaded RIGHT
// NOW, which changes while the shop is running - so an order decided when a job arrived would be
// stale before it was used. This is why nothing here writes anything.
export function printableNow(jobs: Job[], printer: RegisteredPrinter): Job[] {
  return jobs
    .filter((job) => job.state === 'queued')
    .filter((job) => canTake(printer, job))
    .filter((job) => printer.loaded.includes(startsWith(job)))
    .sort((a, b) => a.id - b.id);
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
 */
export function waitingOn(jobs: Job[]): FilamentDemand[] {
  const waiting = new Map<string, number>();

  for (const job of jobs.filter((queued) => queued.state === 'queued')) {
    waiting.set(startsWith(job), (waiting.get(startsWith(job)) ?? 0) + 1);
  }

  // AIDEV-NOTE: busiest by COUNT, which is the wrong measure - "load red, it is six hours of work"
  // is the answer an operator wants, and four quick jobs should not outrank one long one. A job
  // carries no duration today; gamebox has one on its plate and does not pass it.
  //
  // If that is added it must be an optional field of its own, NOT the `metadata` bag: metadata is
  // carried and never interpreted, and ranking by something inside it would break that rule for
  // every client at once.
  //
  // Alphabetical within a tie, so that the answer does not wander between asks.
  return [...waiting.entries()]
    .map(([filament, count]) => ({ filament, jobs: count }))
    .sort((a, b) => b.jobs - a.jobs || a.filament.localeCompare(b.filament));
}
