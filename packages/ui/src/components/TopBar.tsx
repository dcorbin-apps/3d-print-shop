import type { ShopSummary } from '../shopSummary.js';

interface TopBarProps {
  summary: ShopSummary;
  trouble?: string;
}

export function TopBar({ summary, trouble }: TopBarProps): React.JSX.Element {
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
