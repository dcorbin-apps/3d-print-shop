import { useEffect, useRef, useState } from 'react';
import type { Job } from '@3d-print-shop/client/browser';

/** What a person may do to a job from the list. Absent, the list only reports. */
export interface JobActions {
  onRename: (id: number, displayName: string) => Promise<void>;
  onHold: (id: number, held: boolean) => Promise<void>;
  onRemove: (id: number) => Promise<void>;
}

interface JobMenuProps {
  job: Job;
  actions: JobActions;
  /** Asked before anything a person cannot undo. Answers whether to go on. */
  confirm?: (question: string) => boolean;
}

// AIDEV-NOTE: a POPUP over the row rather than an opening of it. It floats, so a job being looked at
// moves nothing else on the page - a list that reflowed under somebody's cursor was the reason this
// stopped expanding the row. It still closes when attention goes elsewhere, which a popup should.
//
// What each act is offered FOR is decided here and refused again by the shop, which is the same
// manners the `+` on the printer row keeps: withholding a button a caller cannot use is politeness,
// and the shop refusing it is the guard. A pause is not offered on a print that has started because
// a pause cannot stop one - saying otherwise would have somebody believe they had stopped a print.
export function JobMenu({ job, actions, confirm = window.confirm.bind(window) }: JobMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(job.displayName);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const opened = useRef<HTMLDivElement | null>(null);

  const held = job.heldBack !== undefined;
  const queued = job.state === 'queued';
  const printing = job.state === 'printing';

  // AIDEV-NOTE: closed by attention moving on, which is what an opened row should do and what a
  // dismiss button was standing in for. `mousedown` rather than `click`, so that pressing a button
  // somewhere else on the page does both things at once rather than only closing this. A refusal
  // this is showing goes with it: it was about what was just attempted here.
  useEffect(() => {
    if (!open) return undefined;

    const closeIfElsewhere = (pressed: MouseEvent): void => {
      if (opened.current?.contains(pressed.target as Node) === false) setOpen(false);
    };

    document.addEventListener('mousedown', closeIfElsewhere);

    return () => document.removeEventListener('mousedown', closeIfElsewhere);
  }, [open]);

  // The shop's own words for a refusal. This end knows only that something was not done.
  const doing = async (what: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setRefused(undefined);

    try {
      await what();
      setOpen(false);
      setRenaming(false);
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

  // AIDEV-NOTE: the trigger and the popup share one wrapper, and the wrapper is what the outside-click
  // is measured against - so pressing the trigger to open is not immediately an outside press that
  // closes it again. The wrapper is what the popup is positioned from, too.
  return (
    <div className="job-menu" ref={opened}>
      <button
        type="button"
        className="job-menu-open"
        aria-label={`Menu for job ${job.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        …
      </button>

      {open && (
        <div className="job-menu-popup" role="menu" aria-label={`Job ${job.id}`}>
          {renaming ? (
            <form
              onSubmit={(sending) => {
                sending.preventDefault();
                void doing(() => actions.onRename(job.id, name));
              }}
            >
              <input aria-label={`A name for job ${job.id}`} value={name} onChange={(typing) => setName(typing.target.value)} autoFocus />
              <button type="submit" disabled={busy}>
                Rename
              </button>
            </form>
          ) : (
            <button type="button" disabled={busy} onClick={() => setRenaming(true)}>
              Rename
            </button>
          )}

          {queued && (
            <button
              type="button"
              disabled={busy}
              title={held ? 'Let this job be printed again when its filament is on' : 'Leave this job where it is until somebody says otherwise'}
              onClick={() => void doing(() => actions.onHold(job.id, !held))}
            >
              {held ? 'Resume' : 'Pause'}
            </button>
          )}

          <button type="button" className="remove" disabled={busy} onClick={remove}>
            {printing ? 'Cancel' : 'Delete'}
          </button>

          {refused !== undefined && <p className="refused">{refused}</p>}
        </div>
      )}
    </div>
  );
}
