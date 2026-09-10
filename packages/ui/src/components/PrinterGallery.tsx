import type { RegisteredPrinter } from '@3d-print-shop/client/browser';
import { PrinterTile } from './PrinterTile.js';

interface PrinterGalleryProps {
  printers: RegisteredPrinter[];
  selected?: string;
  onSelect: (name: string) => void;
}

export function PrinterGallery({ printers, selected, onSelect }: PrinterGalleryProps): React.JSX.Element {
  if (printers.length === 0) {
    return (
      <section className="gallery empty">
        <p>No printers. `3d-print-shop printer add` is how one gets here.</p>
      </section>
    );
  }

  return (
    <section className="gallery" aria-label="printers">
      {printers.map((printer) => (
        <PrinterTile key={printer.name} printer={printer} selected={printer.name === selected} onSelect={onSelect} />
      ))}
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

  return printers[0].name;
}
