import { useState } from 'react';
import type { Job, RegisteredPrinter, Verdict } from '@3d-print-shop/client/browser';
import { asPrintingTime, byFilament } from '../byFilament.js';
import { isActivelyPrinting } from '../shopSummary.js';
import type { FilamentGroup } from '../byFilament.js';
import { JobControls } from './JobControls.js';
import { JobName } from './JobName.js';
import { JobPicture } from './JobPicture.js';
import type { JobActions } from './JobControls.js';
import { Verdicts } from './Verdicts.js';

interface JobsByFilamentProps {
  jobs: Job[];
  totalJobs: number;
  /** The machine the operator is looking at, so its filaments can be marked as already loaded. */
  selected?: RegisteredPrinter;
  /** What frees the bed. Absent, a finished print is reported here and judged somewhere else. */
  onVerdict?: (id: number, verdict: Verdict) => Promise<void>;
  /** What a person may do to a job. Absent, the list reports and offers nothing. */
  actions?: JobActions;
  /** How a filament is put on the selected machine. Absent, a group only says whether it is there. */
  onLoad?: Loads;
}

type Loads = (printer: string, filaments: string[]) => Promise<void>;

export function JobsByFilament({ jobs, totalJobs, selected, onVerdict, actions, onLoad }: JobsByFilamentProps): React.JSX.Element {
  const groups = byFilament(jobs, selected?.loaded);
  const others = totalJobs - jobs.length;

  return (
    <section className="jobs" aria-label="jobs by filament">
      {groups.length === 0 && <p className="nothing">Nothing outstanding.</p>}

      {groups.map((group) => (
        <article key={group.filament} className={selected?.loaded.includes(group.filament) ? 'filament loaded' : 'filament'}>
          <h2>
            {group.filament}
            {selected?.loaded.includes(group.filament) && <span className="on-machine">on {selected.name}</span>}
            {selected !== undefined && onLoad !== undefined && worthLoading(group, selected) && (
              <LoadHere filament={group.filament} printer={selected} onLoad={onLoad} />
            )}
          </h2>

          <p className="waiting">
            {group.queued === 1 ? '1 queued' : `${group.queued} queued`}
            {group.estimatedPrintSeconds !== undefined && `, ${asPrintingTime(group.estimatedPrintSeconds)} of printing`}
          </p>

          <ul>
            {group.jobs.map((job) => (
              <li key={job.id} className={`job ${job.state}${job.heldBack === undefined ? '' : ' held'}`}>
                <JobPicture job={job} />
                <JobName job={job} onRename={actions?.onRename} />
                <span className="state">{whereItIs(job)}</span>
                {actions !== undefined && <JobControls job={job} actions={actions} />}
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

// Nothing is offered for a group with nothing queued: loading it would start nothing.
function worthLoading(group: FilamentGroup, printer: RegisteredPrinter): boolean {
  return group.queued > 0 && !printer.loaded.includes(group.filament);
}

// AIDEV-NOTE: it REPLACES what is on the machine rather than adding to it, because every printer here
// has one extruder - putting this spool on is taking the other one off.
function LoadHere({ filament, printer, onLoad }: { filament: string; printer: RegisteredPrinter; onLoad: Loads }): React.JSX.Element {
  const [loading, setLoading] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  const load = async (): Promise<void> => {
    setLoading(true);
    setRefused(undefined);

    try {
      await onLoad(printer.name, [filament]);
    } catch (failure) {
      setRefused((failure as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* A spool is not changed under a print that is moving. */}
      <button type="button" className="load-here" disabled={loading || isActivelyPrinting(printer)} onClick={() => void load()}>
        Load on {printer.name}
      </button>
      {refused !== undefined && <span className="refused">{refused}</span>}
    </>
  );
}

function whereItIs(job: Job): string {
  if (job.state === 'queued') return job.heldBack === undefined ? 'queued' : 'paused';
  if (job.state === 'printing') return `printing on ${job.heldBy}${howLongLeft(job.expectedDone)}`;

  return `${job.lastPrinterOutcome} on ${job.heldBy} - waiting for a verdict`;
}

// AIDEV-NOTE: counted from the page's clock on each poll rather than from the shop's, so it moves
// as the page is asked again. The same words as `job list` says it in jobAdmin.ts.
function howLongLeft(expectedDone: Date | undefined): string {
  if (expectedDone === undefined) return '';

  const seconds = (expectedDone.getTime() - Date.now()) / 1000;

  return seconds > 0 ? `, about ${asPrintingTime(seconds)} left` : ', past its estimate';
}
