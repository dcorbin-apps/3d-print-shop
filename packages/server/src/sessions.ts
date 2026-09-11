import { digestOf, newToken } from './secrets.js';

/** The cookie a browser carries. Nothing else in this shop is named by anything a client sends. */
export const SESSION_COOKIE = 'print-shop-session';

// AIDEV-NOTE: two clocks, because they answer two different questions. IDLE is "has this person
// walked away from the machine" - a workshop screen somebody stopped looking at. ABSOLUTE is "has
// this been going on long enough that a stolen cookie is still working weeks later", which no
// amount of activity should excuse. A session that fails either is gone.
export const IDLE_MS = 12 * 60 * 60 * 1000;
export const LONGEST_MS = 7 * 24 * 60 * 60 * 1000;

interface Held {
  caller: string;
  began: number;
  lastSeen: number;
}

// AIDEV-NOTE: in memory, and so lost when the shop restarts - which logs everybody out and is the
// honest trade rather than an oversight. Sessions are the SHOP's: they expire, they are issued
// rather than configured, and they cannot live in callers.json, which is a file a person hand-edits
// and the shop re-reads on a signal. A file of their own would be a second thing to get the mode of
// right for a saving nobody asked for. See PLAN.md if a restart logging people out becomes a fault.
//
// Keyed by DIGEST, like everything else here: what is held is not what a browser presents, so a
// heap dump is not a set of working sessions.
export class Sessions {
  private readonly held = new Map<string, Held>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get size(): number {
    return this.held.size;
  }

  /**
   * Begin one for this caller, and answer with what their browser must present.
   *
   * A new secret every time and never a reused one: logging in again is a new session, so a cookie
   * taken from a machine somebody has since logged in on again is not the cookie in use.
   */
  begin(caller: string): string {
    this.forgetTheExpired();

    const secret = newToken();
    const at = this.now();
    this.held.set(digestOf(secret), { caller, began: at, lastSeen: at });

    return secret;
  }

  /** Whose session this is, or nobody - which is what an expired one is too. */
  whose(secret: string): string | undefined {
    const key = digestOf(secret);
    const held = this.held.get(key);
    if (held === undefined) return undefined;

    if (this.hasExpired(held)) {
      this.held.delete(key);
      return undefined;
    }

    held.lastSeen = this.now();

    return held.caller;
  }

  /** End it, which is what logging out IS - the cookie is cleared at the same time. */
  end(secret: string): void {
    this.held.delete(digestOf(secret));
  }

  /**
   * End every session this caller holds.
   *
   * What a changed password means: somebody either forgot theirs or believes somebody else has it,
   * and in both cases every browser already logged in as them is a browser that should not be.
   */
  endEveryOneOf(caller: string): void {
    for (const [key, held] of this.held) {
      if (held.caller === caller) this.held.delete(key);
    }
  }

  private hasExpired(held: Held): boolean {
    const at = this.now();

    return at - held.lastSeen > IDLE_MS || at - held.began > LONGEST_MS;
  }

  // Swept when one is begun rather than on a timer: nothing else here holds the event loop open,
  // and a session nobody asks about again costs a map entry until the next login.
  private forgetTheExpired(): void {
    for (const [key, held] of this.held) {
      if (this.hasExpired(held)) this.held.delete(key);
    }
  }
}
