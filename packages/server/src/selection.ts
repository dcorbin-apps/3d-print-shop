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
 *
 * Named a printer, it answers for that machine rather than for the shop.
 */
export function waitingOn(jobs: Job[], printer?: RegisteredPrinter): FilamentDemand[] {
  const waiting = new Map<string, number>();

  // AIDEV-NOTE: `canTake` and NOT what is loaded, which is the difference between this and
  // `printableNow`: what is loaded is the very thing being asked about. Without a printer this
  // counts the whole shop's queue, which is right for the one machine an operator has and wrong the
  // moment there are two - it would tell somebody at the mini to load a filament for a job only the
  // XL could take.
  for (const job of jobs.filter((queued) => queued.state === 'queued' && (printer === undefined || canTake(printer, queued)))) {
    waiting.set(startsWith(job), (waiting.get(startsWith(job)) ?? 0) + 1);
  }

  // AIDEV-NOTE: busiest by COUNT, which is the wrong measure - "load red, it is six hours of work"
  // is the answer an operator wants, and four quick jobs should not outrank one long one. A job
  // carries no duration today, so a client that knows one has no way to say it.
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
