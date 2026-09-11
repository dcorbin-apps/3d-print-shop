import { useState } from 'react';
import type { PrinterRecord } from '@3d-print-shop/client/browser';

interface AddPrinterTileProps {
  onAdd: (record: PrinterRecord) => Promise<void>;
}

const NOTHING_TYPED = { name: '', x: '', y: '', z: '', address: '' };

// AIDEV-NOTE: a tile in the row rather than a dialog over it, because adding a machine is a thing
// that happens IN the row of machines - and the gallery is where an operator is already looking to
// see that it arrived. It closes on success and stays open, with the shop's own words, on a refusal.
export function AddPrinterTile({ onAdd }: AddPrinterTileProps): React.JSX.Element {
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState(NOTHING_TYPED);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  if (!typing) {
    return (
      <button type="button" className="printer-tile add" onClick={() => setTyping(true)} aria-label="add a printer">
        <span className="plus" aria-hidden="true">
          +
        </span>
        <span className="add-what">add a printer</span>
      </button>
    );
  }

  const said = (field: keyof typeof typed) => (typing_: React.ChangeEvent<HTMLInputElement>) =>
    setTyped((was) => ({ ...was, [field]: typing_.target.value }));

  const close = (): void => {
    setTyping(false);
    setTyped(NOTHING_TYPED);
    setRefused(undefined);
  };

  const add = async (): Promise<void> => {
    setAdding(true);
    setRefused(undefined);

    try {
      await onAdd({
        name: typed.name.trim(),
        buildVolume: { x: Number(typed.x), y: Number(typed.y), z: Number(typed.z) },
        api: 'octoprint',
        address: typed.address.trim(),
      });
      close();
    } catch (failure) {
      // The shop's own words: it is the end that knows why - a name that becomes a directory, an
      // address it will not reach a printer at. This end knows only that something was refused.
      setRefused((failure as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <form
      className="printer-tile adding"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void add();
      }}
    >
      <label>
        name
        <input value={typed.name} onChange={said('name')} autoFocus />
      </label>

      <label>
        build volume in mm
        <span className="volume">
          <input value={typed.x} onChange={said('x')} inputMode="numeric" aria-label="width" placeholder="250" />
          <input value={typed.y} onChange={said('y')} inputMode="numeric" aria-label="depth" placeholder="210" />
          <input value={typed.z} onChange={said('z')} inputMode="numeric" aria-label="height" placeholder="220" />
        </span>
      </label>

      <label>
        address
        <input value={typed.address} onChange={said('address')} placeholder="http://octopi.local" />
      </label>

      {/* AIDEV-NOTE: no key field, and there cannot be one - a printer's key is read from a file only
          the shop's own user can read, and a browser is the last place it should be typed. A printer
          added here is unreachable until somebody puts its key in printer-keys.json and signals. */}
      <p className="aside">Its API key goes in the shop&apos;s printer-keys.json, not here.</p>

      {refused !== undefined && <p className="refused">{refused}</p>}

      <span className="buttons">
        <button type="submit" disabled={adding || !enough(typed)}>
          {adding ? 'adding...' : 'add'}
        </button>
        <button type="button" className="quiet" onClick={close}>
          cancel
        </button>
      </span>
    </form>
  );
}

// Only what the form can know by itself: everything past this is the shop's to judge, and it says so
// better than this could - a name that becomes a directory, an address a printer cannot be at.
function enough({ name, x, y, z, address }: typeof NOTHING_TYPED): boolean {
  const measured = (said: string): boolean => /^\d+$/.test(said.trim()) && Number(said) > 0;

  return name.trim() !== '' && address.trim() !== '' && measured(x) && measured(y) && measured(z);
}
