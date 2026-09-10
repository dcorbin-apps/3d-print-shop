import type { Job } from '@3d-print-shop/client/browser';

/** Every job the shop is holding that needs this filament, and what it is waiting for. */
export interface FilamentGroup {
  filament: string;
  jobs: Job[];
  queued: number;
  estimatedPrintSeconds?: number;
}

// AIDEV-NOTE: by the filament a job STARTS with, which is the shop's own rule - that is the one
// that has to be on the machine before it can begin, and a job naming more swaps the rest in as it
// runs. Grouping by anything else would be a second answer to "what do I load", disagreeing with
// the shop's.
export function byFilament(jobs: Job[]): FilamentGroup[] {
  const grouped = new Map<string, Job[]>();

  for (const job of jobs) {
    const filament = job.filaments[0];
    grouped.set(filament, [...(grouped.get(filament) ?? []), job]);
  }

  return [...grouped.entries()]
    .map(([filament, held]) => ({
      filament,
      jobs: [...held].sort((a, b) => a.id - b.id),
      queued: held.filter((job) => job.state === 'queued').length,
      estimatedPrintSeconds: workIn(held.filter((job) => job.state === 'queued')),
    }))
    .sort((a, b) => b.queued - a.queued || a.filament.localeCompare(b.filament));
}

// The same all-or-nothing rule the shop applies to `waitingOn`: a total summed over the jobs that
// said, where others did not, is quietly short - and a short number is worse to choose by than none.
function workIn(jobs: Job[]): number | undefined {
  if (jobs.length === 0 || jobs.some((job) => job.estimatedPrintSeconds === undefined)) return undefined;

  return jobs.reduce((total, job) => total + (job.estimatedPrintSeconds ?? 0), 0);
}

/** Hours and minutes, which is what a person deciding whether to swap a spool thinks in. */
export function asPrintingTime(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours === 0) return `${minutes}m`;
  if (minutes % 60 === 0) return `${hours}h`;

  return `${hours}h ${minutes % 60}m`;
}
