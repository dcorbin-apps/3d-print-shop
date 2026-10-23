import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RegisteredPrinter } from '@3d-print-shop/client/browser';

interface LoadFilamentDialogProps {
  printer: RegisteredPrinter;
  /** Every filament the shop knows, asked for when the dialog opens. */
  known: () => Promise<string[]>;
  onLoad: (name: string, filaments: string[]) => Promise<void>;
  onClose: () => void;
}

// Values no filament can have: a name is trimmed and never blank, and none starts with a NUL.
const NOTHING = '';
const NEW = '\u0000new';

// AIDEV-NOTE: the shop matches a job's filament to what is loaded by EXACT name, so "PLA-Red" on the
// machine prints nothing that asked for "PLA". Picking from what the shop already knows is what keeps
// a second spelling from being loaded; a new name is the deliberate exception.
//
// ONE filament, though the shop takes a list: every printer here has one extruder. See PLAN.md on
// positional filaments for when that changes.
export function LoadFilamentDialog({ printer, known, onLoad, onClose }: LoadFilamentDialogProps): React.JSX.Element {
  const [names, setNames] = useState<string[]>([]);
  const [chosen, setChosen] = useState(printer.loaded[0] ?? NOTHING);
  const [named, setNamed] = useState('');
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    known().then(setNames, (failure: unknown) => setRefused((failure as Error).message));
  }, [known]);

  // What is on the machine is offered even before the shop has answered, so the choice starts there.
  const offered = [...new Set([...names, ...printer.loaded])];
  const filaments = chosen === NOTHING ? [] : [chosen === NEW ? named.trim() : chosen];

  const load = async (): Promise<void> => {
    setLoading(true);
    setRefused(undefined);

    try {
      await onLoad(printer.name, filaments);
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
            <select value={chosen} onChange={(choosing) => setChosen(choosing.target.value)} autoFocus>
              <option value={NOTHING}>&lt;Nothing&gt;</option>
              {offered.map((filament) => (
                <option key={filament} value={filament}>
                  {filament}
                </option>
              ))}
              <option value={NEW}>&lt;New Filament&gt;</option>
            </select>
          </label>

          {chosen === NEW && (
            <label>
              New filament name
              <input value={named} onChange={(typing) => setNamed(typing.target.value)} autoFocus />
            </label>
          )}

          {refused !== undefined && <p className="refused">{refused}</p>}

          <span className="buttons">
            <button type="submit" disabled={loading || filaments.includes('')}>
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
