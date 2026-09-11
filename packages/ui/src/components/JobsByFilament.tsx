import type { Job, RegisteredPrinter, Verdict } from '@3d-print-shop/client/browser';
import { asPrintingTime, byFilament } from '../byFilament.js';
import { Verdicts } from './Verdicts.js';

interface JobsByFilamentProps {
  jobs: Job[];
  totalJobs: number;
  /** The machine the operator is looking at, so its filaments can be marked as already loaded. */
  selected?: RegisteredPrinter;
  /** What frees the bed. Absent, a finished print is reported here and judged somewhere else. */
  onVerdict?: (id: number, verdict: Verdict) => Promise<void>;
}

export function JobsByFilament({ jobs, totalJobs, selected, onVerdict }: JobsByFilamentProps): React.JSX.Element {
  const groups = byFilament(jobs);
  const others = totalJobs - jobs.length;

  return (
    <section className="jobs" aria-label="jobs by filament">
      {groups.length === 0 && <p className="nothing">Nothing outstanding.</p>}

      {groups.map((group) => (
        <article key={group.filament} className={selected?.loaded.includes(group.filament) ? 'filament loaded' : 'filament'}>
          <h2>
            {group.filament}
            {selected?.loaded.includes(group.filament) && <span className="on-machine">on {selected.name}</span>}
          </h2>

          <p className="waiting">
            {group.queued === 1 ? '1 queued' : `${group.queued} queued`}
            {group.estimatedPrintSeconds !== undefined && `, ${asPrintingTime(group.estimatedPrintSeconds)} of printing`}
          </p>

          <ul>
            {group.jobs.map((job) => (
              <li key={job.id} className={`job ${job.state}`}>
                <span className="id">{job.id}</span>
                <span className="name">{job.displayName}</span>
                <span className="state">{whereItIs(job)}</span>
                {job.state === 'awaiting-approval' && onVerdict !== undefined && (
                  <Verdicts job={job.id} onVerdict={(verdict) => onVerdict(job.id, verdict)} />
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}

      {/* What is not this caller's is a number and nothing else - the same thing `job list` says. */}
      {others > 0 && <p className="not-yours">and {others} more this shop is holding, which are not yours</p>}
    </section>
  );
}

function whereItIs(job: Job): string {
  if (job.state === 'queued') return 'queued';
  if (job.state === 'printing') return `printing on ${job.heldBy}`;

  return `${job.lastPrinterOutcome} on ${job.heldBy} - waiting for a verdict`;
}
