import { useState } from 'react';
import type { Job } from '@3d-print-shop/client/browser';

/** What a person may do to a job from the list. Absent, the list only reports. */
export interface JobActions {
  onRename: (id: number, displayName: string) => Promise<void>;
  onHold: (id: number, held: boolean) => Promise<void>;
  onRemove: (id: number) => Promise<void>;
}

interface JobControlsProps {
  job: Job;
  actions: JobActions;
  /** Asked before anything a person cannot undo. Answers whether to go on. */
  confirm?: (question: string) => boolean;
}

// AIDEV-NOTE: on the row itself, because there are two of them. A menu is worth its click when it is
// hiding a list; hiding two buttons behind one button is a click to reach a click. What each is FOR
// is said on hover - a word, the same word the button would have said - and its accessible name says
// the word and which job, because a screen is offering this for every job at once.
//
// The word is `data-says` and drawn by the stylesheet rather than `title`, because a browser puts a
// title UNDER THE POINTER - which on a mark this size is the pointer sitting on top of the only
// thing it came to read. Drawn above the button instead, and out of the way of the mouse.
//
// What is offered is decided here and refused again by the shop, which is the same manners the `+`
// on the printer row keeps. No pause on a print that has started: a pause keeps a job from STARTING,
// and saying otherwise would have somebody believe they had stopped a print they had not.
export function JobControls({ job, actions, confirm = window.confirm.bind(window) }: JobControlsProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  const held = job.heldBack !== undefined;
  const queued = job.state === 'queued';
  const printing = job.state === 'printing';

  // The shop's own words for a refusal. This end knows only that something was not done.
  const doing = async (what: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setRefused(undefined);

    try {
      await what();
    } catch (failure) {
      setRefused((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // AIDEV-NOTE: the confirmation is HERE and not in the shop, because what it is protecting is a
  // person's intent rather than the shop's rules. Deleting a queued job throws away gcode nobody can
  // get back; cancelling takes a print off a bed hours in. The shop would do either without asking,
  // which is right - it is not the shop's business to doubt a request it has authenticated.
  //
  // BOTH ask, including the queued one, and whether that second question earns its keep is being
  // found out by living with it rather than argued about. A queued delete is cheap to regret and
  // frequent, which is the shape of a prompt people learn to dismiss without reading - and a prompt
  // dismissed without reading is worse than none, because the cancel above relies on being read.
  const remove = (): void => {
    const question = printing
      ? `Stop printing ${job.displayName} on ${job.heldBy ?? 'the machine'}? The print is abandoned where it is, and the bed will need clearing.`
      : `Delete ${job.displayName}? Its gcode goes with it, and nothing can bring it back.`;

    if (confirm(question)) void doing(() => actions.onRemove(job.id));
  };

  return (
    <>
      <span className="job-controls">
        {queued && (
          <button
            type="button"
            data-says={held ? 'Resume' : 'Pause'}
            aria-label={`${held ? 'Resume' : 'Pause'} job ${job.id}`}
            disabled={busy}
            onClick={() => void doing(() => actions.onHold(job.id, !held))}
          >
            {held ? <ResumeMark /> : <PauseMark />}
          </button>
        )}

        <button
          type="button"
          className="remove"
          data-says={printing ? 'Cancel' : 'Delete'}
          aria-label={`${printing ? 'Cancel' : 'Delete'} job ${job.id}`}
          disabled={busy}
          onClick={remove}
        >
          {printing ? <StopMark /> : <DeleteMark />}
        </button>
      </span>

      {refused !== undefined && <p className="job-refused">{refused}</p>}
    </>
  );
}

// AIDEV-NOTE: drawn here rather than brought in, for the reason the cube in TopBar is: four shapes
// is not a dependency, and what a 16px mark reads as at a glance is worth owning.
function PauseMark(): React.JSX.Element {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="7" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
    </svg>
  );
}

function ResumeMark(): React.JSX.Element {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <polygon points="8,5 19,12 8,19" fill="currentColor" />
    </svg>
  );
}

// A lid and a can, which is what a bin is at this size - the tapering and the ribs are lost.
function DeleteMark(): React.JSX.Element {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4 7h16M10 4.5h4M9.5 11v6M14.5 11v6" />
      <path d="M6.5 7l1 12.5h9L17.5 7" strokeLinejoin="round" />
    </svg>
  );
}

// A square, because stopping is not throwing away: what it takes off the bed is still owed a verdict.
function StopMark(): React.JSX.Element {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}
