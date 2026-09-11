import { useState } from 'react';
import type { PrinterRecord } from '@3d-print-shop/client/browser';

interface AddPrinterTileProps {
  // AIDEV-NOTE: the key travels WITH the record rather than being a second thing the form does,
  // because half of this is a printer the shop cannot reach - and which half failed is not something
  // an operator should have to work out from two error messages.
  onAdd: (record: PrinterRecord, key: string) => Promise<void>;
}

const NOTHING_TYPED = { name: '', x: '', y: '', z: '', address: '', key: '' };

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
      await onAdd(
        {
          name: typed.name.trim(),
          buildVolume: { x: Number(typed.x), y: Number(typed.y), z: Number(typed.z) },
          api: 'octoprint',
          address: typed.address.trim(),
        },
        typed.key.trim()
      );
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
        Name
        <input value={typed.name} onChange={said('name')} autoFocus />
      </label>

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
        <input value={typed.address} onChange={said('address')} placeholder="http://octopi.local" />
      </label>

      {/* AIDEV-NOTE: a password field so it is not left on a screen in a workshop, and there is no
          reading one back - the shop answers with the printer, never with the key. It is written
          where the shop keeps its keys and is in force at once; nothing has to be signalled. */}
      <label>
        API key
        <input type="password" value={typed.key} onChange={said('key')} autoComplete="off" />
      </label>

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
function enough({ name, x, y, z, address, key }: typeof NOTHING_TYPED): boolean {
  const measured = (said: string): boolean => /^\d+$/.test(said.trim()) && Number(said) > 0;

  // The key among them: a printer the shop has no key for is one it can only report as out of
  // reach, and adding a machine that cannot be printed on is not what anybody came here to do.
  return name.trim() !== '' && address.trim() !== '' && key.trim() !== '' && measured(x) && measured(y) && measured(z);
}
