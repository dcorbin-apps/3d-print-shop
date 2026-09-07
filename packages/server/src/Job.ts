import type { Job, JobDetails } from '@3d-print-shop/client';

// AIDEV-NOTE: the wire contract lives in @3d-print-shop/client, so the shop and everything that
// talks to it cannot drift apart. What stays here is what only the shop needs: the record it
// writes, and what it refuses on the way in.
export type { BuildVolume, Job, JobDetails, JobPhase, JobState, PrinterOutcome } from '@3d-print-shop/client';

// AIDEV-NOTE: written once, at submission, and never written again - the job leaves the shop rather
// than being updated. Everything that CHANGES while a job is in the shop belongs to the printer
// holding it, because a printer is the only thing whose state actually moves. See
// design/3d-print-shop.md's "What changes, and what does not".
export type JobRecord = Omit<Job, 'state' | 'heldBy' | 'lastPrinterOutcome'>;

// AIDEV-NOTE: submission order, and only used when a client offers no name of its own. It is
// deliberately not derived from anything about the job: a name built from the filament or the file
// would read as though the queue understood the content, and it does not.
export function generatedDisplayName(ordinal: number): string {
  return `Job ${ordinal}`;
}

export class InvalidSubmission extends Error {}

// AIDEV-NOTE: checked before a byte is read, because everything downstream assumes it and because
// refusing early is refusing cheaply - a job that cannot be scheduled should not cost an upload
// first. That a job actually HAS gcode cannot be known here: the stream has not run yet, so
// emptiness is caught by the store once it has.
export function validateDetails(details: JobDetails): void {
  if (details.filaments.length === 0) {
    throw new InvalidSubmission('a job must say which filaments it needs');
  }

  if (details.filaments.some((filament) => filament.trim() === '')) {
    throw new InvalidSubmission('a job cannot need a filament with no name');
  }
}
