import { useState } from 'react';
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
function CameraView({ printer }: { printer: RegisteredPrinter }): React.JSX.Element {
  const [unreachable, setUnreachable] = useState(false);

  if (printer.camera === undefined || unreachable) {
    return (
      <div className="camera none">
        <span>{printer.camera === undefined ? 'no camera' : 'no picture'}</span>
      </div>
    );
  }

  return <img className="camera" src={printer.camera} alt={`${printer.name} now`} onError={() => setUnreachable(true)} />;
}
