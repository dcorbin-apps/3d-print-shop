import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { RegisteredPrinter } from '@3d-print-shop/client/browser';

interface LoadFilamentDialogProps {
  printer: RegisteredPrinter;
  /** The filaments queued work is waiting for, offered as the field is typed in. */
  waitingFor: string[];
  onLoad: (name: string, filaments: string[]) => Promise<void>;
  onClose: () => void;
}

// AIDEV-NOTE: the shop matches a job's filament to what is loaded by EXACT name, so "PLA-Red" on the
// machine prints nothing that asked for "PLA". The suggestions are what the queue is waiting for, so
// the name somebody picks is one that will start something.
export function LoadFilamentDialog({ printer, waitingFor, onLoad, onClose }: LoadFilamentDialogProps): React.JSX.Element {
  const [typed, setTyped] = useState(printer.loaded.join(', '));
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const suggestions = `waiting-for-${printer.name}`;

  const load = async (): Promise<void> => {
    setLoading(true);
    setRefused(undefined);

    try {
      await onLoad(printer.name, filamentsIn(typed));
      onClose();
    } catch (failure) {
      setRefused((failure as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onKeyDown={(pressed) => {
        if (pressed.key === 'Escape') onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Load ${printer.name}`}>
        <form
          className="printer-form"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            void load();
          }}
        >
          <span className="printer-name">{printer.name}</span>

          <label>
            Filament loaded
            <input value={typed} onChange={(typing) => setTyped(typing.target.value)} list={suggestions} placeholder="nothing" autoFocus />
          </label>
          <datalist id={suggestions}>
            {waitingFor.map((filament) => (
              <option key={filament} value={filament} />
            ))}
          </datalist>

          {refused !== undefined && <p className="refused">{refused}</p>}

          <span className="buttons">
            <button type="submit" disabled={loading}>
              {loading ? 'Loading...' : 'Load'}
            </button>
            <button type="button" className="quiet" onClick={onClose}>
              Cancel
            </button>
          </span>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// More than one is a head sliced for several virtual extruders, in order. Blank is nothing loaded.
export function filamentsIn(typed: string): string[] {
  return typed
    .split(',')
    .map((filament) => filament.trim())
    .filter((filament) => filament !== '');
}
