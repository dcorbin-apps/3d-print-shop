import { useEffect, useState } from 'react';
import type { RegisteredPrinter } from '@3d-print-shop/client/browser';
import { stateOf } from '../shopSummary.js';

interface PrinterTileProps {
  printer: RegisteredPrinter;
  selected: boolean;
  onSelect: (name: string) => void;
}

export function PrinterTile({ printer, selected, onSelect }: PrinterTileProps): React.JSX.Element {
  const { condition, why } = stateOf(printer);

  return (
    <button
      type="button"
      className={selected ? 'printer-tile selected' : 'printer-tile'}
      aria-pressed={selected}
      onClick={() => onSelect(printer.name)}
    >
      <CameraView printer={printer} />

      <div className="tile-foot">
        <span className="printer-name">{printer.name}</span>
        <span className={`condition ${condition}`}>{condition.replace(/-/g, ' ')}</span>
      </div>

      {/* The reason a person gave, or the one the shop found - the thing that says what to do next. */}
      {why !== undefined && <p className="why">{why}</p>}

      <p className="loaded">{printer.loaded.length === 0 ? 'nothing loaded' : printer.loaded.join(', ')}</p>
    </button>
  );
}

// AIDEV-NOTE: an <img> on an MJPEG stream, which is how a browser watches one - it never finishes
// loading, so there is no `load` to wait for and no frame count to hold. The shop only says WHERE;
// whether this browser can reach the machine is between it and the printer, and a machine that is
// off answers nothing, so the error state is the ordinary one rather than a fault.
//
// AIDEV-NOTE: it TRIES AGAIN rather than giving up on the first error, which is what it used to do -
// and a stream has more ways of failing once than of being unavailable: a machine still booting, a
// connection dropped, a moment when something else had it. Latching on one of those left a tile
// saying "no picture" at a camera that was working, until somebody reloaded the page.
export const TRIES = 4;
export const BEFORE_TRYING_AGAIN_MS = 3000;

function CameraView({ printer }: { printer: RegisteredPrinter }): React.JSX.Element {
  // Two numbers rather than one: which attempt is on the screen, and how many have failed. They are
  // equal while one is being watched, and differ for as long as the next is being waited for.
  const [showing, setShowing] = useState(0);
  const [failed, setFailed] = useState(0);

  // A new camera is a new question - a printer moved to another address deserves its own tries.
  useEffect(() => {
    setShowing(0);
    setFailed(0);
  }, [printer.camera]);

  useEffect(() => {
    if (failed === showing || failed >= TRIES) return undefined;

    const again = setTimeout(() => setShowing(failed), BEFORE_TRYING_AGAIN_MS);

    return () => clearTimeout(again);
  }, [failed, showing]);

  if (printer.camera === undefined || failed >= TRIES) {
    return (
      <div className="camera none">
        <span>{printer.camera === undefined ? 'no camera' : 'no picture'}</span>
      </div>
    );
  }

  return (
    <img
      className="camera"
      src={showing === 0 ? printer.camera : askingAgain(printer.camera, showing)}
      alt={`${printer.name} now`}
      onError={() => setFailed(showing + 1)}
    />
  );
}

// AIDEV-NOTE: the same URL would not be fetched again - a browser that has just failed one has it
// cached as a failure - so each try carries a number that makes it a different one. Built through
// URL so that a camera whose address already has a query keeps it.
function askingAgain(camera: string, tried: number): string {
  const asking = new URL(camera);
  asking.searchParams.set('try', String(Math.floor(tried)));

  return asking.toString();
}
