import { useState } from 'react';

interface LogInProps {
  onIn: (id: string, password: string) => Promise<void>;
}

// AIDEV-NOTE: nothing is kept here and nothing is remembered. What logging in produces is a cookie
// the shop set, which this page cannot read and therefore cannot lose, leak or be tricked into
// sending somewhere else - which is the whole reason the shop stopped taking a token a page held.
export function LogIn({ onIn }: LogInProps): React.JSX.Element {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState(false);

  const logIn = async (): Promise<void> => {
    setAsking(true);
    setRefused(undefined);

    try {
      await onIn(id.trim(), password);
    } catch (failure) {
      // The shop's own words, which say the same thing for a name it does not know as for a
      // password that is wrong - so this cannot tell somebody which half they got right either.
      setRefused((failure as Error).message);
      setPassword('');
    } finally {
      setAsking(false);
    }
  };

  return (
    <form
      className="log-in"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void logIn();
      }}
    >
      <h1>3D Print Shop</h1>

      <label htmlFor="id">Who</label>
      <input id="id" value={id} autoComplete="username" onChange={(typing) => setId(typing.target.value)} autoFocus />

      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        value={password}
        autoComplete="current-password"
        onChange={(typing) => setPassword(typing.target.value)}
      />

      {refused !== undefined && <p className="refused">{refused}</p>}

      <button type="submit" disabled={asking || id.trim() === '' || password === ''}>
        {asking ? 'asking...' : 'Log in'}
      </button>
    </form>
  );
}
