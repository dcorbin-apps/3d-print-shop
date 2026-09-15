import { useRef, useState } from 'react';
import type { Job } from '@3d-print-shop/client/browser';

interface JobNameProps {
  job: Job;
  /** Absent, the name is shown and cannot be changed. */
  onRename?: (id: number, displayName: string) => Promise<void>;
}

// AIDEV-NOTE: renaming happens ON the name rather than in a menu beside it. A menu is for acts with
// consequences - pausing a queue, stopping a print - where changing a label is editing the thing you
// are looking at, and the place to do that is the thing itself.
//
// Enter and clicking away both COMMIT, because both are what a person does when they have finished
// typing; Escape abandons. That is the bargain every editable field in every application makes, and
// it is only safe because renaming is the one act here that costs nothing to get wrong - the shop
// will take the name back again just as readily.
export function JobName({ job, onRename }: JobNameProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(job.displayName);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  // AIDEV-NOTE: a ref and not state, because what it guards happens within one turn. Escape unmounts
  // the input, unmounting blurs it, and a blur is a commit - so without this, abandoning an edit
  // would save it. Enter commits and then unmounts too, which would otherwise commit twice.
  const settled = useRef(false);

  const start = (): void => {
    if (onRename === undefined) return;

    setName(job.displayName);
    setRefused(undefined);
    settled.current = false;
    setEditing(true);
  };

  const abandon = (): void => {
    settled.current = true;
    setEditing(false);
  };

  const keep = async (): Promise<void> => {
    if (settled.current || onRename === undefined) return;

    settled.current = true;
    setEditing(false);

    // Nothing typed, or nothing changed. Both are somebody deciding against it rather than asking
    // for an empty name, and neither is worth a request.
    const wanted = name.trim();
    if (wanted === '' || wanted === job.displayName) return;

    try {
      await onRename(job.id, wanted);
    } catch (failure) {
      setRefused((failure as Error).message);
    }
  };

  if (!editing) {
    return (
      <span className="name" title={onRename === undefined ? undefined : 'Double-click to rename'} onDoubleClick={start}>
        {job.displayName}
        {refused !== undefined && <span className="refused"> {refused}</span>}
      </span>
    );
  }

  return (
    <input
      className="name editing"
      aria-label={`A name for job ${job.id}`}
      value={name}
      autoFocus
      onChange={(typing) => setName(typing.target.value)}
      onBlur={() => void keep()}
      onKeyDown={(pressed) => {
        if (pressed.key === 'Enter') {
          pressed.preventDefault();
          void keep();
        }

        if (pressed.key === 'Escape') abandon();
      }}
    />
  );
}
