import { useState } from 'react';
import type { PrinterRecord, RegisteredPrinter } from '@3d-print-shop/client/browser';
import { AddPrinterTile } from './AddPrinterTile.js';
import { EditPrinterDialog } from './EditPrinterDialog.js';
import { LoadFilamentDialog } from './LoadFilamentDialog.js';
import { PrinterTile } from './PrinterTile.js';
import { StopPrinterDialog } from './StopPrinterDialog.js';
import { isActivelyPrinting, stateOf } from '../shopSummary.js';

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
  /** How what is on a machine is changed, when this caller may. Withheld on the same terms as onSave. */
  onLoad?: (name: string, filaments: string[]) => Promise<void>;
  /** How a machine is stopped taking work, with the reason an operator should know. Withheld on the same terms as onSave. */
  onStop?: (name: string, reason: string) => Promise<void>;
  // AIDEV-NOTE: the shop's `resume`, which lifts everything held against a machine at once - a
  // person's stop and the shop's own refusal alike. So it is offered as Start where somebody stopped
  // it and as Try again where a plate was refused, and the stop wins when it is both.
  /** How a stopped or refused machine is let take work again. Withheld on the same terms as onSave. */
  onStart?: (name: string) => Promise<void>;
  /** How a printer is taken out of the shop, offered from its Edit dialog. Withheld on the same terms as onSave. */
  onRemove?: (name: string) => Promise<void>;
  /** The filaments queued work is waiting for, suggested when somebody loads a machine. */
  waitingFor?: string[];
}

export function PrinterGallery({
  printers,
  selected,
  onSelect,
  onSave,
  onLoad,
  onStop,
  onStart,
  onRemove,
  waitingFor = [],
}: PrinterGalleryProps): React.JSX.Element {
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState<string | undefined>(undefined);
  const [stopping, setStopping] = useState<string | undefined>(undefined);
  const beingEdited = printers.find((printer) => printer.name === editing);
  const beingLoaded = printers.find((printer) => printer.name === loading);
  const beingStopped = printers.find((printer) => printer.name === stopping);
  const acts = onSave !== undefined || onLoad !== undefined || onStop !== undefined || onStart !== undefined;

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
      {printers.map((printer) => {
        const { condition } = stateOf(printer);

        return (
          // A tile is a button, and a button cannot hold another - so these sit beside it, in its corner.
          <div key={printer.name} className={acts ? 'printer-slot editable' : 'printer-slot'}>
            <PrinterTile printer={printer} selected={printer.name === selected} onSelect={onSelect} />
            {acts && (
              <span className="printer-actions">
                {onStart !== undefined && condition === 'stopped' && (
                  <Start name={printer.name} onStart={onStart} word="Start" saying={`Start ${printer.name}`} />
                )}
                {onStart !== undefined && condition === 'refused' && (
                  <Start name={printer.name} onStart={onStart} word="Try again" saying={`Try ${printer.name} again`} />
                )}
                {onStop !== undefined && condition !== 'stopped' && (
                  <button type="button" aria-label={`Stop ${printer.name}`} onClick={() => setStopping(printer.name)}>
                    Stop
                  </button>
                )}
                {onLoad !== undefined && (
                  // A spool is not changed under a print that is moving.
                  <button
                    type="button"
                    aria-label={`Load ${printer.name}`}
                    disabled={isActivelyPrinting(printer)}
                    onClick={() => setLoading(printer.name)}
                  >
                    Load
                  </button>
                )}
                {onSave !== undefined && (
                  <button type="button" aria-label={`Edit ${printer.name}`} onClick={() => setEditing(printer.name)}>
                    Edit
                  </button>
                )}
              </span>
            )}
          </div>
        );
      })}
      {onSave !== undefined && <AddPrinterTile onAdd={onSave} />}
      {onSave !== undefined && beingEdited !== undefined && (
        <EditPrinterDialog printer={beingEdited} onSave={onSave} onRemove={onRemove} onClose={() => setEditing(undefined)} />
      )}
      {onLoad !== undefined && beingLoaded !== undefined && (
        <LoadFilamentDialog printer={beingLoaded} waitingFor={waitingFor} onLoad={onLoad} onClose={() => setLoading(undefined)} />
      )}
      {onStop !== undefined && beingStopped !== undefined && (
        <StopPrinterDialog printer={beingStopped} onStop={onStop} onClose={() => setStopping(undefined)} />
      )}
    </section>
  );
}

interface StartProps {
  name: string;
  onStart: (name: string) => Promise<void>;
  word: string;
  saying: string;
}

function Start({ name, onStart, word, saying }: StartProps): React.JSX.Element {
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  const start = async (): Promise<void> => {
    setStarting(true);
    setRefused(undefined);

    try {
      await onStart(name);
    } catch (failure) {
      setRefused((failure as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <button type="button" aria-label={saying} disabled={starting} onClick={() => void start()}>
        {word}
      </button>
      {refused !== undefined && <span className="refused">{refused}</span>}
    </>
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
