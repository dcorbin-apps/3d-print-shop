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

      {/* AIDEV-NOTE: whose session this is, said out loud. A screen in a workshop is a screen
          anybody walks up to, and somebody who does not know who it is logged in as cannot know to
          log it out - which is how an admin's session ends up being everybody's. */}
      {caller !== undefined && (
        <div className="whoami">
          <span className="who">{caller.name}</span>
          <span className="role">{caller.role}</span>
          {onOut !== undefined && (
            <button type="button" className="log-out" onClick={onOut}>
              log out
            </button>
          )}
        </div>
      )}

      {/* The last good answer stays on the screen beneath this - see useShop. */}
      {trouble !== undefined && <p className="trouble">{trouble}</p>}
    </header>
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
