import type { PrinterRecord, RegisteredPrinter } from '@3d-print-shop/client/browser';
import { AddPrinterTile } from './AddPrinterTile.js';
import { PrinterTile } from './PrinterTile.js';

interface PrinterGalleryProps {
  printers: RegisteredPrinter[];
  selected?: string;
  onSelect: (name: string) => void;
  // AIDEV-NOTE: absent is what an ordinary caller gets, because adding a printer is an admin's.
  // Withheld rather than offered-and-refused: a button that answers 403 teaches somebody they are
  // not trusted by letting them press it. The shop refuses either way - this is not the guard.
  /** How a printer is added, with the key the shop will reach it by, when this caller may add one. */
  onAdd?: (record: PrinterRecord, key: string) => Promise<void>;
}

export function PrinterGallery({ printers, selected, onSelect, onAdd }: PrinterGalleryProps): React.JSX.Element {
  // An empty shop is the one place the add tile matters most, so it is said beside it rather than
  // instead of it.
  if (printers.length === 0) {
    return (
      <section className="gallery empty" aria-label="printers">
        <p>No printers{onAdd === undefined && '. `3d-print-shop printer add` is how one gets here.'}</p>
        {onAdd !== undefined && <AddPrinterTile onAdd={onAdd} />}
      </section>
    );
  }

  return (
    <section className="gallery" aria-label="printers">
      {printers.map((printer) => (
        <PrinterTile key={printer.name} printer={printer} selected={printer.name === selected} onSelect={onSelect} />
      ))}
      {onAdd !== undefined && <AddPrinterTile onAdd={onAdd} />}
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
