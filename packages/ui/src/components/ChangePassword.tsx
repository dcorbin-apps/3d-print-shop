import { useState } from 'react';

interface ChangePasswordProps {
  onChange: (current: string, password: string) => Promise<void>;
  /** Put away, without changing anything. */
  onDone: () => void;
}

const NOTHING_TYPED = { current: '', password: '', again: '' };

// AIDEV-NOTE: the password they have now is asked for even though the shop already knows who this
// browser is - a session is a screen somebody walked away from, and a password nobody has to know to
// change is a password the next person to sit down owns. The shop asks for it too; this is the form
// that lets them give it.
//
// What is NOT checked here is what makes a password good enough. That rule is the shop's, it says so
// in its own words, and a copy of it in the browser is the copy that drifts. The one thing this
// knows by itself is whether the two new ones were typed the same, which the shop cannot see.
export function ChangePassword({ onChange, onDone }: ChangePasswordProps): React.JSX.Element {
  const [typed, setTyped] = useState(NOTHING_TYPED);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [changing, setChanging] = useState(false);
  const [done, setDone] = useState(false);

  const said = (field: keyof typeof typed) => (typing: React.ChangeEvent<HTMLInputElement>) =>
    setTyped((was) => ({ ...was, [field]: typing.target.value }));

  const change = async (): Promise<void> => {
    if (typed.password !== typed.again) {
      setRefused('The two new ones are not the same');

      return;
    }

    setChanging(true);
    setRefused(undefined);

    try {
      await onChange(typed.current, typed.password);
      setDone(true);
    } catch (failure) {
      setRefused((failure as Error).message);
    } finally {
      setChanging(false);
    }
  };

  // AIDEV-NOTE: said rather than simply closing, because nothing else on the page changes when this
  // works - and a form that vanishes is indistinguishable from one that did nothing.
  if (done) {
    return (
      <div className="change-password done">
        <p>Password changed. Every other browser it was logged in on has been logged out.</p>
        <button type="button" onClick={onDone}>
          close
        </button>
      </div>
    );
  }

  return (
    <form
      className="change-password"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void change();
      }}
    >
      <label>
        Current password
        <input type="password" value={typed.current} onChange={said('current')} autoComplete="current-password" autoFocus />
      </label>

      <label>
        New password
        <input type="password" value={typed.password} onChange={said('password')} autoComplete="new-password" />
      </label>

      <label>
        Repeat the new one
        <input type="password" value={typed.again} onChange={said('again')} autoComplete="new-password" />
      </label>

      {refused !== undefined && <p className="refused">{refused}</p>}

      <span className="buttons">
        <button type="submit" disabled={changing || !enough(typed)}>
          {changing ? 'changing...' : 'change'}
        </button>
        <button type="button" className="quiet" onClick={onDone}>
          cancel
        </button>
      </span>
    </form>
  );
}

// Only that something was typed in each. How long one has to be is the shop's rule to keep.
function enough({ current, password, again }: typeof NOTHING_TYPED): boolean {
  return current !== '' && password !== '' && again !== '';
}
