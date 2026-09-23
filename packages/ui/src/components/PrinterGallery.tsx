import { useState } from 'react';
import type { PrinterRecord, RegisteredPrinter } from '@3d-print-shop/client/browser';
import { AddPrinterTile } from './AddPrinterTile.js';
import { EditPrinterDialog } from './EditPrinterDialog.js';
import { PrinterTile } from './PrinterTile.js';

interface PrinterGalleryProps {
  printers: RegisteredPrinter[];
  selected?: string;
  onSelect: (name: string) => void;
  // AIDEV-NOTE: absent is what an ordinary caller gets, because adding or changing a printer is an
  // admin's. Withheld rather than offered-and-refused: a button that answers 403 teaches somebody they
  // are not trusted by letting them press it. The shop refuses either way - this is not the guard.
  // One callback for both because the shop has one act for both: a record under a name it already
  // has replaces what it knew, and keeps what is loaded, held and paused.
  /** How a printer is added or changed when this caller may - with a key, or none to keep the one it has. */
  onSave?: (record: PrinterRecord, key: string | undefined) => Promise<void>;
}

export function PrinterGallery({ printers, selected, onSelect, onSave }: PrinterGalleryProps): React.JSX.Element {
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const beingEdited = printers.find((printer) => printer.name === editing);

  // An empty shop is the one place the add tile matters most, so it is said beside it rather than
  // instead of it.
  if (printers.length === 0) {
    return (
      <section className="gallery empty" aria-label="printers">
        <p>No printers{onSave === undefined && '. `3d-print-shop printer add` is how one gets here.'}</p>
        {onSave !== undefined && <AddPrinterTile onAdd={onSave} />}
      </section>
    );
  }

  return (
    <section className="gallery" aria-label="printers">
      {printers.map((printer) => (
        // A tile is a button, and a button cannot hold another - so Edit sits beside it, in its corner.
        <div key={printer.name} className={onSave === undefined ? 'printer-slot' : 'printer-slot editable'}>
          <PrinterTile printer={printer} selected={printer.name === selected} onSelect={onSelect} />
          {onSave !== undefined && (
            <button type="button" className="edit-printer" aria-label={`Edit ${printer.name}`} onClick={() => setEditing(printer.name)}>
              Edit
            </button>
          )}
        </div>
      ))}
      {onSave !== undefined && <AddPrinterTile onAdd={onSave} />}
      {onSave !== undefined && beingEdited !== undefined && (
        <EditPrinterDialog printer={beingEdited} onSave={onSave} onClose={() => setEditing(undefined)} />
      )}
    </section>
  );
}

// AIDEV-NOTE: the one the operator was last looking at, kept across a reload because a wall display
// that forgot which machine it was showing every time it refreshed would be worse than useless. A
// name that is no longer here - the printer was removed while nobody was looking - falls back to
// the first rather than to nothing, so there is always something selected when there is anything.
export function stillHere(printers: RegisteredPrinter[], remembered: string | undefined): string | undefined {
  if (printers.length === 0) return undefined;
  if (remembered !== undefined && printers.some((printer) => printer.name === remembered)) return remembered;

  return printers[0]?.name;
}
