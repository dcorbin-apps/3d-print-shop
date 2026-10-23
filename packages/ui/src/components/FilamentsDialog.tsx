import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface FilamentsDialogProps {
  /** Every filament the shop knows, asked for when the dialog opens and again after each removal. */
  known: () => Promise<string[]>;
  onForget: (name: string) => Promise<void>;
  onClose: () => void;
}

// AIDEV-NOTE: removing is all there is to do here. A filament becomes known by being loaded or asked
// for, so there is no adding - and the shop refuses to forget one in use, in words this shows as given.
export function FilamentsDialog({ known, onForget, onClose }: FilamentsDialogProps): React.JSX.Element {
  const [names, setNames] = useState<string[] | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<string | undefined>(undefined);

  const askAgain = useCallback((): void => {
    known().then(setNames, (failure: unknown) => setRefused((failure as Error).message));
  }, [known]);

  useEffect(askAgain, [askAgain]);

  const remove = async (name: string): Promise<void> => {
    setRemoving(name);
    setRefused(undefined);

    try {
      await onForget(name);
      askAgain();
    } catch (failure) {
      setRefused((failure as Error).message);
    } finally {
      setRemoving(undefined);
    }
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onKeyDown={(pressed) => {
        if (pressed.key === 'Escape') onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Filaments">
        <h2>Filaments</h2>

        {names?.length === 0 && <p className="nothing">The shop knows no filaments yet.</p>}

        <ul className="known-filaments">
          {names?.map((name) => (
            <li key={name}>
              <span>{name}</span>
              <button type="button" aria-label={`Remove ${name}`} disabled={removing !== undefined} onClick={() => void remove(name)}>
                {removing === name ? 'Removing...' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>

        {refused !== undefined && <p className="refused">{refused}</p>}

        <span className="buttons">
          <button type="button" className="quiet" onClick={onClose} autoFocus>
            Close
          </button>
        </span>
      </div>
    </div>,
    document.body,
  );
}
