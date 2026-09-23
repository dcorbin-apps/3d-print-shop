import { useState } from 'react';
import type { PrinterRecord } from '@3d-print-shop/client/browser';

export interface PrinterFormProps {
  /** A printer the shop already has: its name is shown rather than asked for, and a blank key keeps the one it has. */
  editing?: PrinterRecord;
  /** Where the form sits - a tile in the row, or nothing extra inside a dialog. */
  className?: string;
  submitLabel: string;
  submittingLabel: string;
  // AIDEV-NOTE: the key travels WITH the record rather than being a second thing the form does,
  // because half of this is a printer the shop cannot reach - and which half failed is not something
  // an operator should have to work out from two error messages. Undefined is "keep the key it has".
  onSubmit: (record: PrinterRecord, key: string | undefined) => Promise<void>;
  onClose: () => void;
}

interface Typed {
  name: string;
  x: string;
  y: string;
  z: string;
  address: string;
  key: string;
}

function typedFrom(printer: PrinterRecord | undefined): Typed {
  if (printer === undefined) return { name: '', x: '', y: '', z: '', address: '', key: '' };
  const { x, y, z } = printer.buildVolume;

  return { name: printer.name, x: String(x), y: String(y), z: String(z), address: printer.address, key: '' };
}

// It closes on success and stays open, with the shop's own words, on a refusal.
export function PrinterForm({ editing, className, submitLabel, submittingLabel, onSubmit, onClose }: PrinterFormProps): React.JSX.Element {
  const [typed, setTyped] = useState(() => typedFrom(editing));
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const said = (field: keyof Typed) => (typing: React.ChangeEvent<HTMLInputElement>) =>
    setTyped((was) => ({ ...was, [field]: typing.target.value }));

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setRefused(undefined);

    try {
      await onSubmit(
        {
          name: typed.name.trim(),
          buildVolume: { x: Number(typed.x), y: Number(typed.y), z: Number(typed.z) },
          api: editing?.api ?? 'octoprint',
          address: typed.address.trim(),
        },
        typed.key.trim() === '' ? undefined : typed.key.trim(),
      );
      onClose();
    } catch (failure) {
      // The shop's own words: it is the end that knows why - a name that becomes a directory, an
      // address it will not reach a printer at. This end knows only that something was refused.
      setRefused((failure as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={className === undefined ? 'printer-form' : `printer-form ${className}`}
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void submit();
      }}
    >
      {/* A printer's name is what everything else about it is filed under, so it is not changed here. */}
      {editing === undefined ? (
        <label>
          Name
          <input value={typed.name} onChange={said('name')} autoFocus />
        </label>
      ) : (
        <span className="printer-name">{editing.name}</span>
      )}

      <label>
        Build volume in mm
        <span className="volume">
          <input value={typed.x} onChange={said('x')} inputMode="numeric" aria-label="Width" placeholder="250" />
          <input value={typed.y} onChange={said('y')} inputMode="numeric" aria-label="Depth" placeholder="210" />
          <input value={typed.z} onChange={said('z')} inputMode="numeric" aria-label="Height" placeholder="220" />
        </span>
      </label>

      <label>
        Address
        <input value={typed.address} onChange={said('address')} placeholder="http://octopi.local" autoFocus={editing !== undefined} />
      </label>

      {/* AIDEV-NOTE: a password field so it is not left on a screen in a workshop, and there is no
          reading one back - the shop answers with the printer, never with the key. It is written
          where the shop keeps its keys and is in force at once; nothing has to be signalled. */}
      <label>
        API key
        <input
          type="password"
          value={typed.key}
          onChange={said('key')}
          autoComplete="off"
          placeholder={editing === undefined ? undefined : 'unchanged'}
        />
      </label>

      {refused !== undefined && <p className="refused">{refused}</p>}

      <span className="buttons">
        <button type="submit" disabled={submitting || !enough(typed, editing !== undefined)}>
          {submitting ? submittingLabel : submitLabel}
        </button>
        <button type="button" className="quiet" onClick={onClose}>
          Cancel
        </button>
      </span>
    </form>
  );
}

// Only what the form can know by itself: everything past this is the shop's to judge, and it says so
// better than this could - a name that becomes a directory, an address a printer cannot be at.
function enough({ name, x, y, z, address, key }: Typed, keyKept: boolean): boolean {
  const measured = (said: string): boolean => /^\d+$/.test(said.trim()) && Number(said) > 0;

  // The key among them for a new printer: one the shop has no key for is one it can only report as
  // out of reach, and adding a machine that cannot be printed on is not what anybody came here to do.
  // A printer being changed already has one, and a blank field keeps it.
  const keyed = keyKept || key.trim() !== '';

  return name.trim() !== '' && address.trim() !== '' && keyed && measured(x) && measured(y) && measured(z);
}
