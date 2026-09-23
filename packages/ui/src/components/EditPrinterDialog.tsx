import { createPortal } from 'react-dom';
import type { PrinterRecord } from '@3d-print-shop/client/browser';
import { PrinterForm } from './PrinterForm.js';

interface EditPrinterDialogProps {
  printer: PrinterRecord;
  onSave: (record: PrinterRecord, key: string | undefined) => Promise<void>;
  onClose: () => void;
}

// AIDEV-NOTE: over the whole page and attached to the body, so the gallery's own scrolling and
// clipping cannot cut it off. Escape and Cancel close it; a click outside does not, because that is
// how somebody loses an API key they had half typed.
export function EditPrinterDialog({ printer, onSave, onClose }: EditPrinterDialogProps): React.JSX.Element {
  return createPortal(
    <div
      className="dialog-backdrop"
      onKeyDown={(pressed) => {
        if (pressed.key === 'Escape') onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Edit ${printer.name}`}>
        <PrinterForm editing={printer} submitLabel="Save" submittingLabel="Saving..." onSubmit={onSave} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
