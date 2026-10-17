import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { RegisteredPrinter } from '@3d-print-shop/client/browser';

interface StopPrinterDialogProps {
  printer: RegisteredPrinter;
  onStop: (name: string, reason: string) => Promise<void>;
  onClose: () => void;
}

// AIDEV-NOTE: a reason is asked for because the shop refuses a stop without one - it is what the
// tile says to whoever comes to the machine next, and "stopped" alone tells them nothing to do.
export function StopPrinterDialog({ printer, onStop, onClose }: StopPrinterDialogProps): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [stopping, setStopping] = useState(false);

  const stop = async (): Promise<void> => {
    setStopping(true);
    setRefused(undefined);

    try {
      await onStop(printer.name, reason.trim());
      onClose();
    } catch (failure) {
      setRefused((failure as Error).message);
    } finally {
      setStopping(false);
    }
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onKeyDown={(pressed) => {
        if (pressed.key === 'Escape') onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Stop ${printer.name}`}>
        <form
          className="printer-form"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            void stop();
          }}
        >
          <span className="printer-name">{printer.name}</span>

          <label>
            Why it is stopping
            <input value={reason} onChange={(typing) => setReason(typing.target.value)} placeholder="clearing a jam" autoFocus />
          </label>

          {refused !== undefined && <p className="refused">{refused}</p>}

          <span className="buttons">
            <button type="submit" disabled={stopping || reason.trim() === ''}>
              {stopping ? 'Stopping...' : 'Stop'}
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
