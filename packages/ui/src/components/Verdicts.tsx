import { useState } from 'react';
import type { Verdict } from '@3d-print-shop/client/browser';

interface VerdictsProps {
  /** Which job is being judged - said out loud, because a screen may be offering this for several. */
  job: number;
  onVerdict: (verdict: Verdict) => Promise<void>;
}

// AIDEV-NOTE: what a person is choosing between is "print it again" and "do not", which is why the
// middle one does not say "reject" - the shop's word for it says what a person thinks of the print
// and hides what actually happens to the job. The consequence is on each button as its title, and
// each of them frees the bed, which is the whole reason a verdict is asked for at all.
const SAYING: { verdict: Verdict; says: string; means: string }[] = [
  { verdict: 'approved', says: 'Approve', means: 'The print is good - the job leaves the shop, gcode and all' },
  { verdict: 'rejected', says: 'Print again', means: 'Not usable - the job goes back to the queue, to print again from the same gcode' },
  { verdict: 'abandoned', says: 'Give up', means: 'Not usable, and not worth another - the job leaves the shop with nothing to show for it' },
];

// AIDEV-NOTE: the one thing that frees a bed, on the page somebody is already watching the print on.
// A printer holds its bed until a person has judged what came off it, and until this was here that
// person had to walk to a terminal - so a shop with nobody at a keyboard printed one thing per
// machine and stopped.
export function Verdicts({ job, onVerdict }: VerdictsProps): React.JSX.Element {
  const [saying, setSaying] = useState<Verdict | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  const say = async (verdict: Verdict): Promise<void> => {
    setSaying(verdict);
    setRefused(undefined);

    try {
      await onVerdict(verdict);
    } catch (failure) {
      // The shop's own words. This end knows only that a verdict was not taken; the shop knows
      // whether the job had already gone, or was never this caller's to judge.
      setRefused((failure as Error).message);
    } finally {
      setSaying(undefined);
    }
  };

  return (
    <div className="verdicts">
      {SAYING.map(({ verdict, says, means }) => (
        <button
          key={verdict}
          type="button"
          title={means}
          aria-label={`${says} job ${job}`}
          disabled={saying !== undefined}
          onClick={() => void say(verdict)}
        >
          {saying === verdict ? `${says}...` : says}
        </button>
      ))}

      {refused !== undefined && <p className="refused">{refused}</p>}
    </div>
  );
}
