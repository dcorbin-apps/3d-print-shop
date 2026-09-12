// AIDEV-NOTE: what stands between a password and somebody with a list of them, and nothing else.
// scrypt already makes each guess cost the shop 50ms, which caps a single attacker at a few hundred
// guesses a minute - this is what turns that into a few.
//
// Counted against the ID that was given, and against nothing else. It used to be counted against the
// ADDRESS as well, and that was the bug: the shop listens on loopback - which is where a token
// travelling in the clear belongs - so `from` is always 127.0.0.1 and one bucket was every caller's.
// Four wrong logins against an id that does not even exist put everybody else behind a five-minute
// wait while holding the right password.
//
// A gentler curve on that same key would have hidden it rather than fixed it, because an address
// that never varies cannot tell one caller from another however forgiving it is. And what the
// address count was really doing was bounding how much hashing the PROCESS would do, which is a
// question about a resource rather than about anybody's credential. That question is answered, but
// not here: `HASHES_AT_ONCE` in secrets.ts bounds how many passwords are hashed at once, because
// scrypt and the job store share a threadpool and the number comes from the pool. This file counts
// guesses against a name, and that is the whole of what it is for.

/** How many may be got wrong before somebody is made to wait. A person mistypes their own password. */
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

/** How long a caller must wait before another go at proving who they are, counted per id. */
export class Attempts {
  private readonly wrong = new Map<string, Wrong>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * How much longer this id must wait, in milliseconds - zero when it may go now.
   *
   * Answered rather than enforced, so that the caller decides what to do with it: a route says no
   * and says how long, where something else might choose to wait.
   */
  mustWait(id: string): number {
    const had = this.wrong.get(id);
    if (had === undefined || had.times <= FREELY) return 0;

    const since = this.now() - had.last;
    if (since > FORGOTTEN_MS) {
      this.wrong.delete(id);
      return 0;
    }

    return Math.max(0, Math.min(FIRST_WAIT_MS * 2 ** (had.times - FREELY - 1), LONGEST_WAIT_MS) - since);
  }

  /** One that was wrong. The next wait doubles, and goes on doubling to a cap. */
  wasWrong(id: string): void {
    const at = this.now();
    const had = this.wrong.get(id);

    this.wrong.set(id, { times: had === undefined || at - had.last > FORGOTTEN_MS ? 1 : had.times + 1, last: at });
    this.forgetTheExpired(at);
  }

  // AIDEV-NOTE: forgotten on the way IN rather than decremented, because the person who has just
  // proved who they are is not the attacker - and leaving their count standing would let somebody
  // else lock them out by getting their password wrong on purpose.
  /** One that was right. Whatever was counted against this id is forgotten. */
  wasRight(id: string): void {
    this.wrong.delete(id);
  }

  /** How many ids this is still counting against. Nothing reads it but a test. */
  get remembered(): number {
    return this.wrong.size;
  }

  // AIDEV-NOTE: swept on the way in, the way Sessions is. An entry is otherwise dropped only when
  // its OWN id is asked about again - and an id somebody invented is never asked about again, so
  // every one of them was kept for as long as the shop ran.
  private forgetTheExpired(at: number): void {
    for (const [id, had] of this.wrong) {
      if (at - had.last > FORGOTTEN_MS) this.wrong.delete(id);
    }
  }
}
