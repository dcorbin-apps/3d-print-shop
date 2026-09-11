import { useEffect, useRef, useState } from 'react';
import type { Caller } from '@3d-print-shop/client/browser';
import type { ShopSummary } from '../shopSummary.js';

interface TopBarProps {
  summary: ShopSummary;
  trouble?: string;
  /** Who is looking at this, so a shared screen says whose session it is showing. */
  caller?: Caller;
  onOut?: () => void;
}

export function TopBar({ summary, trouble, caller, onOut }: TopBarProps): React.JSX.Element {
  const { printers, printing, needingSomebody, queued, awaitingApproval } = summary;

  return (
    <header className="top-bar">
      <div className="banner">
        <span className="mark" aria-hidden="true">
          ⬢
        </span>
        <h1>3D Print Shop</h1>
      </div>

      <dl className="summary">
        <Count label={printers === 1 ? 'printer' : 'printers'} of={printers} />
        <Count label="printing" of={printing} />
        <Count label="needs somebody" of={needingSomebody} urgent={needingSomebody > 0} />
        <Count label="queued" of={queued} />
        <Count label="to judge" of={awaitingApproval} urgent={awaitingApproval > 0} />
      </dl>

      {caller !== undefined && <WhoIsLookingAtThis caller={caller} onOut={onOut} />}

      {/* The last good answer stays on the screen beneath this - see useShop. */}
      {trouble !== undefined && <p className="trouble">{trouble}</p>}
    </header>
  );
}

// AIDEV-NOTE: whose session this is, said out loud. A screen in a workshop is a screen anybody walks
// up to, and somebody who does not know who it is logged in as cannot know to log it out - which is
// how an admin's session ends up being everybody's.
//
// The name is the button and logging out is behind it, because a log out sitting in the banner is a
// thing to hit by accident on a shared screen - and what a person goes to the corner of a page
// looking for is their own name.
function WhoIsLookingAtThis({ caller, onOut }: { caller: Caller; onOut?: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const corner = useRef<HTMLDivElement>(null);

  // AIDEV-NOTE: the two ways out of an open menu that people expect and nothing else provides -
  // pressing escape, and clicking at anything else. Listened for on the document because the click
  // that closes it is by definition not on this.
  useEffect(() => {
    if (!open) return undefined;

    const elsewhere = (clicked: MouseEvent): void => {
      if (!(corner.current?.contains(clicked.target as Node) ?? false)) setOpen(false);
    };
    const escape = (pressed: KeyboardEvent): void => {
      if (pressed.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', elsewhere);
    document.addEventListener('keydown', escape);

    return () => {
      document.removeEventListener('mousedown', elsewhere);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="whoami" ref={corner}>
      <button type="button" className="who" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <span>{caller.name}</span>
        <span className="role">{caller.role}</span>
      </button>

      {open && onOut !== undefined && (
        <div className="who-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOut();
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function Count({ label, of, urgent = false }: { label: string; of: number; urgent?: boolean }): React.JSX.Element {
  return (
    <div className={urgent ? 'count urgent' : 'count'}>
      <dt>{label}</dt>
      <dd>{of}</dd>
    </div>
  );
}
