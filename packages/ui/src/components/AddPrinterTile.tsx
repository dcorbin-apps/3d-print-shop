import { useState } from 'react';
import type { PrinterRecord } from '@3d-print-shop/client/browser';
import { PrinterForm } from './PrinterForm.js';

interface AddPrinterTileProps {
  onAdd: (record: PrinterRecord, key: string | undefined) => Promise<void>;
}

export function AddPrinterTile({ onAdd }: AddPrinterTileProps): React.JSX.Element {
  const [typing, setTyping] = useState(false);

  if (!typing) {
    return (
      <button type="button" className="printer-tile add" onClick={() => setTyping(true)} aria-label="Add a printer">
        <span className="plus" aria-hidden="true">
          +
        </span>
        <span className="add-what">Add a printer</span>
      </button>
    );
  }

  // AIDEV-NOTE: a tile in the row rather than a dialog over it, because adding a machine is a thing
  // that happens IN the row of machines - and the gallery is where an operator is already looking to
  // see that it arrived. Changing one is a dialog instead, so the machine stays in view while it is.
  return (
    <PrinterForm
      className="printer-tile adding"
      submitLabel="Add"
      submittingLabel="Adding..."
      onSubmit={onAdd}
      onClose={() => setTyping(false)}
    />
  );
}
