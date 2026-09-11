// AIDEV-NOTE: what stands between a password and somebody with a list of them. scrypt already makes
// each guess cost the shop 50ms, which caps a single attacker at a few hundred guesses a minute -
// this is what turns that into a few, and what keeps those 50ms from being a way to flatten the
// shop by asking it to hash things all day.
//
// Counted against the ID and against where the request came FROM, and both have to allow it: one
// alone lets an attacker work through every name from one machine, or one name from a botnet.

/** How many may be got wrong before anybody is made to wait. A person mistypes their own password. */
export const FREELY = 3;

const FIRST_WAIT_MS = 1000;
const LONGEST_WAIT_MS = 5 * 60 * 1000;

// Forgotten after this, so that a person locked out by a bad afternoon is not locked out for ever
// and an operator does not have to restart a shop to let somebody in.
const FORGOTTEN_MS = 15 * 60 * 1000;

interface Wrong {
  times: number;
  last: number;
}

/** How long a caller must wait before another go, counted per name and per address. */
export class Attempts {
  private readonly wrong = new Map<string, Wrong>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * How much longer this must wait, in milliseconds - zero when it may go now.
   *
   * Answered rather than enforced, so that the caller decides what to do with it: a route says no
   * and says how long, where something else might choose to wait.
   */
  mustWait(...keys: string[]): number {
    return Math.max(0, ...keys.map((key) => this.waitOn(key)));
  }

  /** One that was wrong. The next wait doubles, and goes on doubling to a cap. */
  wasWrong(...keys: string[]): void {
    for (const key of keys) {
      const had = this.wrong.get(key);
      const times = had === undefined || this.now() - had.last > FORGOTTEN_MS ? 1 : had.times + 1;

      this.wrong.set(key, { times, last: this.now() });
    }
  }

  // AIDEV-NOTE: forgotten on the way IN rather than decremented, because the person who has just
  // proved who they are is not the attacker - and leaving their count standing would let somebody
  // else lock them out by getting their password wrong on purpose.
  /** One that was right. Whatever was counted against these is forgotten. */
  wasRight(...keys: string[]): void {
    for (const key of keys) this.wrong.delete(key);
  }

  private waitOn(key: string): number {
    const had = this.wrong.get(key);
    if (had === undefined || had.times <= FREELY) return 0;

    const since = this.now() - had.last;
    if (since > FORGOTTEN_MS) {
      this.wrong.delete(key);
      return 0;
    }

    return Math.max(0, Math.min(FIRST_WAIT_MS * 2 ** (had.times - FREELY - 1), LONGEST_WAIT_MS) - since);
  }
}
