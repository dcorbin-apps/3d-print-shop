import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { PrinterRecord, RegisteredPrinter } from '@3d-print-shop/client/browser';
import { PrinterForm } from './PrinterForm.js';

interface EditPrinterDialogProps {
  printer: RegisteredPrinter;
  onSave: (record: PrinterRecord, key: string | undefined) => Promise<void>;
  /** Absent, the dialog offers no way to take the printer out of the shop. */
  onRemove?: (name: string) => Promise<void>;
  onClose: () => void;
  /** Asked before the printer is removed. Answers whether to go on. */
  confirm?: (question: string) => boolean;
}

// AIDEV-NOTE: over the whole page and attached to the body, so the gallery's own scrolling and
// clipping cannot cut it off. Escape and Cancel close it; a click outside does not, because that is
// how somebody loses an API key they had half typed.
//
// Removing lives here rather than on the tile: it is rare, it cannot be undone, and beside Load and
// Edit it would be one slip away from either.
export function EditPrinterDialog({
  printer,
  onSave,
  onRemove,
  onClose,
  confirm = window.confirm.bind(window),
}: EditPrinterDialogProps): React.JSX.Element {
  const [removing, setRemoving] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  const remove = async (taking: (name: string) => Promise<void>): Promise<void> => {
    if (!confirm(`Take ${printer.name} out of the shop? What the shop knows about it, its key included, goes with it.`)) return;

    setRemoving(true);
    setRefused(undefined);

    try {
      await taking(printer.name);
      onClose();
    } catch (failure) {
      setRefused((failure as Error).message);
    } finally {
      setRemoving(false);
    }
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onKeyDown={(pressed) => {
        if (pressed.key === 'Escape') onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Edit ${printer.name}`}>
        <PrinterForm editing={printer} submitLabel="Save" submittingLabel="Saving..." onSubmit={onSave} onClose={onClose} />

        {onRemove !== undefined && (
          <div className="remove-printer">
            {/* The shop will not take out a machine holding a job, so neither does the button. */}
            <button type="button" disabled={removing || printer.holding !== undefined} onClick={() => void remove(onRemove)}>
              Remove {printer.name}
            </button>
            {refused !== undefined && <p className="refused">{refused}</p>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
