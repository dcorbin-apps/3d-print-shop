import { useState } from 'react';

interface AskForTokenProps {
  onGiven: (token: string) => void;
}

// AIDEV-NOTE: a token typed in and kept in this browser, because the shop has no notion of a
// session - `callers.json` is shaped for machine callers, one token per caller, and there is no
// login to have. This is the honest interim and not a design: when the shop can issue a session,
// this is the component that goes. See PLAN.md.
export function AskForToken({ onGiven }: AskForTokenProps): React.JSX.Element {
  const [typed, setTyped] = useState('');

  return (
    <form
      className="ask-for-token"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        if (typed.trim() !== '') onGiven(typed.trim());
      }}
    >
      <h1>3D Print Shop</h1>
      <p>Every route names its caller, so this needs the token the shop knows you by.</p>

      <label htmlFor="token">Token</label>
      <input id="token" type="password" value={typed} autoComplete="off" onChange={(typing) => setTyped(typing.target.value)} />

      <button type="submit" disabled={typed.trim() === ''}>
        Let me in
      </button>

      <p className="aside">
        It is kept in this browser and sent to the shop as <code>Authorization: Bearer</code>, the same as any other caller.
      </p>
    </form>
  );
}
